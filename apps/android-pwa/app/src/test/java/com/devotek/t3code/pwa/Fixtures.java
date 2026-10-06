package com.devotek.t3code.pwa;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** A valid release and the pieces tests perturb one at a time. */
final class Fixtures {
    static final String SIGNER = "eb38a25cf25676b7418fee5105f66d9ff166bfd5546ba816288e5bd83b73d362";
    static final String COMMIT = "1111111111111111111111111111111111111111";
    static final String PREVIOUS_COMMIT = "2222222222222222222222222222222222222222";
    static final String NORMAL_ASSET = "t3-code-android-1.0.1.apk";
    static final String RECOVERY_ASSET = "t3-code-android-recovery-1.0.1.apk";
    static final String NORMAL_SHA = "b".repeat(64);
    static final String RECOVERY_SHA = "c".repeat(64);
    static final long INSTALLED_CODE = 29853678L;
    static final long NORMAL_CODE = 29853700L;
    static final long RECOVERY_CODE = NORMAL_CODE + 1;
    static final long NOW = 1_790_000_000_000L;

    private Fixtures() { }

    static JSONObject artifact(String asset, long code, String version, String commit) throws JSONException {
        return new JSONObject().put("asset", asset).put("versionCode", code).put("sourceVersion", version).put("sourceCommit", commit)
            .put("packageName", ReleaseManifest.PACKAGE).put("signerSha256", SIGNER).put("updaterProtocol", 1);
    }

    static JSONObject manifestJson() throws JSONException {
        JSONArray assets = new JSONArray()
            .put(new JSONObject().put("name", NORMAL_ASSET).put("sha256", NORMAL_SHA).put("bytes", 1000).put("kind", "android").put("platform", "android"))
            .put(new JSONObject().put("name", RECOVERY_ASSET).put("sha256", RECOVERY_SHA).put("bytes", 2000).put("kind", "android-recovery").put("platform", "android"));
        return new JSONObject().put("format", 1).put("repository", "unn-corp/t3code").put("version", "1.0.1").put("commit", COMMIT)
            .put("channel", "nightly").put("releasedAt", Iso8601.format(NOW - 3_600_000L)).put("assets", assets)
            .put("android", new JSONObject().put("normal", artifact(NORMAL_ASSET, NORMAL_CODE, "1.0.1", COMMIT))
                .put("recovery", artifact(RECOVERY_ASSET, RECOVERY_CODE, "1.0.0", PREVIOUS_COMMIT)))
            .put("checks", new JSONObject().put("build", true).put("install", true).put("update", true).put("recovery", true));
    }

    static ReleaseManifest manifest() throws Exception { return ReleaseManifest.parse(manifestJson().toString()); }

    static ReleaseRef release(boolean draft, boolean prerelease) {
        List<ReleaseRef.AssetRef> assets = new ArrayList<>();
        assets.add(new ReleaseRef.AssetRef(NORMAL_ASSET, 1000));
        assets.add(new ReleaseRef.AssetRef(RECOVERY_ASSET, 2000));
        assets.add(new ReleaseRef.AssetRef(ReleaseManifest.ASSET_NAME, 800));
        return new ReleaseRef("v1.0.1-nightly.1", draft, prerelease, NOW - 3_600_000L, assets);
    }

    static UpdateEligibility.Installed installed() { return new UpdateEligibility.Installed(ReleaseManifest.PACKAGE, INSTALLED_CODE, SIGNER); }
}
