package com.devotek.t3code.pwa;

import java.util.UUID;

/**
 * A person's request to install one exact artifact. It records the choice and the guard admits it later;
 * it never installs on the spot and never edits the automatic-installation policy. Every request names
 * the digest the person reviewed, so a newer or different cached build is rejected, not substituted.
 */
final class InstallIntents {
    /** A request nobody could satisfy for a day is stale: the person should look again. */
    static final long TTL_MS = 24 * 60 * 60_000L;

    /** Message safe to show the person. */
    static final class Rejected extends Exception { Rejected(String message) { super(message); } }

    private InstallIntents() { }

    /** Stable per build and option, so a recovery option reviewed for one installed build cannot apply to another. */
    static String recoveryTransactionId(long installedVersionCode, String recoverySha256) {
        return "recovery-" + installedVersionCode + "-" + recoverySha256.substring(0, Math.min(16, recoverySha256.length()));
    }

    /** Records a request to install the staged update whose digest the person reviewed. Mutates {@code state}. */
    static UpdateState.Intent requestUpdate(UpdateState state, String targetSha256, long now) throws Rejected {
        if (state.pending != null) throw new Rejected("An installation is already in progress.");
        if (state.pin != null) throw new Rejected("Updates are pinned. Resume updates first.");
        UpdateState.Target target = state.target;
        if (target == null) throw new Rejected("No verified update is ready.");
        if (targetSha256 == null || !targetSha256.equals(target.sha256)) throw new Rejected("That update is no longer the verified target. Review the current one.");
        if (state.recovery(target.recoverySha256) == null) throw new Rejected("A verified recovery build is not cached yet.");
        UpdateState.Intent intent = new UpdateState.Intent();
        intent.kind = "update"; intent.targetSha256 = target.sha256; intent.transactionId = UUID.randomUUID().toString(); intent.requestedAt = now;
        state.intent = intent;
        return intent;
    }

    /** Records a request to roll back to the cached recovery build the person selected. Mutates {@code state}. */
    static UpdateState.Intent requestRollback(UpdateState state, String optionId, String transactionId, long installedVersionCode,
            String installedCommit, long now) throws Rejected {
        if (state.pending != null) throw new Rejected("An installation is already in progress.");
        UpdateState.Recovery entry = optionId == null ? null : state.recovery(optionId);
        if (entry == null) throw new Rejected("That recovery build is not cached.");
        if (!installable(entry, installedVersionCode, installedCommit)) throw new Rejected("Android cannot install that recovery build over the current app.");
        if (!recoveryTransactionId(installedVersionCode, entry.sha256).equals(transactionId))
            throw new Rejected("That recovery option was recorded for a different installed build. Review the current options.");
        UpdateState.Intent intent = new UpdateState.Intent();
        intent.kind = "rollback"; intent.targetSha256 = entry.sha256; intent.transactionId = UUID.randomUUID().toString(); intent.requestedAt = now;
        state.intent = intent;
        return intent;
    }

    static boolean installable(UpdateState.Recovery entry, long installedVersionCode, String installedCommit) {
        return entry.versionCode > installedVersionCode && !entry.commit.equals(installedCommit);
    }

    /** Null while the request may still be satisfied; otherwise why it must be dropped. Never selects a substitute. */
    static String staleReason(UpdateState state, long installedVersionCode, String installedCommit, long now) {
        UpdateState.Intent intent = state.intent;
        if (intent == null) return null;
        if (now - intent.requestedAt > TTL_MS) return "The install request expired. Request it again.";
        if ("rollback".equals(intent.kind)) {
            UpdateState.Recovery entry = state.recovery(intent.targetSha256);
            if (entry == null || !installable(entry, installedVersionCode, installedCommit))
                return "The selected recovery build is no longer available for this installation.";
            return null;
        }
        if (state.pin != null) return "Updates were pinned, so the install request was cancelled.";
        if (state.target == null || !state.target.sha256.equals(intent.targetSha256))
            return "The reviewed update is no longer the verified target, so the install request was cancelled.";
        return null;
    }
}
