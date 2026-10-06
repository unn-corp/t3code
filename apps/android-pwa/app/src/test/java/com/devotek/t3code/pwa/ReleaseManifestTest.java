package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public final class ReleaseManifestTest {
    private interface Edit { void apply(JSONObject json) throws Exception; }

    private static void rejects(String why, Edit edit) throws Exception {
        JSONObject json = Fixtures.manifestJson();
        edit.apply(json);
        try { ReleaseManifest.parse(json.toString()); fail("Accepted: " + why); }
        catch (ReleaseManifest.Invalid expected) { /* fail closed */ }
    }

    @Test public void parsesTheExactContractShape() throws Exception {
        ReleaseManifest manifest = Fixtures.manifest();
        assertEquals("nightly", manifest.channel);
        assertEquals(Fixtures.NORMAL_CODE, manifest.normal.versionCode);
        assertEquals(Fixtures.RECOVERY_CODE, manifest.recovery.versionCode);
        assertEquals("android-recovery", manifest.asset(Fixtures.RECOVERY_ASSET).kind);
        assertTrue(manifest.checksPassed());
    }
    @Test public void parsesOptionalRecoverySourcesAndSelectsExactSourceIdentity() throws Exception {
        JSONObject json = Fixtures.manifestJson();
        String olderAsset = "t3-code-android-recovery-older.apk";
        String olderDigest = "d".repeat(64);
        json.getJSONArray("assets").put(new JSONObject().put("name", olderAsset).put("sha256", olderDigest)
            .put("bytes", 3000).put("kind", "android-recovery").put("platform", "android"));
        json.getJSONObject("android").put("recoveries", new org.json.JSONArray()
            .put(Fixtures.artifact(Fixtures.RECOVERY_ASSET, Fixtures.RECOVERY_CODE, "1.0.0", Fixtures.PREVIOUS_COMMIT))
            .put(Fixtures.artifact(olderAsset, Fixtures.RECOVERY_CODE + 1, "0.9.0", Fixtures.COMMIT)));

        ReleaseManifest manifest = ReleaseManifest.parse(json.toString());
        assertEquals(2, manifest.recoveries.size());
        assertEquals(olderAsset, manifest.recoveryForSource("0.9.0", Fixtures.COMMIT).asset);
        assertEquals(Fixtures.RECOVERY_ASSET, manifest.recoveryForSource("1.0.0", Fixtures.PREVIOUS_COMMIT).asset);
        assertNull(manifest.recoveryForSource("0.9.0", Fixtures.PREVIOUS_COMMIT));
        assertTrue(manifest.hasRecoveryDigest(olderDigest));
    }
    @Test public void rejectsDuplicateOptionalRecoveryIdentity() throws Exception {
        JSONObject json = Fixtures.manifestJson();
        String olderAsset = "t3-code-android-recovery-duplicate.apk";
        json.getJSONArray("assets").put(new JSONObject().put("name", olderAsset).put("sha256", "d".repeat(64))
            .put("bytes", 3000).put("kind", "android-recovery").put("platform", "android"));
        json.getJSONObject("android").put("recoveries", new org.json.JSONArray()
            .put(Fixtures.artifact(Fixtures.RECOVERY_ASSET, Fixtures.RECOVERY_CODE, "1.0.0", Fixtures.PREVIOUS_COMMIT))
            .put(Fixtures.artifact(olderAsset, Fixtures.RECOVERY_CODE + 1, "1.0.0", Fixtures.PREVIOUS_COMMIT)));

        try { ReleaseManifest.parse(json.toString()); fail("Accepted a duplicate source identity"); }
        catch (ReleaseManifest.Invalid expected) { }
    }
    @Test public void rejectsOptionalRecoveryWithCodeNotAboveNormalOrWrongAssetKind() throws Exception {
        JSONObject code = Fixtures.manifestJson();
        code.getJSONObject("android").put("recoveries", new org.json.JSONArray()
            .put(Fixtures.artifact(Fixtures.RECOVERY_ASSET, Fixtures.RECOVERY_CODE, "1.0.0", Fixtures.PREVIOUS_COMMIT))
            .put(Fixtures.artifact("t3-code-android-1.0.1.apk", Fixtures.NORMAL_CODE + 1, "0.9.0", "3333333333333333333333333333333333333333")));
        try { ReleaseManifest.parse(code.toString()); fail("Accepted a recovery sharing the normal asset"); }
        catch (ReleaseManifest.Invalid expected) { }
    }
    @Test public void rejectsForeignRepositoriesPackagesAndFormats() throws Exception {
        rejects("other repository", json -> json.put("repository", "someone/else"));
        rejects("other format", json -> json.put("format", 2));
        rejects("other package", json -> json.getJSONObject("android").getJSONObject("normal").put("packageName", "com.example.app"));
        rejects("unsupported updater protocol", json -> json.getJSONObject("android").getJSONObject("recovery").put("updaterProtocol", 2));
    }
    @Test public void rejectsBadDigestsCommitsAndNames() throws Exception {
        rejects("uppercase digest", json -> json.getJSONArray("assets").getJSONObject(0).put("sha256", "B".repeat(64)));
        rejects("short digest", json -> json.getJSONArray("assets").getJSONObject(0).put("sha256", "b".repeat(63)));
        rejects("short commit", json -> json.put("commit", "abc123"));
        rejects("path in asset name", json -> json.getJSONArray("assets").getJSONObject(0).put("name", "../evil.apk"));
        rejects("unknown asset kind", json -> json.getJSONArray("assets").getJSONObject(0).put("kind", "firmware"));
        rejects("signer is not a digest", json -> json.getJSONObject("android").getJSONObject("normal").put("signerSha256", "eb38"));
    }
    @Test public void doesNotCoerceTypesTheContractForbids() throws Exception {
        rejects("string version code", json -> json.getJSONObject("android").getJSONObject("normal").put("versionCode", "29853700"));
        rejects("fractional version code", json -> json.getJSONObject("android").getJSONObject("normal").put("versionCode", 1.5));
        rejects("zero size", json -> json.getJSONArray("assets").getJSONObject(0).put("bytes", 0));
        rejects("check as string", json -> json.getJSONObject("checks").put("update", "true"));
        rejects("numeric version", json -> json.put("version", 101));
        rejects("code beyond Android's range", json -> json.getJSONObject("android").getJSONObject("normal").put("versionCode", 3_000_000_000L));
    }
    @Test public void rejectsMissingSectionsUnknownChannelsAndBadTimes() throws Exception {
        rejects("no checks", json -> json.remove("checks"));
        rejects("no recovery", json -> json.getJSONObject("android").remove("recovery"));
        rejects("unknown channel", json -> json.put("channel", "beta"));
        rejects("bad time", json -> json.put("releasedAt", "tomorrow"));
    }
    @Test public void refusesDuplicateAssetsRatherThanSelectingTheFirst() throws Exception {
        rejects("duplicate asset", json -> json.getJSONArray("assets").put(json.getJSONArray("assets").getJSONObject(0)));
    }
    @Test public void rejectsGarbage() {
        for (String text : new String[]{"", "[]", "{", "null"}) {
            try { ReleaseManifest.parse(text); fail("Accepted " + text); } catch (ReleaseManifest.Invalid expected) { }
        }
    }
}
