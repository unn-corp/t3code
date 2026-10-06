package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import org.junit.Test;

public final class UpdateReconcilerTest {
    private static final String SHA = "b".repeat(64);
    private static final long NOW = 5_000_000L;

    private static UpdateReconciler.Running running(long code, String version, String commit, String sha) {
        return new UpdateReconciler.Running(version, commit, code, sha);
    }
    private static UpdateState installed(long code) {
        UpdateState state = new UpdateState();
        state.channel = "nightly";
        state.identity = new UpdateState.Identity();
        state.identity.versionCode = code; state.identity.version = "1.0.0"; state.identity.commit = Fixtures.PREVIOUS_COMMIT;
        state.identity.artifactSha256 = "a".repeat(64); state.identity.sequence = 4;
        return state;
    }
    private static UpdateState.Pending pending(long previous, long target) {
        UpdateState.Pending pending = new UpdateState.Pending();
        pending.transactionId = "tx"; pending.previousVersionCode = previous; pending.targetVersionCode = target;
        pending.targetVersion = "1.0.1"; pending.targetCommit = Fixtures.COMMIT; pending.targetSha256 = SHA; pending.targetChannel = "stable";
        pending.startedAt = NOW - 1000;
        return pending;
    }

    @Test public void theVerifiedTargetCompletesTheTransactionAndAdvancesTheSequence() {
        UpdateState state = installed(100);
        state.pending = pending(100, 102); state.unhealthyLaunches = 2;
        state.target = new UpdateState.Target(); state.target.versionCode = 102;
        UpdateReconciler.Result result = UpdateReconciler.reconcile(state, running(102, "1.0.1", Fixtures.COMMIT, SHA), "stable", NOW);
        assertEquals(UpdateReconciler.Result.VERIFIED, result);
        assertNull(state.pending);
        assertNull("the consumed download is no longer a candidate", state.target);
        assertEquals(5, state.identity.sequence);
        assertEquals("stable", state.identity.channel);
        assertEquals(Fixtures.COMMIT, state.identity.commit);
        assertEquals(0, state.unhealthyLaunches);
        assertEquals("completed", state.lastOutcome.result);
        assertFalse(state.forceRecovery);
    }
    @Test public void aMatchingCodeWithDifferentContentIsNeverSuccess() {
        for (UpdateReconciler.Running other : new UpdateReconciler.Running[]{
                running(102, "1.0.1", "9".repeat(40), SHA), running(102, "1.0.1", Fixtures.COMMIT, "d".repeat(64)), running(102, "9.9.9", Fixtures.COMMIT, SHA)}) {
            UpdateState state = installed(100);
            state.pending = pending(100, 102);
            assertEquals(UpdateReconciler.Result.IDENTITY_MISMATCH, UpdateReconciler.reconcile(state, other, "stable", NOW));
            assertTrue("native recovery opens before the shell", state.recoveryRequired());
            assertEquals("failed", state.lastOutcome.result);
            assertNull(state.pending);
        }
    }
    @Test public void aPendingInstallStillRunningTheOldBuildKeepsWaitingThenIsAbandoned() {
        UpdateState state = installed(100);
        state.pending = pending(100, 102);
        assertEquals(UpdateReconciler.Result.INSTALL_PENDING, UpdateReconciler.reconcile(state, running(100, "1.0.0", Fixtures.PREVIOUS_COMMIT, "a".repeat(64)), "stable", NOW));
        assertNotNull(state.pending);
        assertEquals(UpdateReconciler.Result.INSTALL_ABANDONED, UpdateReconciler.reconcile(state,
            running(100, "1.0.0", Fixtures.PREVIOUS_COMMIT, "a".repeat(64)), "stable", NOW + UpdateReconciler.ABANDON_MS + 2000, true));
        assertNull(state.pending);
        assertEquals("failed", state.lastOutcome.result);
        assertEquals("the identity and any pin are untouched", 4, state.identity.sequence);
    }
    @Test public void aRollbackPinSurvivesItsOwnVerification() {
        UpdateState state = installed(100);
        state.pending = pending(100, 102); state.pending.kind = "rollback";
        state.pin = new UpdateState.Pin(); state.pin.reason = "rollback"; state.pin.versionCode = 102;
        UpdateReconciler.reconcile(state, running(102, "1.0.1", Fixtures.COMMIT, SHA), "stable", NOW);
        assertEquals("rollback", state.pin.reason);
    }
    @Test public void aBuildInstalledByAnotherRouteIsRecordedNotTrustedAsTheTarget() {
        UpdateState state = installed(100);
        state.pending = pending(100, 102);
        assertEquals(UpdateReconciler.Result.EXTERNAL_CHANGE, UpdateReconciler.reconcile(state, running(500, "2.0.0", "8".repeat(40), SHA), "stable", NOW));
        assertNull(state.pending);
        assertEquals(500, state.identity.versionCode);
        state = installed(100);
        assertEquals(UpdateReconciler.Result.EXTERNAL_CHANGE, UpdateReconciler.reconcile(state, running(101, "1.0.0", Fixtures.COMMIT, SHA), "stable", NOW));
        assertEquals(5, state.identity.sequence);
    }
    @Test public void firstRunRecordsIdentityAndPicksTheDefaultChannel() {
        UpdateState state = new UpdateState();
        assertEquals(UpdateReconciler.Result.FIRST_RUN, UpdateReconciler.reconcile(state, running(100, "1.0.0", Fixtures.COMMIT, SHA), "nightly", NOW));
        assertEquals("nightly", state.channel);
        assertEquals(100, state.identity.versionCode);
        assertEquals(1, state.identity.sequence);
    }
    @Test public void aUserChosenChannelIsNeverOverwrittenByTheDefault() {
        UpdateState state = installed(100); state.channel = "stable";
        assertEquals(UpdateReconciler.Result.NONE, UpdateReconciler.reconcile(state, running(100, "1.0.0", Fixtures.PREVIOUS_COMMIT, "a".repeat(64)), "nightly", NOW));
        assertEquals("stable", state.channel);
    }
    @Test public void aStagedDownloadForTheRunningOrAnOlderBuildIsDropped() {
        UpdateState state = installed(100);
        state.target = new UpdateState.Target(); state.target.versionCode = 100;
        UpdateReconciler.reconcile(state, running(100, "1.0.0", Fixtures.PREVIOUS_COMMIT, "a".repeat(64)), "nightly", NOW);
        assertNull(state.target);
    }
    @Test public void aTimeoutWithoutOsSessionTerminationKeepsWorkFenced() {
        UpdateState state = installed(100); state.pending = pending(100, 102);
        assertEquals(UpdateReconciler.Result.INSTALL_PENDING, UpdateReconciler.reconcile(state,
            running(100, "1.0.0", Fixtures.PREVIOUS_COMMIT, "a".repeat(64)), "stable", NOW + UpdateReconciler.ABANDON_MS + 2000));
        assertNotNull(state.pending);
    }
}
