package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import org.junit.Test;

public final class InstallIntentsTest {
    private static final long NOW = 1_000_000L;
    private static final String CODE_SHA = "b".repeat(64);
    private static final String RECOVERY_SHA = "c".repeat(64);
    private static final long INSTALLED = 100;
    private static final String COMMIT = Fixtures.COMMIT;

    private static UpdateState staged() {
        UpdateState state = new UpdateState();
        state.target = new UpdateState.Target(); state.target.sha256 = CODE_SHA; state.target.recoverySha256 = RECOVERY_SHA; state.target.versionCode = 102;
        state.recovery.add(recovery(RECOVERY_SHA, 103, Fixtures.PREVIOUS_COMMIT));
        return state;
    }
    private static UpdateState.Recovery recovery(String sha, long code, String commit) {
        UpdateState.Recovery entry = new UpdateState.Recovery(); entry.sha256 = sha; entry.versionCode = code; entry.commit = commit; return entry;
    }
    private static void rejected(Runnable block) { try { block.run(); fail("Accepted"); } catch (IllegalStateException expected) { } }
    private interface Throwing { void run() throws Exception; }
    private static void rejects(String message, Throwing block) throws Exception {
        try { block.run(); fail("Accepted"); } catch (InstallIntents.Rejected expected) { assertTrue(expected.getMessage(), expected.getMessage().contains(message)); }
    }

