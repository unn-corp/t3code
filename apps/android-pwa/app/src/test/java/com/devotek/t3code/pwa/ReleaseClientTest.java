package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import java.util.List;
import okhttp3.HttpUrl;
import org.junit.Test;

public final class ReleaseClientTest {
    @Test public void staysOnGitHubReleaseHostsOverHttps() {
        assertTrue(ReleaseClient.allowed(HttpUrl.get("https://github.com/unn-corp/t3code/releases/download/v1/app.apk")));
        assertTrue(ReleaseClient.allowed(HttpUrl.get("https://api.github.com/repos/unn-corp/t3code/releases")));
        assertTrue(ReleaseClient.allowed(HttpUrl.get("https://objects.githubusercontent.com/github-production-release-asset/abc")));
        assertTrue(ReleaseClient.allowed(HttpUrl.get("https://release-assets.githubusercontent.com/x")));
    }
    @Test public void refusesPlainHttpLookalikesCredentialsAndOddPorts() {
        for (String url : new String[]{"http://github.com/x", "https://github.com.evil.example/x", "https://evilgithub.com/x", "https://user:pw@github.com/x",
                "https://github.com:8443/x", "https://raw.githubusercontent.com/x", "https://example.com/x"})
            assertFalse(url, ReleaseClient.allowed(HttpUrl.get(url)));
    }
    @Test public void buildsAssetUrlsFromValidatedPartsOnly() {
        assertEquals("https://github.com/unn-corp/t3code/releases/download/v1.0.1-nightly.1/fork-release.json",
            ReleaseClient.assetUrl("v1.0.1-nightly.1", ReleaseManifest.ASSET_NAME).toString());
        assertNull(ReleaseClient.assetUrl("../v1", "a.apk"));
        assertNull(ReleaseClient.assetUrl("v1/evil", "a.apk"));
        assertNull(ReleaseClient.assetUrl("v1", "../a.apk"));
        assertNull(ReleaseClient.assetUrl("v1", "dir/a.apk"));
        assertNull(ReleaseClient.assetUrl("", "a.apk"));
        assertNull(ReleaseClient.assetUrl("v1", null));
    }
    @Test public void parsesReleaseListsNewestFirstAndSkipsUnusableRows() throws Exception {
        String json = "[{\"tag_name\":\"v1\",\"draft\":false,\"prerelease\":true,\"published_at\":\"2026-10-01T00:00:00Z\",\"assets\":[{\"name\":\"a.apk\",\"size\":5}]},"
            + "{\"tag_name\":\"v2\",\"draft\":false,\"prerelease\":false,\"published_at\":\"2026-10-03T00:00:00Z\",\"assets\":[]},"
            + "{\"tag_name\":\"bad/tag\",\"draft\":false,\"published_at\":\"2026-10-04T00:00:00Z\"},"
            + "{\"tag_name\":\"v0\",\"draft\":true,\"published_at\":null},"
            + "{\"tag_name\":\"v3\",\"published_at\":\"2026-10-02T00:00:00Z\"}]";
        List<ReleaseRef> releases = ReleaseRef.parseList(json);
        assertEquals(3, releases.size());
        assertEquals("v2", releases.get(0).tag);
        assertEquals("v3", releases.get(1).tag);
        assertTrue("a release that does not say it is published is treated as a draft", releases.get(1).draft);
        assertEquals(5, releases.get(2).asset("a.apk").size);
        assertTrue(releases.get(2).prerelease);
    }
    @Test public void releaseNotesMarkWithdrawalWithTheForkMarkerOnly() throws Exception {
        String marker = "<!-- t3-fork-release:withdrawn at=2026-10-05T00:00:00.000Z reason=bad signing -->";
        assertTrue(ReleaseRef.isWithdrawn(marker + "\nNotes"));
        assertTrue(ReleaseRef.isWithdrawn("Intro\n" + marker));
        assertFalse("an inline mention is not a withdrawal", ReleaseRef.isWithdrawn("see <!-- t3-fork-release:withdrawn --> inline"));
        assertFalse(ReleaseRef.isWithdrawn("Notes only"));
        assertFalse(ReleaseRef.isWithdrawn(null));
        String json = "[{\"tag_name\":\"v1\",\"draft\":false,\"prerelease\":true,\"published_at\":\"2026-10-01T00:00:00Z\",\"body\":\"" + marker + "\\nx\",\"assets\":[]},"
            + "{\"tag_name\":\"v2\",\"draft\":false,\"prerelease\":true,\"published_at\":\"2026-10-02T00:00:00Z\",\"body\":null,\"assets\":[]}]";
        List<ReleaseRef> releases = ReleaseRef.parseList(json);
        assertFalse(releases.get(0).withdrawn);
        assertTrue(releases.get(1).withdrawn);
    }
    @Test public void manifestDigestIsTheSha256OfTheText() {
        assertEquals(ApkVerifier.sha256("abc".getBytes(java.nio.charset.StandardCharsets.UTF_8)), ReleaseClient.manifestDigest("abc"));
    }
}
