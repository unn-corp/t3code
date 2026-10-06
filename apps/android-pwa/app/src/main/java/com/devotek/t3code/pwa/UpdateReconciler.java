package com.devotek.t3code.pwa;

/** Compares what was intended before an installation with the build that actually launched afterwards. */
final class UpdateReconciler {
    /** Android may take a long time to confirm; past this the installation is considered abandoned. */
    static final long ABANDON_MS = 30 * 60_000L;

    enum Result { NONE, FIRST_RUN, VERIFIED, IDENTITY_MISMATCH, INSTALL_PENDING, INSTALL_ABANDONED, EXTERNAL_CHANGE }

    static final class Running {
        final String version, commit, artifactSha256;
        final long versionCode;
        Running(String version, String commit, long versionCode, String artifactSha256) {
            this.version = version; this.commit = commit; this.versionCode = versionCode; this.artifactSha256 = artifactSha256;
        }
    }

    private UpdateReconciler() { }

    /** Mutates {@code state} in place; the caller persists it. */
    static Result reconcile(UpdateState state, Running running, String defaultChannel, long now) {
        return reconcile(state, running, defaultChannel, now, false);
    }

    static Result reconcile(UpdateState state, Running running, String defaultChannel, long now, boolean abandonedSession) {
        if (state.channel == null) state.channel = defaultChannel;
        UpdateState.Pending pending = state.pending;
        Result result = Result.NONE;
        if (pending != null) {
            if (running.versionCode == pending.targetVersionCode) {
                boolean identical = running.commit.equals(pending.targetCommit) && running.version.equals(pending.targetVersion)
                    && running.artifactSha256.equals(pending.targetSha256);
                state.pending = null;
                if (identical) {
                    record(state, pending, "completed", "Installed " + running.version, now);
                    adopt(state, running, pending.targetChannel);
                    result = Result.VERIFIED;
                } else {
                    // The package code matches but its content is not what was verified: never call that success.
                    record(state, pending, "failed", "The installed build does not match the verified update.", now);
                    state.forceRecovery = true;
                    adopt(state, running, state.channel);
                    result = Result.IDENTITY_MISMATCH;
                }
            } else if (running.versionCode == pending.previousVersionCode) {
                if (now - pending.startedAt > ABANDON_MS && abandonedSession) {
                    state.pending = null;
                    record(state, pending, "failed", "Android did not finish the installation.", now);
                    result = Result.INSTALL_ABANDONED;
                } else result = Result.INSTALL_PENDING;
            } else {
                state.pending = null;
                record(state, pending, "failed", "Another build was installed while an update was pending.", now);
                adopt(state, running, state.channel);
                result = Result.EXTERNAL_CHANGE;
            }
        } else if (state.identity == null) {
            adopt(state, running, state.channel);
            result = Result.FIRST_RUN;
        } else if (state.identity.versionCode != running.versionCode || !state.identity.commit.equals(running.commit)) {
            adopt(state, running, state.channel);
            result = Result.EXTERNAL_CHANGE;
        } else if (state.identity.artifactSha256.isEmpty() && !running.artifactSha256.isEmpty()) {
            state.identity.artifactSha256 = running.artifactSha256;
        }
        // A verified download for this build or an older one can never install again.
        if (state.target != null && state.target.versionCode <= running.versionCode) state.target = null;
        return result;
    }

    private static void adopt(UpdateState state, Running running, String channel) {
        UpdateState.Identity identity = new UpdateState.Identity();
        identity.version = running.version; identity.commit = running.commit; identity.versionCode = running.versionCode;
        identity.artifactSha256 = running.artifactSha256; identity.channel = channel;
        identity.sequence = state.identity == null ? 1 : state.identity.sequence + 1;
        state.identity = identity;
        state.unhealthyLaunches = 0;
    }

    private static void record(UpdateState state, UpdateState.Pending pending, String result, String message, long now) {
        UpdateState.Outcome outcome = new UpdateState.Outcome();
        outcome.transactionId = pending.transactionId; outcome.kind = pending.kind; outcome.result = result;
        outcome.message = message; outcome.at = now;
        state.lastOutcome = outcome;
    }
}