    @Test public void aRequestNamesTheExactReviewedDigestAndLeavesPolicyAlone() throws Exception {
        UpdateState state = staged(); state.automatic = false;
        UpdateState.Intent intent = InstallIntents.requestUpdate(state, CODE_SHA, NOW);
        assertEquals("update", intent.kind);
        assertEquals(CODE_SHA, state.intent.targetSha256);
        assertFalse("a request never edits the automatic-installation policy", state.automatic);
        assertFalse(intent.transactionId.isEmpty());
    }
    @Test public void aStaleOrMissingDigestIsRejectedNotSubstituted() throws Exception {
        UpdateState state = staged();
        rejects("no longer the verified target", () -> InstallIntents.requestUpdate(state, "d".repeat(64), NOW));
        rejects("no longer the verified target", () -> InstallIntents.requestUpdate(state, "", NOW));
        rejects("no longer the verified target", () -> InstallIntents.requestUpdate(state, null, NOW));
        assertNull(state.intent);
    }
    @Test public void aRequestIsRefusedWhenThereIsNothingSafeToInstall() throws Exception {
        UpdateState none = new UpdateState();
        rejects("No verified update", () -> InstallIntents.requestUpdate(none, CODE_SHA, NOW));
        UpdateState pinned = staged(); pinned.pin = new UpdateState.Pin();
        rejects("pinned", () -> InstallIntents.requestUpdate(pinned, CODE_SHA, NOW));
        UpdateState pending = staged(); pending.pending = new UpdateState.Pending();
        rejects("already in progress", () -> InstallIntents.requestUpdate(pending, CODE_SHA, NOW));
        UpdateState noRecovery = staged(); noRecovery.recovery.clear();
        rejects("recovery build is not cached", () -> InstallIntents.requestUpdate(noRecovery, CODE_SHA, NOW));
    }
    @Test public void aRollbackBindsTheSelectedDigestAndTheRecordedTransaction() throws Exception {
        UpdateState state = staged();
        String transaction = InstallIntents.recoveryTransactionId(INSTALLED, RECOVERY_SHA);
        InstallIntents.requestRollback(state, RECOVERY_SHA, transaction, INSTALLED, COMMIT, NOW);
        assertEquals("rollback", state.intent.kind);
        assertEquals(RECOVERY_SHA, state.intent.targetSha256);
    }
    @Test public void aRollbackNeverFallsBackToAnotherCachedBuild() throws Exception {
        UpdateState state = staged();
        state.recovery.add(recovery("e".repeat(64), 104, "4".repeat(40)));
        String transaction = InstallIntents.recoveryTransactionId(INSTALLED, RECOVERY_SHA);
        rejects("not cached", () -> InstallIntents.requestRollback(state, "f".repeat(64), transaction, INSTALLED, COMMIT, NOW));
        rejects("not cached", () -> InstallIntents.requestRollback(state, null, transaction, INSTALLED, COMMIT, NOW));
        // An option recorded for another installed build, or another option's transaction, is stale.
        rejects("different installed build", () -> InstallIntents.requestRollback(state, RECOVERY_SHA, InstallIntents.recoveryTransactionId(99, RECOVERY_SHA), INSTALLED, COMMIT, NOW));
        rejects("different installed build", () -> InstallIntents.requestRollback(state, RECOVERY_SHA, InstallIntents.recoveryTransactionId(INSTALLED, "e".repeat(64)), INSTALLED, COMMIT, NOW));
        assertNull(state.intent);
    }
    @Test public void aRecoveryBuildAndroidWouldRefuseCannotBeRequested() throws Exception {
        UpdateState lower = staged(); lower.recovery.clear(); lower.recovery.add(recovery(RECOVERY_SHA, 100, Fixtures.PREVIOUS_COMMIT));
        rejects("cannot install", () -> InstallIntents.requestRollback(lower, RECOVERY_SHA, InstallIntents.recoveryTransactionId(INSTALLED, RECOVERY_SHA), INSTALLED, COMMIT, NOW));
        UpdateState same = staged(); same.recovery.clear(); same.recovery.add(recovery(RECOVERY_SHA, 103, COMMIT));
        rejects("cannot install", () -> InstallIntents.requestRollback(same, RECOVERY_SHA, InstallIntents.recoveryTransactionId(INSTALLED, RECOVERY_SHA), INSTALLED, COMMIT, NOW));
    }
    @Test public void requestsGoStaleWhenTheirTargetChangesAndNeverRetarget() throws Exception {
        UpdateState state = staged();
        InstallIntents.requestUpdate(state, CODE_SHA, NOW);
        assertNull(InstallIntents.staleReason(state, INSTALLED, COMMIT, NOW + 1000));
        state.target.sha256 = "d".repeat(64); // a newer release replaced the reviewed one
        assertTrue(InstallIntents.staleReason(state, INSTALLED, COMMIT, NOW + 1000).contains("no longer the verified target"));
        state.target = null;
        assertNotNull(InstallIntents.staleReason(state, INSTALLED, COMMIT, NOW + 1000));
        UpdateState pinned = staged(); InstallIntents.requestUpdate(pinned, CODE_SHA, NOW); pinned.pin = new UpdateState.Pin();
        assertTrue(InstallIntents.staleReason(pinned, INSTALLED, COMMIT, NOW).contains("pinned"));
    }
    @Test public void requestsExpireAfterADayAndRollbacksGoStaleWithTheirBuild() throws Exception {
        UpdateState state = staged();
        InstallIntents.requestUpdate(state, CODE_SHA, NOW);
        assertNull(InstallIntents.staleReason(state, INSTALLED, COMMIT, NOW + InstallIntents.TTL_MS));
        assertTrue(InstallIntents.staleReason(state, INSTALLED, COMMIT, NOW + InstallIntents.TTL_MS + 1).contains("expired"));
        UpdateState rollback = staged();
        InstallIntents.requestRollback(rollback, RECOVERY_SHA, InstallIntents.recoveryTransactionId(INSTALLED, RECOVERY_SHA), INSTALLED, COMMIT, NOW);
        assertNull(InstallIntents.staleReason(rollback, INSTALLED, COMMIT, NOW));
        assertNotNull("installed code overtook the recovery build", InstallIntents.staleReason(rollback, 103, COMMIT, NOW));
        rollback.recovery.clear();
        assertNotNull(InstallIntents.staleReason(rollback, INSTALLED, COMMIT, NOW));
        assertNull(InstallIntents.staleReason(new UpdateState(), INSTALLED, COMMIT, NOW));
    }
}
