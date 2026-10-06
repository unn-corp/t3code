package com.devotek.t3code.pwa;

import java.util.List;

/**
 * Decides whether a published release may become this installation's update. The decision is pure so
 * it can be re-evaluated against freshly fetched metadata immediately before installation.
 * Drafts never qualify, and the recovery artifact is never selected as a normal update.
 */
final class UpdateEligibility {
    private static final long FUTURE_SKEW_MS = 5 * 60_000L;

    enum Reason {
        ELIGIBLE, DRAFT, WITHDRAWN, CHANNEL, CHECKS_FAILED, FUTURE, PACKAGE, SIGNER, PROTOCOL, ASSET_MISSING, ASSET_KIND,
        COMMIT_MISMATCH, RECOVERY_INVALID, NOT_NEWER, PINNED
    }

    /** What this installation is: the running package, its code, and its (Android-verified) signer. */
    static final class Installed {
        final String packageName, signerSha256;
        final long versionCode;
        Installed(String packageName, long versionCode, String signerSha256) {
            this.packageName = packageName; this.versionCode = versionCode; this.signerSha256 = signerSha256;
        }
    }

    static final class Decision {
        final Reason reason;
        final ReleaseRef release;
        final ReleaseManifest manifest;
        Decision(Reason reason, ReleaseRef release, ReleaseManifest manifest) {
            this.reason = reason; this.release = release; this.manifest = manifest;
        }
        boolean eligible() { return reason == Reason.ELIGIBLE; }
    }

    private UpdateEligibility() { }

    /** A nightly device accepts any channel; a stable device accepts only stable releases. */
    static Decision evaluate(Installed installed, ReleaseRef release, ReleaseManifest manifest, String policyChannel,
            boolean pinned, long now) {
        if (release.draft) return no(Reason.DRAFT, release, manifest);
        // A withdrawn release keeps its tag and assets, so only its notes say it must no longer install.
        if (release.withdrawn) return no(Reason.WITHDRAWN, release, manifest);
        // The release flag and manifest must agree, so a mislabeled nightly cannot reach stable devices.
        boolean manifestStable = "stable".equals(manifest.channel);
        if (manifestStable == release.prerelease) return no(Reason.CHANNEL, release, manifest);
        if ("stable".equals(policyChannel) && !manifestStable) return no(Reason.CHANNEL, release, manifest);
        if (!manifest.checksPassed()) return no(Reason.CHECKS_FAILED, release, manifest);
        if (Iso8601.parse(manifest.releasedAt) > now + FUTURE_SKEW_MS) return no(Reason.FUTURE, release, manifest);
        ReleaseManifest.Artifact normal = manifest.normal, recovery = manifest.recovery;
        if (!installed.packageName.equals(normal.packageName) || !installed.packageName.equals(recovery.packageName))
            return no(Reason.PACKAGE, release, manifest);
        if (normal.updaterProtocol != ReleaseManifest.UPDATER_PROTOCOL || recovery.updaterProtocol != ReleaseManifest.UPDATER_PROTOCOL)
            return no(Reason.PROTOCOL, release, manifest);
        if (!installed.signerSha256.equals(normal.signerSha256) || !installed.signerSha256.equals(recovery.signerSha256))
            return no(Reason.SIGNER, release, manifest);
        Reason assets = assetReason(release, manifest, normal, "android");
        if (assets == Reason.ELIGIBLE) assets = assetReason(release, manifest, recovery, "android-recovery");
        if (assets != Reason.ELIGIBLE) return no(assets, release, manifest);
        if (!normal.sourceCommit.equals(manifest.commit) || !normal.sourceVersion.equals(manifest.version))
            return no(Reason.COMMIT_MISMATCH, release, manifest);
        // Recovery replaces a broken normal install, so Android requires it to carry a higher code.
        if (recovery.versionCode <= normal.versionCode || normal.asset.equals(recovery.asset))
            return no(Reason.RECOVERY_INVALID, release, manifest);
        if (normal.versionCode <= installed.versionCode) return no(Reason.NOT_NEWER, release, manifest);
        if (pinned) return no(Reason.PINNED, release, manifest);
        return no(Reason.ELIGIBLE, release, manifest);
    }

    private static Reason assetReason(ReleaseRef release, ReleaseManifest manifest, ReleaseManifest.Artifact artifact, String kind) {
        ReleaseManifest.Asset asset = manifest.asset(artifact.asset);
        ReleaseRef.AssetRef published = release.asset(artifact.asset);
        if (asset == null || published == null || published.size != asset.bytes) return Reason.ASSET_MISSING;
        if (!kind.equals(asset.kind) || !"android".equals(asset.platform)) return Reason.ASSET_KIND;
        return Reason.ELIGIBLE;
    }

    private static Decision no(Reason reason, ReleaseRef release, ReleaseManifest manifest) { return new Decision(reason, release, manifest); }

    /** Highest-code eligible update among releases already paired with their manifests; null if none. */
    static Decision best(List<Decision> decisions) {
        Decision best = null;
        for (Decision decision : decisions) {
            if (!decision.eligible()) continue;
            if (best == null || decision.manifest.normal.versionCode > best.manifest.normal.versionCode) best = decision;
        }
        return best;
    }

    /** An existing installation keeps the nightly cadence; a fresh install follows stable. */
    static String defaultChannel(long firstInstallTime, long lastUpdateTime) {
        return lastUpdateTime > firstInstallTime ? "nightly" : "stable";
    }
}
