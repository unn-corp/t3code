package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public final class UpdateEngineStatusTargetTest {
    private static final String NORMAL_SHA = "b".repeat(64);
    private static final String RECOVERY_SHA = "c".repeat(64);

    private static UpdateState staged() {
        UpdateState state = new UpdateState();
        state.target = new UpdateState.Target();
        state.target.sha256 = NORMAL_SHA; state.target.version = "1.0.1-nightly.20261007.66";
        state.target.commit = Fixtures.COMMIT; state.target.versionCode = 104;
        state.target.channel = "nightly"; state.target.tag = "fork-v" + state.target.version;
        UpdateState.Recovery recovery = new UpdateState.Recovery();
        recovery.sha256 = RECOVERY_SHA; recovery.version = "1.0.1-nightly.20261007.49";
        recovery.commit = Fixtures.PREVIOUS_COMMIT; recovery.versionCode = 103;
        state.recovery.add(recovery);
        return state;
    }

    @Test public void waitingRollbackNamesTheSelectedRecoveryInsteadOfTheStagedUpdate() throws Exception {
        UpdateState state = staged();
        InstallIntents.requestRollback(state, RECOVERY_SHA, InstallIntents.recoveryTransactionId(100, RECOVERY_SHA),
            100, "1.0.1-nightly.20261007.65", Fixtures.COMMIT, 1000);
        JSONObject target = UpdateEngine.statusTarget(state, new JSONObject().put("version", "other"));
        assertEquals(state.recovery.get(0).version, target.getString("version"));
        assertEquals(Fixtures.PREVIOUS_COMMIT, target.getString("commit"));
        assertEquals(103, target.getLong("versionCode"));
        assertEquals(RECOVERY_SHA, target.getString("artifactSha256"));
        assertEquals("nightly", target.getString("channel"));
        assertEquals("recovery", target.getString("tag"));
    }

    @Test public void missingRecoveryNeverSubstitutesAStagedOrAvailableUpdate() throws Exception {
        UpdateState state = staged();
        state.intent = new UpdateState.Intent(); state.intent.kind = "rollback";
        state.intent.targetSha256 = RECOVERY_SHA; state.recovery.clear();
        assertNull(UpdateEngine.statusTarget(state, new JSONObject().put("version", "other")));
    }

    @Test public void committedInstallerKeepsItsIdentityWhenOtherTargetsChange() throws Exception {
        UpdateState state = staged(); state.pending = new UpdateState.Pending();
        state.pending.targetVersion = state.recovery.get(0).version;
        state.pending.targetSha256 = RECOVERY_SHA; state.pending.targetVersionCode = 103;
        state.intent = new UpdateState.Intent(); state.intent.targetSha256 = NORMAL_SHA;
        assertEquals(RECOVERY_SHA, UpdateEngine.statusTarget(state, null).getString("artifactSha256"));
    }

    @Test public void normalRequestsStayBoundAndCancelledRequestsShowTheStagedBuildAgain() throws Exception {
        UpdateState state = staged(); state.intent = new UpdateState.Intent();
        state.intent.targetSha256 = NORMAL_SHA;
        assertEquals(NORMAL_SHA, UpdateEngine.statusTarget(state, null).getString("artifactSha256"));
        state.target.sha256 = "d".repeat(64);
        assertNull(UpdateEngine.statusTarget(state, new JSONObject()));
        state.intent = null;
        assertEquals(state.target.sha256, UpdateEngine.statusTarget(state, null).getString("artifactSha256"));
        state.target = null;
        JSONObject available = new JSONObject().put("version", "available");
        assertSame(available, UpdateEngine.statusTarget(state, available));
    }
}
