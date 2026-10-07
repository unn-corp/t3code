package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class UpdateStoreTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test public void persistsPoliciesPinsAndPendingInstallsAcrossProcessRestarts() throws Exception {
        File dir = folder.newFolder("state");
        UpdateStore store = UpdateStore.open(dir);
        store.mutate(state -> {
            state.channel = "nightly"; state.automatic = false;
            state.pin = new UpdateState.Pin(); state.pin.version = "1.0.0"; state.pin.versionCode = 42; state.pin.reason = "rollback";
            state.pending = new UpdateState.Pending(); state.pending.transactionId = "t-1"; state.pending.targetVersionCode = 43;
            state.intent = new UpdateState.Intent(); state.intent.kind = "rollback"; state.intent.targetSha256 = "f".repeat(64); state.intent.transactionId = "i-1";
            state.pin.artifactSha256 = "9".repeat(64);
            UpdateState.Recovery recovery = new UpdateState.Recovery(); recovery.sha256 = "a".repeat(64); recovery.versionCode = 44;
            state.recovery.add(recovery);
        });
        UpdateState reopened = UpdateStore.open(dir).snapshot();
        assertEquals("nightly", reopened.channel);
        assertFalse(reopened.automatic);
        assertEquals("rollback", reopened.pin.reason);
        assertEquals(42, reopened.pin.versionCode);
        assertEquals("t-1", reopened.pending.transactionId);
        assertEquals("rollback", reopened.intent.kind);
        assertEquals("f".repeat(64), reopened.intent.targetSha256);
        assertEquals("9".repeat(64), reopened.pin.artifactSha256);
        assertNotNull(reopened.recovery("a".repeat(64)));
    }
    @Test public void aFailedWriteThrowsAndLeavesThePreviousStateIntact() throws Exception {
        File dir = folder.newFolder("state");
        UpdateStore store = UpdateStore.open(dir);
        store.mutate(state -> state.channel = "stable");
        assertTrue(new File(dir, "state.json.tmp").mkdir()); // makes the temp write impossible
        try { store.mutate(state -> state.channel = "nightly"); fail("A failed write must surface"); }
        catch (IOException expected) { }
        assertEquals("stable", store.snapshot().channel);
        assertEquals("stable", UpdateStore.open(dir).snapshot().channel);
    }
    @Test public void aMutationThatThrowsWritesNothing() throws Exception {
        File dir = folder.newFolder("state");
        UpdateStore store = UpdateStore.open(dir);
        store.mutate(state -> state.channel = "stable");
        try { store.mutate(state -> { state.channel = "nightly"; throw new IllegalStateException("abort"); }); fail(); }
        catch (IllegalStateException expected) { }
        assertEquals("stable", UpdateStore.open(dir).snapshot().channel);
    }
    @Test public void processDeathBeforeReplacementKeepsThePrimaryAndInstallerFence() throws Exception {
        File dir = folder.newFolder("interrupted-commit");
        UpdateStore.open(dir).mutate(state -> {
            state.channel = "nightly";
            state.pending = new UpdateState.Pending(); state.pending.transactionId = "committed-install";
            state.pending.sessionId = 83;
            state.pin = new UpdateState.Pin(); state.pin.reason = "rollback";
        });
        UpdateStore interrupted = UpdateStore.open(dir, () -> {
            assertTrue("The committed primary must never disappear", new File(dir, "state.json").isFile());
            throw new IOException("Process died after backup, before replacement");
        });
        try { interrupted.mutate(state -> { state.pending = null; state.pin = null; }); fail(); }
        catch (IOException expected) { }
        UpdateState reopened = UpdateStore.open(dir).snapshot();
        assertFalse("An interrupted write must not manufacture a corruption hold", reopened.recoveredFromCorruption);
        assertEquals("committed-install", reopened.pending.transactionId);
        assertEquals(83, reopened.pending.sessionId);
        assertEquals("rollback", reopened.pin.reason);
        // Stale temp bytes never win over the committed primary, and the next write can finish normally.
        UpdateStore.open(dir).mutate(state -> state.pending = null);
        assertNull(UpdateStore.open(dir).snapshot().pending);
    }
    @Test public void backupWriteFailureDoesNotRemoveTheCommittedPrimary() throws Exception {
        File dir = folder.newFolder("backup-failure");
        UpdateStore store = UpdateStore.open(dir);
        store.mutate(state -> state.channel = "stable");
        assertTrue(new File(dir, "state.json.bak.tmp").mkdir());
        try { store.mutate(state -> state.channel = "nightly"); fail(); }
        catch (IOException expected) { }
        UpdateState reopened = UpdateStore.open(dir).snapshot();
        assertEquals("stable", reopened.channel);
        assertFalse(reopened.recoveredFromCorruption);
    }
    @Test public void recoversFromABackupWhenTheMainFileIsDamaged() throws Exception {
        File dir = folder.newFolder("state");
        UpdateStore store = UpdateStore.open(dir);
        store.mutate(state -> state.channel = "nightly");
        store.mutate(state -> state.pin = new UpdateState.Pin());
        Files.write(new File(dir, "state.json").toPath(), "{ not json".getBytes(StandardCharsets.UTF_8));
        UpdateState state = UpdateStore.open(dir).snapshot();
        assertEquals("nightly", state.channel);
        assertTrue(state.recoveredFromCorruption);
        assertFalse(state.automatic);
        assertEquals(-1, state.corruptionBoot);
    }
    @Test public void totalCorruptionTurnsAutomaticInstallationOff() throws Exception {
        File dir = folder.newFolder("state");
        UpdateStore.open(dir).mutate(state -> state.channel = "nightly");
        Files.write(new File(dir, "state.json").toPath(), "garbage".getBytes(StandardCharsets.UTF_8));
        Files.write(new File(dir, "state.json.bak").toPath(), "garbage".getBytes(StandardCharsets.UTF_8));
        UpdateState state = UpdateStore.open(dir).snapshot();
        assertFalse("a lost pin must not be replaced by silent installs", state.automatic);
        assertTrue(state.recoveredFromCorruption);
        assertNotNull(state.lastError);
    }
    @Test public void aStaleInstallerCallbackCannotMutateTheCurrentTransaction() throws Exception {
        UpdateStore store = UpdateStore.open(folder.newFolder("callback"));
        store.mutate(state -> { state.pending = new UpdateState.Pending(); state.pending.transactionId = "new"; });
        assertFalse(store.tryMutatePending("old", state -> state.pending.installerResult = "success"));
        assertEquals("committing", store.snapshot().pending.installerResult);
        assertTrue(store.tryMutatePending("new", state -> state.pending.installerResult = "awaiting-confirmation"));
        assertEquals("awaiting-confirmation", store.snapshot().pending.installerResult);
    }
    @Test public void aFreshInstallationStartsClean() throws Exception {
        UpdateState state = UpdateStore.open(folder.newFolder("state")).snapshot();
        assertNull(state.channel);
        assertTrue(state.automatic);
        assertFalse(state.recoveredFromCorruption);
        assertFalse(state.recoveryRequired());
    }
    @Test public void confirmationIdentitySurvivesRestartAndStaleCallbacksCannotReplaceIt() throws Exception {
        File dir = folder.newFolder("confirmation");
        UpdateStore store = UpdateStore.open(dir);
        store.mutate(state -> {
            state.pending = new UpdateState.Pending(); state.pending.transactionId = "current"; state.pending.sessionId = 83;
        });
        String filter = "intent:#Intent;action=android.content.pm.action.CONFIRM_INSTALL;component=com.android.packageinstaller/.PackageInstallerActivity;end";
        assertTrue(store.tryMutatePending("current", state -> {
            state.pending.installerResult = "awaiting-confirmation"; state.pending.confirmationFilterUri = filter;
        }));
        assertFalse(store.tryMutatePending("previous", state -> state.pending.confirmationFilterUri = "wrong-session"));
        UpdateState reopened = UpdateStore.open(dir).snapshot();
        assertEquals("awaiting-confirmation", reopened.pending.installerResult);
        assertEquals(83, reopened.pending.sessionId);
        assertEquals(filter, reopened.pending.confirmationFilterUri);
        store.mutate(state -> state.pending = null);
        assertNull(UpdateStore.open(dir).snapshot().pending);
    }
    @Test public void legacyPendingConfirmationDoesNotInventAnInstallerTarget() throws Exception {
        File dir = folder.newFolder("legacy-confirmation");
        Files.write(new File(dir, "state.json").toPath(), "{\"format\":1,\"pending\":{\"transactionId\":\"legacy\",\"sessionId\":18,\"installerResult\":\"awaiting-confirmation\"}}".getBytes(StandardCharsets.UTF_8));
        UpdateState.Pending pending = UpdateStore.open(dir).snapshot().pending;
        assertEquals("legacy", pending.transactionId);
        assertEquals("", pending.confirmationFilterUri);
    }
    @Test public void aStateReadFromAnOlderBuildKeepsUnknownDefaults() throws Exception {
        File dir = folder.newFolder("state");
        Files.write(new File(dir, "state.json").toPath(), "{\"format\":1,\"channel\":\"stable\"}".getBytes(StandardCharsets.UTF_8));
        UpdateState state = UpdateStore.open(dir).snapshot();
        assertEquals("stable", state.channel);
        assertTrue(state.automatic);
        assertNull(state.pin);
    }
    @Test public void recoveryOpensAfterRepeatedUnhealthyLaunchesOrAForcedFlag() {
        UpdateState state = new UpdateState();
        state.unhealthyLaunches = UpdateState.UNHEALTHY_LIMIT - 1;
        assertFalse(state.recoveryRequired());
        state.unhealthyLaunches = UpdateState.UNHEALTHY_LIMIT;
        assertTrue(state.recoveryRequired());
        state.unhealthyLaunches = 0; state.forceRecovery = true;
        assertTrue(state.recoveryRequired());
    }
}
