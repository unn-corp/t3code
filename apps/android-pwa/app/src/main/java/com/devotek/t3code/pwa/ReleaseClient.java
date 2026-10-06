package com.devotek.t3code.pwa;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;
import org.json.JSONException;

/**
 * GitHub release discovery and download over HTTPS. Requests and every redirect hop must stay on
 * GitHub's release hosts, https to https only. The asset URL is built from the validated tag and
 * asset name, never taken from API response fields.
 */
final class ReleaseClient {
    static final String API = "https://api.github.com/repos/" + ReleaseManifest.REPOSITORY + "/releases?per_page=30";
    private static final String[] HOSTS = {
        "api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
        "github-releases.githubusercontent.com",
    };
    static final long MAX_APK_BYTES = 300L * 1024 * 1024;

    interface Progress { void bytes(long done, long total); }

    private final OkHttpClient client;

    ReleaseClient() {
        client = new OkHttpClient.Builder().followRedirects(true).followSslRedirects(false)
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS)
            .addNetworkInterceptor(chain -> {
                if (!allowed(chain.request().url())) throw new IOException("Blocked a non-GitHub update host");
                return chain.proceed(chain.request());
            }).build();
    }

    static boolean allowed(HttpUrl url) {
        if (!url.isHttps() || !url.username().isEmpty() || !url.password().isEmpty() || url.port() != 443) return false;
        String host = url.host().toLowerCase(Locale.ROOT);
        for (String allowedHost : HOSTS) if (allowedHost.equals(host)) return true;
        return false;
    }

    /** Null for a tag or asset that could not be a release of this repository. */
    static HttpUrl assetUrl(String tag, String asset) {
        if (!ReleaseRef.validTag(tag) || asset == null || !asset.matches("^[A-Za-z0-9][A-Za-z0-9._-]+$")) return null;
        return new HttpUrl.Builder().scheme("https").host("github.com").addPathSegments(ReleaseManifest.REPOSITORY)
            .addPathSegment("releases").addPathSegment("download").addPathSegment(tag).addPathSegment(asset).build();
    }

    List<ReleaseRef> list() throws IOException {
        Request request = new Request.Builder().url(API).header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28").build();
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) throw new IOException("GitHub returned " + response.code());
            ResponseBody body = response.body();
            if (body == null || body.contentLength() > 4 * 1024 * 1024) throw new IOException("Unexpected release list");
            return ReleaseRef.parseList(body.string());
        } catch (JSONException error) { throw new IOException("Unreadable release list", error); }
    }

    /** The manifest text; the caller records its digest. */
    String manifest(ReleaseRef release) throws IOException {
        HttpUrl url = assetUrl(release.tag, ReleaseManifest.ASSET_NAME);
        if (url == null) throw new IOException("Invalid release tag");
        try (Response response = client.newCall(new Request.Builder().url(url).build()).execute()) {
            if (!response.isSuccessful()) throw new IOException("Release manifest returned " + response.code());
            ResponseBody body = response.body();
            if (body == null) throw new IOException("Empty release manifest");
            BufferedSource source = body.source();
            source.request(ReleaseManifest.MAX_BYTES + 1);
            if (source.getBuffer().size() > ReleaseManifest.MAX_BYTES) throw new IOException("Release manifest is too large");
            return source.readUtf8();
        }
    }

    /** Streams exactly {@code expectedBytes} to {@code destination}; the caller verifies the digest. */
    void download(ReleaseRef release, String asset, long expectedBytes, File destination, Progress progress) throws IOException {
        HttpUrl url = assetUrl(release.tag, asset);
        if (url == null || expectedBytes <= 0 || expectedBytes > MAX_APK_BYTES) throw new IOException("Invalid update asset");
        try (Response response = client.newCall(new Request.Builder().url(url).build()).execute()) {
            if (!response.isSuccessful()) throw new IOException("Update download returned " + response.code());
            ResponseBody body = response.body();
            if (body == null) throw new IOException("Empty update download");
            long declared = body.contentLength();
            if (declared != -1 && declared != expectedBytes) throw new IOException("The update size differs from its release.");
            long total = 0;
            try (FileOutputStream output = new FileOutputStream(destination)) {
                BufferedSource source = body.source();
                byte[] buffer = new byte[64 * 1024]; int count;
                while ((count = source.read(buffer)) != -1) {
                    total += count;
                    if (total > expectedBytes) throw new IOException("The update is larger than its release.");
                    output.write(buffer, 0, count);
                    if (progress != null) progress.bytes(total, expectedBytes);
                }
                output.flush(); output.getFD().sync();
            }
            if (total != expectedBytes) throw new IOException("The update download was incomplete.");
        } catch (IOException | RuntimeException error) {
            destination.delete();
            throw error;
        }
    }

    static String manifestDigest(String text) {
        try { return ApkVerifier.hex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(java.nio.charset.StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
}
