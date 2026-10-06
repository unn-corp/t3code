package com.devotek.t3code.pwa;

import java.io.File;
import java.io.IOException;

/**
 * The hand-off to PackageInstaller. The intent (and any rollback pin) is durable before Android is
 * asked to replace the app, because the process is usually killed mid-installation and the next
 * process has only the store to explain what happened.
 */
final class InstallTransaction {
    interface Validation { void check(UpdateState state); }
    interface Installer { void commit(File apk, boolean silent) throws IOException; }

    private InstallTransaction() { }

    static void begin(UpdateStore store, Installer installer, File apk, boolean silent, UpdateState.Pending pending,
            UpdateState.Pin pin, long now) throws IOException {
        begin(store, installer, apk, silent, pending, pin, now, state -> {});
    }

    static void begin(UpdateStore store, Installer installer, File apk, boolean silent, UpdateState.Pending pending,
            UpdateState.Pin pin, long now, Validation validation) throws IOException {
        store.mutate(state -> {
            validation.check(state);
            if (state.pending != null) throw new IllegalStateException("An installation is already pending.");
            state.pending = pending;
            // The request is consumed in the same durable write that records the installation it became.
            state.intent = null;
            if (pin != null) state.pin = pin;
            state.lastError = null;
        });
        try { installer.commit(apk, silent); }
        catch (IOException | RuntimeException error) {
            // Android refused before replacing anything. A rollback pin deliberately stays.
            store.tryMutate(state -> {
                state.pending = null;
                UpdateState.Outcome outcome = new UpdateState.Outcome();
                outcome.transactionId = pending.transactionId; outcome.kind = pending.kind; outcome.result = "failed";
                outcome.message = "Android could not start the installation."; outcome.at = now;
                state.lastOutcome = outcome;
            });
            throw error;
        }
    }
}
