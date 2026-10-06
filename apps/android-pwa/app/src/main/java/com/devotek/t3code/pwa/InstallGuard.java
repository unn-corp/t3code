package com.devotek.t3code.pwa;

import java.util.ArrayList;
import java.util.List;

/**
 * The phone-side safety rules for replacing this app. Remote agents may keep running on their hosts,
 * so only this phone's own work counts: foreground use, browser automation, uploads, and native dialogs.
 * Unknown state blocks; the guard never guesses that it is safe.
 */
final class InstallGuard {
    /** The app must stay out of the foreground this long before an automatic installation. */
    static final long BACKGROUND_QUIET_MS = 2 * 60_000L;

    static final class Blocker {
        final String reason, label;
        final long retryAfterMs;
        Blocker(String reason, String label, long retryAfterMs) { this.reason = reason; this.label = label; this.retryAfterMs = retryAfterMs; }
    }

    static final class Input {
        boolean foreground;
        /** Epoch millis when the app last left the foreground; 0 means foreground or unknown. */
        long backgroundSince;
        long now;
        List<PhoneOperations.Operation> operations = new ArrayList<>();
        boolean installPermission = true;
        boolean confirmationAvailable = true;
        boolean recoveryReady = true;
        boolean pending;
        boolean supported = true;
        boolean uncertainState;
    }

    private InstallGuard() { }

    static List<Blocker> blockers(Input input) {
        List<Blocker> blockers = new ArrayList<>();
        if (input.uncertainState) blockers.add(new Blocker("unknown-participant", "Updater safety state was recovered from an older backup. Restart the phone, finish any pending installer, then review update settings.", 0));
        if (!input.supported) blockers.add(new Blocker("bootstrap", "This Android version cannot verify updates in the app.", 0));
        if (input.pending) blockers.add(new Blocker("transaction", "An installation is already in progress.", 0));
        if (!input.recoveryReady) blockers.add(new Blocker("bootstrap", "A verified recovery build is not cached yet.", 0));
        if (!input.confirmationAvailable) blockers.add(new Blocker("authorization", "Enable App updates notifications in Android settings so installation confirmation can reach you.", 0));
        if (!input.installPermission) blockers.add(new Blocker("authorization", "Allow T3 Code to install updates in Android settings.", 0));
        // No caller bypasses the quiet wait: a person's Install or Recovery request waits like an automatic one.
        if (input.foreground) blockers.add(new Blocker("idle-window", "T3 Code is open on the phone.", InstallGuard.BACKGROUND_QUIET_MS));
        else if (input.backgroundSince <= 0 || input.backgroundSince > input.now) {
            // Foreground state could not be proven, for example after the process was killed while open.
            blockers.add(new Blocker("idle-window", "Waiting for the app to stay in the background for 2 minutes.", BACKGROUND_QUIET_MS));
        } else if (input.now - input.backgroundSince < BACKGROUND_QUIET_MS) {
            blockers.add(new Blocker("idle-window", "Waiting for the app to stay in the background for 2 minutes.",
                BACKGROUND_QUIET_MS - (input.now - input.backgroundSince)));
        }
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (PhoneOperations.Operation operation : input.operations) {
            String reason = ("browser".equals(operation.kind) || "navigation".equals(operation.kind)) ? "commands" : "upload".equals(operation.kind) ? "uploads" : "input-active";
            if (!seen.add(reason)) continue;
            String label = "commands".equals(reason) ? "A phone browser command or page navigation is running."
                : "uploads".equals(reason) ? "A file transfer or voice input is in progress." : "A phone dialog, Android settings screen, or file transfer is open.";
            blockers.add(new Blocker(reason, label, Math.max(0, operation.expiresAt - input.now)));
        }
        return blockers;
    }
}
