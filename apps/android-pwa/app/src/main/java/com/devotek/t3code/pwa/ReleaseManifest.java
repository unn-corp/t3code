package com.devotek.t3code.pwa;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The fork release JSON, mirroring packages/contracts/src/forkRelease.ts exactly. Parsing is strict:
 * a missing field, wrong type, bad digest, or a package or repository other than ours is rejected
 * so a malformed release can never become an eligible update.
 */
final class ReleaseManifest {
    static final String REPOSITORY = "unn-corp/t3code";
    static final String PACKAGE = "com.devotek.t3code.pwa";
    /** Release asset that carries this JSON. Both the release workflow and this client use it. */
    static final String ASSET_NAME = BuildConfig.FORK_RELEASE_MANIFEST_ASSET;
    static final int UPDATER_PROTOCOL = 1;
    static final long MAX_BYTES = 256 * 1024;

    static final class Invalid extends Exception { Invalid(String message) { super(message); } }

    static final class Asset {
        final String name, sha256, kind, platform;
        final long bytes;
        Asset(String name, String sha256, long bytes, String kind, String platform) {
            this.name = name; this.sha256 = sha256; this.bytes = bytes; this.kind = kind; this.platform = platform;
        }
    }

    static final class Artifact {
        final String asset, sourceVersion, sourceCommit, packageName, signerSha256;
        final long versionCode;
        final int updaterProtocol;
        Artifact(String asset, long versionCode, String sourceVersion, String sourceCommit, String packageName,
                String signerSha256, int updaterProtocol) {
            this.asset = asset; this.versionCode = versionCode; this.sourceVersion = sourceVersion;
            this.sourceCommit = sourceCommit; this.packageName = packageName; this.signerSha256 = signerSha256;
            this.updaterProtocol = updaterProtocol;
        }
    }

    final String version, commit, channel, releasedAt;
    final List<Asset> assets;
    final Artifact normal, recovery;
    final boolean build, install, update, recoveryCheck;

    private ReleaseManifest(String version, String commit, String channel, String releasedAt, List<Asset> assets,
            Artifact normal, Artifact recovery, boolean build, boolean install, boolean update, boolean recoveryCheck) {
        this.version = version; this.commit = commit; this.channel = channel; this.releasedAt = releasedAt;
        this.assets = Collections.unmodifiableList(assets); this.normal = normal; this.recovery = recovery;
        this.build = build; this.install = install; this.update = update; this.recoveryCheck = recoveryCheck;
    }

    Asset asset(String name) {
        for (Asset asset : assets) if (asset.name.equals(name)) return asset;
        return null;
    }
    boolean checksPassed() { return build && install && update && recoveryCheck; }

    static ReleaseManifest parse(String json) throws Invalid {
        try {
            JSONObject root = new JSONObject(json);
            if (integer(root, "format") != 1) throw new Invalid("Unsupported release format");
            if (!REPOSITORY.equals(string(root, "repository"))) throw new Invalid("Release belongs to another repository");
            String channel = string(root, "channel");
            if (!"stable".equals(channel) && !"nightly".equals(channel)) throw new Invalid("Unknown release channel");
            String releasedAt = string(root, "releasedAt");
            try { Iso8601.parse(releasedAt); } catch (IllegalArgumentException error) { throw new Invalid("Invalid release time"); }
            JSONArray rawAssets = array(root, "assets");
            List<Asset> assets = new ArrayList<>();
            java.util.Set<String> names = new java.util.HashSet<>();
            for (int i = 0; i < rawAssets.length(); i++) {
                JSONObject item = object(rawAssets, i);
                String name = string(item, "name");
                if (!name.matches("^[A-Za-z0-9][A-Za-z0-9._-]+$")) throw new Invalid("Invalid asset name");
                if (!names.add(name)) throw new Invalid("Duplicate release asset");
                String kind = string(item, "kind"), platform = string(item, "platform");
                if (!oneOf(kind, "desktop", "server", "android", "android-recovery", "recovery-helper", "feed", "blockmap")
                    || !oneOf(platform, "windows-x64", "linux-x64", "android", "shared")) throw new Invalid("Invalid asset kind");
                long bytes = number(item, "bytes");
                if (bytes <= 0) throw new Invalid("Invalid asset size");
                assets.add(new Asset(name, hex(item, "sha256", 64), bytes, kind, platform));
            }
            JSONObject android = object(root, "android");
            JSONObject checks = object(root, "checks");
            return new ReleaseManifest(string(root, "version"), hex(root, "commit", 40), channel, releasedAt, assets,
                artifact(object(android, "normal")), artifact(object(android, "recovery")),
                bool(checks, "build"), bool(checks, "install"), bool(checks, "update"), bool(checks, "recovery"));
        } catch (JSONException error) { throw new Invalid("Malformed release manifest"); }
    }

    private static Artifact artifact(JSONObject item) throws Invalid, JSONException {
        long code = number(item, "versionCode");
        if (code <= 0 || code > Integer.MAX_VALUE) throw new Invalid("Invalid version code");
        if (!PACKAGE.equals(string(item, "packageName"))) throw new Invalid("Release targets another package");
        int protocol = integer(item, "updaterProtocol");
        if (protocol != UPDATER_PROTOCOL) throw new Invalid("Unsupported updater protocol");
        return new Artifact(string(item, "asset"), code, string(item, "sourceVersion"), hex(item, "sourceCommit", 40),
            PACKAGE, hex(item, "signerSha256", 64), protocol);
    }
    private static boolean oneOf(String value, String... options) {
        for (String option : options) if (option.equals(value)) return true;
        return false;
    }
    // org.json coerces numbers to strings and strings to numbers; the contract does not.
    private static String string(JSONObject object, String key) throws Invalid, JSONException {
        Object value = object.get(key);
        if (!(value instanceof String text) || text.isEmpty() || text.length() > 512) throw new Invalid("Invalid " + key);
        return text;
    }
    private static String hex(JSONObject object, String key, int length) throws Invalid, JSONException {
        String text = string(object, key);
        if (!text.matches("^[a-f0-9]{" + length + "}$")) throw new Invalid("Invalid " + key);
        return text;
    }
    private static long number(JSONObject object, String key) throws Invalid, JSONException {
        Object value = object.get(key);
        if (!(value instanceof Integer) && !(value instanceof Long)) throw new Invalid("Invalid " + key);
        return ((Number) value).longValue();
    }
    private static int integer(JSONObject object, String key) throws Invalid, JSONException {
        long value = number(object, key);
        if (value > Integer.MAX_VALUE || value < Integer.MIN_VALUE) throw new Invalid("Invalid " + key);
        return (int) value;
    }
    private static boolean bool(JSONObject object, String key) throws Invalid, JSONException {
        Object value = object.get(key);
        if (!(value instanceof Boolean flag)) throw new Invalid("Invalid " + key);
        return flag;
    }
    private static JSONObject object(JSONObject object, String key) throws Invalid, JSONException {
        Object value = object.get(key);
        if (!(value instanceof JSONObject nested)) throw new Invalid("Invalid " + key);
        return nested;
    }
    private static JSONObject object(JSONArray array, int index) throws Invalid, JSONException {
        Object value = array.get(index);
        if (!(value instanceof JSONObject nested)) throw new Invalid("Invalid asset");
        return nested;
    }
    private static JSONArray array(JSONObject object, String key) throws Invalid, JSONException {
        Object value = object.get(key);
        if (!(value instanceof JSONArray nested) || nested.length() > 64) throw new Invalid("Invalid " + key);
        return nested;
    }
}
