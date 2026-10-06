package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import java.io.File;
import java.io.IOException;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class InstallTransactionTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private static UpdateState.Pending pending() {
        UpdateState.Pending pending = new UpdateState.Pending();
        pending.transactionId = "tx-1"; pending.kind = "rollback"; pending.targetVersionCode = 29853701L; pending.previousVersionCode = 29853700L;
        return pending;
    }
    private static UpdateState.Pin pin() {
        UpdateState.Pin pin = new UpdateState.Pin(); pin.versionCode = 29853701L; pin.version = "1.0.0"; pin.reason = "rollback";
        return pin;
    }

    @Test public void intentAndPinAreDurableBeforeAndroidIsAsked() throws Exception {
        File dir = folder.newFolder("state");
        UpdateStore store = UpdateStore.open(dir);
        boolean[] called = {false};
        InstallTransaction.begin(store, (apk, silent) -> {
            called[0] = true;
            // A fresh reader, as the post-restart process would be, must already see both.
            UpdateState seen = UpdateStore.open(dir).snapshot();
            assertEquals("tx-1", seen.pending.transactionId);
            assertEquals("rollback", seen.pin.reason);
            assertFalse(silent);
        }, new File("x.apk"), false, pending(), pin(), 5L);
        assertTrue(called[0]);
    }
    @Test public void nothingIsHandedToAndroidWhenTheIntentCannotBePersisted() throws Exception {
        File dir = folder.newFolder("state");
        UpdateStore store = UpdateStore.open(dir);
        assertTrue(new File(dir, "state.json.tmp").mkdir());
        boolean[] called = {false};
        try { InstallTransaction.begin(store, (apk, silent) -> called[0] = true, new File("x.apk"), true, pending(), pin(), 5L); fail(); }
        catch (IOException expected) { }
        assertFalse("PackageInstaller must not run without a durable intent", called[0]);
        assertNull(store.snapshot().pending);
        assertNull(store.snapshot().pin);
    }
    @Test public void aRefusedInstallClearsThePendingIntentButKeepsTheRollbackPin() throws Exception {
        File dir = folder.newFolder("state");
        UpdateStore store = UpdateStore.open(dir);
        try { InstallTransaction.begin(store, (apk, silent) -> { throw new IOException("session failed"); }, new File("x.apk"), false, pending(), pin(), 9L); fail(); }
        catch (IOException expected) { }
        UpdateState state = UpdateStore.open(dir).snapshot();
        assertNull(state.pending);
        assertEquals("rollback", state.pin.reason);
        assertEquals("failed", state.lastOutcome.result);
        assertEquals("tx-1", state.lastOutcome.transactionId);
    }
    @Test public void insufficientStorageRestoresTheExactManualRequestAndKeepsTheRollbackPin() throws Exception {
        File dir = folder.newFolder("storage-state");
        UpdateStore store = UpdateStore.open(dir);
        UpdateState.Intent request = new UpdateState.Intent();
        request.kind = "rollback"; request.targetSha256 = "c".repeat(64); request.transactionId = "reviewed-tx"; request.requestedAt = 7L;
        store.mutate(state -> state.intent = request);
        UpdateState.Pending pending = pending();
        pending.transactionId = request.transactionId; pending.targetSha256 = request.targetSha256;
        pending.userRequested = true; pending.startedAt = 9L; pending.requestedAt = request.requestedAt;
        try {
            InstallTransaction.begin(store, (apk, silent) -> { throw new UpdateCapacity.Insufficient(); },
                new File("x.apk"), false, pending, pin(), 9L);
            fail();
        } catch (UpdateCapacity.Insufficient expected) { }
        UpdateState state = UpdateStore.open(dir).snapshot();
        assertNull(state.pending);
        assertEquals("rollback", state.pin.reason);
        assertNotNull(state.intent);
        assertEquals(request.kind, state.intent.kind);
        assertEquals(request.targetSha256, state.intent.targetSha256);
        assertEquals(request.transactionId, state.intent.transactionId);
        assertEquals(request.requestedAt, state.intent.requestedAt);
        assertEquals(UpdateCapacity.INSUFFICIENT_MESSAGE, state.lastError);
        assertEquals("waiting", state.lastOutcome.result);
    }

    @Test public void foregroundReturningBeforeCommitBlocksOsCallAsRetryable() throws Exception {
        PhoneOperations operations = new PhoneOperations(() -> 1L);
        assertTrue(operations.admit(() -> true));
        operations.foreground(true);
        boolean[] committed = {false};
        try {
            operations.commitIfQuiet(() -> true, () -> committed[0] = true);
            fail("commit must be blocked when foreground activity returns");
        } catch (PhoneOperations.AdmissionChanged expected) { }
        assertFalse(committed[0]);
    }

    @Test public void lateAdmissionChangeRestoresOriginalRequestAgeAndRollbackPin() throws Exception {
        UpdateStore store = UpdateStore.open(folder.newFolder("admission-state"));
        UpdateState.Intent request = new UpdateState.Intent();
        request.kind = "rollback"; request.targetSha256 = "d".repeat(64); request.transactionId = "late-tx"; request.requestedAt = 7L;
        store.mutate(state -> state.intent = request);
        UpdateState.Pending pending = pending();
        pending.transactionId = request.transactionId; pending.targetSha256 = request.targetSha256;
        pending.userRequested = true; pending.startedAt = 99L; pending.requestedAt = request.requestedAt;
        try {
            InstallTransaction.begin(store, (apk, silent) -> { throw new PhoneOperations.AdmissionChanged(); },
                new File("x.apk"), false, pending, pin(), 100L);
            fail("changed admission must retain the manual request");
        } catch (PhoneOperations.AdmissionChanged expected) { }
        UpdateState state = store.snapshot();
        assertNull(state.pending);
        assertEquals("rollback", state.pin.reason);
        assertNotNull(state.intent);
        assertEquals("late-tx", state.intent.transactionId);
        assertEquals(7L, state.intent.requestedAt);
        assertEquals("waiting", state.lastOutcome.result);
        assertEquals("Phone activity changed before installation.", state.lastError);
        assertEquals(state.lastError, state.lastOutcome.message);
        assertEquals("", state.failedArtifactSha256);
    }
    @Test public void aSecondInstallCannotStartWhileOneIsPending() throws Exception {
        UpdateStore store = UpdateStore.open(folder.newFolder("state"));
        InstallTransaction.begin(store, (apk, silent) -> { }, new File("x.apk"), true, pending(), null, 1L);
        boolean[] called = {false};
        try { InstallTransaction.begin(store, (apk, silent) -> called[0] = true, new File("y.apk"), true, pending(), null, 2L); fail(); }
        catch (IllegalStateException expected) { }
        assertFalse(called[0]);
    }

    @Test public void theRequestIsConsumedInTheSameWriteAsTheInstallationItBecame() throws Exception {
        File dir = folder.newFolder("state");
        UpdateStore store = UpdateStore.open(dir);
        store.mutate(state -> { state.intent = new UpdateState.Intent(); state.intent.targetSha256 = "a".repeat(64); state.automatic = false; });
        InstallTransaction.begin(store, (apk, silent) -> {
            UpdateState seen = UpdateStore.open(dir).snapshot();
            assertNotNull(seen.pending);
            assertNull("an installer failure must not leave a second armed request", seen.intent);
        }, new File("x.apk"), true, pending(), null, 1L);
        assertFalse("the person's policy is never changed to process a request", store.snapshot().automatic);
    }
}
