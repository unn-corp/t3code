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
