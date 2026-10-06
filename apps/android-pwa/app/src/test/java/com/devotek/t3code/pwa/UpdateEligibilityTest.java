package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public final class UpdateEligibilityTest {
    private interface Edit { void apply(JSONObject json) throws Exception; }

    private static UpdateEligibility.Reason evaluate(String channel, boolean draft, boolean prerelease, boolean pinned, Edit edit) throws Exception {
        JSONObject json = Fixtures.manifestJson();
        if (edit != null) edit.apply(json);
        return UpdateEligibility.evaluate(Fixtures.installed(), Fixtures.release(draft, prerelease), ReleaseManifest.parse(json.toString()),
            channel, pinned, Fixtures.NOW).reason;
    }
    private static UpdateEligibility.Reason nightly(Edit edit) throws Exception { return evaluate("nightly", false, true, false, edit); }

    @Test public void acceptsACompleteNewerNightlyOnTheNightlyChannel() throws Exception {
        assertEquals(UpdateEligibility.Reason.ELIGIBLE, nightly(null));
    }
    @Test public void draftsNeverQualify() throws Exception {
        assertEquals(UpdateEligibility.Reason.DRAFT, evaluate("nightly", true, true, false, null));
    }
    @Test public void withdrawnReleasesNeverQualifyEvenWithValidAssets() throws Exception {
        ReleaseRef withdrawn = new ReleaseRef("v1.0.1-nightly.1", false, true, true, Fixtures.NOW - 3_600_000L, Fixtures.release(false, true).assets);
        assertEquals(UpdateEligibility.Reason.WITHDRAWN, UpdateEligibility.evaluate(Fixtures.installed(), withdrawn, Fixtures.manifest(), "nightly", false, Fixtures.NOW).reason);
    }
    @Test public void stableDevicesOnlyTakeStableReleases() throws Exception {
        assertEquals(UpdateEligibility.Reason.CHANNEL, evaluate("stable", false, true, false, null));
        assertEquals(UpdateEligibility.Reason.ELIGIBLE, evaluate("stable", false, false, false, json -> json.put("channel", "stable")));
    }
    @Test public void nightlyDevicesAlsoTakeStableReleases() throws Exception {
        assertEquals(UpdateEligibility.Reason.ELIGIBLE, evaluate("nightly", false, false, false, json -> json.put("channel", "stable")));
    }
    @Test public void aMislabeledReleaseNeverReachesStableDevices() throws Exception {
        // Manifest claims stable but GitHub says prerelease, or the reverse.
        assertEquals(UpdateEligibility.Reason.CHANNEL, evaluate("stable", false, true, false, json -> json.put("channel", "stable")));
        assertEquals(UpdateEligibility.Reason.CHANNEL, evaluate("nightly", false, false, false, null));
    }
    @Test public void releasesWhoseChecksDidNotAllPassAreIneligible() throws Exception {
        for (String check : new String[]{"build", "install", "update", "recovery"})
            assertEquals(check, UpdateEligibility.Reason.CHECKS_FAILED, nightly(json -> json.getJSONObject("checks").put(check, false)));
    }
    @Test public void signerAndPackageMustMatchTheInstalledApp() throws Exception {
        assertEquals(UpdateEligibility.Reason.SIGNER, nightly(json -> json.getJSONObject("android").getJSONObject("normal").put("signerSha256", "d".repeat(64))));
        assertEquals(UpdateEligibility.Reason.SIGNER, nightly(json -> json.getJSONObject("android").getJSONObject("recovery").put("signerSha256", "d".repeat(64))));
    }
    @Test public void recoveryIsNeverSelectedAsTheNormalUpdate() throws Exception {
        assertEquals(UpdateEligibility.Reason.ASSET_KIND, nightly(json -> json.getJSONObject("android").getJSONObject("normal").put("asset", Fixtures.RECOVERY_ASSET)
            .put("versionCode", Fixtures.NORMAL_CODE)));
        assertEquals(UpdateEligibility.Reason.ASSET_KIND, nightly(json -> json.getJSONArray("assets").getJSONObject(0).put("kind", "android-recovery")));
    }
    @Test public void recoveryMustOutrankNormalOrAndroidWouldRefuseTheRollback() throws Exception {
        assertEquals(UpdateEligibility.Reason.RECOVERY_INVALID, nightly(json -> json.getJSONObject("android").getJSONObject("recovery").put("versionCode", Fixtures.NORMAL_CODE)));
        assertEquals(UpdateEligibility.Reason.RECOVERY_INVALID, nightly(json -> json.getJSONObject("android").getJSONObject("recovery").put("versionCode", Fixtures.NORMAL_CODE - 5)));
    }
    @Test public void publishedAssetsMustMatchTheManifestSizes() throws Exception {
        JSONObject json = Fixtures.manifestJson();
        json.getJSONArray("assets").getJSONObject(0).put("bytes", 999);
        assertEquals(UpdateEligibility.Reason.ASSET_MISSING, UpdateEligibility.evaluate(Fixtures.installed(), Fixtures.release(false, true),
            ReleaseManifest.parse(json.toString()), "nightly", false, Fixtures.NOW).reason);
        json = Fixtures.manifestJson();
        json.getJSONArray("assets").remove(1);
        assertEquals(UpdateEligibility.Reason.ASSET_MISSING, UpdateEligibility.evaluate(Fixtures.installed(), Fixtures.release(false, true),
            ReleaseManifest.parse(json.toString()), "nightly", false, Fixtures.NOW).reason);
    }
    @Test public void theNormalBuildMustBeTheReleaseCommit() throws Exception {
        assertEquals(UpdateEligibility.Reason.COMMIT_MISMATCH, nightly(json -> json.getJSONObject("android").getJSONObject("normal").put("sourceCommit", "3".repeat(40))));
        assertEquals(UpdateEligibility.Reason.COMMIT_MISMATCH, nightly(json -> json.put("version", "1.0.2")));
    }
    @Test public void onlyHigherInstallationCodesAreUpdates() throws Exception {
        assertEquals(UpdateEligibility.Reason.NOT_NEWER, nightly(json -> json.getJSONObject("android").getJSONObject("normal").put("versionCode", Fixtures.INSTALLED_CODE)));
        assertEquals(UpdateEligibility.Reason.NOT_NEWER, nightly(json -> {
            json.getJSONObject("android").getJSONObject("normal").put("versionCode", Fixtures.INSTALLED_CODE - 1);
            json.getJSONObject("android").getJSONObject("recovery").put("versionCode", Fixtures.INSTALLED_CODE);
        }));
    }
    @Test public void aPinHoldsEveryUpdateUntilResumed() throws Exception {
        assertEquals(UpdateEligibility.Reason.PINNED, evaluate("nightly", false, true, true, null));
    }
    @Test public void releasesDatedInTheFutureAreIgnored() throws Exception {
        assertEquals(UpdateEligibility.Reason.FUTURE, nightly(json -> json.put("releasedAt", Iso8601.format(Fixtures.NOW + 3_600_000L))));
    }
    @Test public void picksTheHighestEligibleCode() throws Exception {
        List<UpdateEligibility.Decision> decisions = new ArrayList<>();
        decisions.add(UpdateEligibility.evaluate(Fixtures.installed(), Fixtures.release(false, true), Fixtures.manifest(), "nightly", false, Fixtures.NOW));
        JSONObject newer = Fixtures.manifestJson();
        newer.getJSONObject("android").getJSONObject("normal").put("versionCode", Fixtures.NORMAL_CODE + 10);
        newer.getJSONObject("android").getJSONObject("recovery").put("versionCode", Fixtures.NORMAL_CODE + 11);
        decisions.add(UpdateEligibility.evaluate(Fixtures.installed(), Fixtures.release(false, true), ReleaseManifest.parse(newer.toString()), "nightly", false, Fixtures.NOW));
        decisions.add(UpdateEligibility.evaluate(Fixtures.installed(), Fixtures.release(true, true), Fixtures.manifest(), "nightly", false, Fixtures.NOW));
        assertEquals(Fixtures.NORMAL_CODE + 10, UpdateEligibility.best(decisions).manifest.normal.versionCode);
        assertNull(UpdateEligibility.best(new ArrayList<>()));
    }
    @Test public void existingInstallationsKeepNightlyAndFreshOnesFollowStable() {
        assertEquals("nightly", UpdateEligibility.defaultChannel(1_000, 5_000));
        assertEquals("stable", UpdateEligibility.defaultChannel(1_000, 1_000));
    }
}
