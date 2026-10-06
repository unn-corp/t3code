package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public final class InstallGuardTest {
    private static final long NOW = 10_000_000L;

    private static InstallGuard.Input clear() {
        InstallGuard.Input input = new InstallGuard.Input();
        input.now = NOW; input.backgroundSince = NOW - InstallGuard.BACKGROUND_QUIET_MS - 1;
        return input;
    }
    private static List<String> reasons(InstallGuard.Input input) {
        List<String> reasons = new ArrayList<>();
        for (InstallGuard.Blocker blocker : InstallGuard.blockers(input)) reasons.add(blocker.reason);
        return reasons;
    }

    @Test public void installsOnlyAfterTwoQuietMinutesInTheBackground() {
        assertTrue(reasons(clear()).isEmpty());
        InstallGuard.Input foreground = clear(); foreground.foreground = true;
        assertEquals("idle-window", reasons(foreground).get(0));
        InstallGuard.Input recent = clear(); recent.backgroundSince = NOW - 119_999;
        List<InstallGuard.Blocker> blockers = InstallGuard.blockers(recent);
        assertEquals("idle-window", blockers.get(0).reason);
        assertEquals(1, blockers.get(0).retryAfterMs);
        InstallGuard.Input exact = clear(); exact.backgroundSince = NOW - InstallGuard.BACKGROUND_QUIET_MS;
        assertTrue(reasons(exact).isEmpty());
    }
    @Test public void staleSafetyStateBlocksEvenAfterTheQuietWindow() {
        InstallGuard.Input input = clear(); input.uncertainState = true;
        assertEquals("unknown-participant", reasons(input).get(0));
    }
    @Test public void unknownForegroundStateBlocks() {
        InstallGuard.Input unknown = clear(); unknown.backgroundSince = 0;
        assertEquals("idle-window", reasons(unknown).get(0));
        InstallGuard.Input skewed = clear(); skewed.backgroundSince = NOW + 60_000;
        assertEquals("idle-window", reasons(skewed).get(0));
    }
    @Test public void noRequestBypassesTheQuietWaitOrRunningPhoneWork() {
        // The guard has no manual mode: a person's Install or Recovery request is evaluated exactly like an automatic one.
        InstallGuard.Input foreground = clear(); foreground.foreground = true; foreground.backgroundSince = 0;
        assertEquals("idle-window", reasons(foreground).get(0));
        InstallGuard.Input busy = clear();
        busy.operations.add(new PhoneOperations.Operation("browser", "1", NOW + 5000));
        assertEquals("commands", reasons(busy).get(0));
    }
    @Test public void phoneWorkMapsToItsOwnReason() {
        InstallGuard.Input input = clear();
        input.operations.add(new PhoneOperations.Operation("browser", "1", NOW + 1));
        input.operations.add(new PhoneOperations.Operation("upload", "0", NOW + 1));
        input.operations.add(new PhoneOperations.Operation("upload", "1", NOW + 1));
        input.operations.add(new PhoneOperations.Operation("file-chooser", "picker", NOW + 1));
        input.operations.add(new PhoneOperations.Operation("permission", "media", NOW + 1));
        List<String> reasons = reasons(input);
        assertEquals(java.util.Arrays.asList("commands", "uploads", "input-active"), reasons);
    }
    @Test public void missingConfirmationDeliveryBlocksBeforeAnOsSessionStarts() {
        InstallGuard.Input input = clear(); input.confirmationAvailable = false;
        assertEquals("authorization", reasons(input).get(0));
    }
    @Test public void missingPrerequisitesBlockWithoutGuessing() {
        InstallGuard.Input input = clear();
        input.installPermission = false; input.recoveryReady = false; input.pending = true; input.supported = false;
        List<String> reasons = reasons(input);
        assertTrue(reasons.contains("authorization"));
        assertTrue(reasons.contains("transaction"));
        assertTrue(reasons.contains("bootstrap"));
    }

    @Test public void browserCommandsKeepABoundedLeaseBecauseNativeCodeBoundsThem() {
        long[] clock = {1000};
        PhoneOperations operations = new PhoneOperations(() -> clock[0]);
        operations.begin("browser", "7", 500);
        assertEquals(1, operations.active().size());
        clock[0] = 1499;
        assertEquals(1, operations.active().size());
        clock[0] = 1500;
        assertTrue(operations.active().isEmpty());
    }
    @Test public void endedOperationsReleaseImmediately() {
        PhoneOperations operations = new PhoneOperations(() -> 0);
        operations.begin("browser", "1", 100); operations.begin("browser", "2", 100);
        operations.end("browser", "1");
        assertEquals("2", operations.active().get(0).id);
        operations.end("browser", "unknown");
        assertEquals(1, operations.active().size());
    }
    @Test public void aVanishedShellHeartbeatNeverReleasesAnUnfinishedUpload() {
        long[] clock = {0};
        PhoneOperations operations = new PhoneOperations(() -> clock[0]);
        operations.setUploads(2);
        clock[0] = 365L * 24 * 60 * 60_000L; // a year without any heartbeat
        assertEquals("only the end of the work or of its owner may release it", 2, operations.active().size());
    }
    @Test public void dialogsAlsoHoldUntilTheyEnd() {
        long[] clock = {0};
        PhoneOperations operations = new PhoneOperations(() -> clock[0]);
        operations.begin("file-chooser", "picker", PhoneOperations.UNTIL_ENDED);
        clock[0] = 24L * 60 * 60_000L;
        assertEquals(1, operations.active().size());
        operations.end("file-chooser", "picker");
        assertTrue(operations.active().isEmpty());
    }
    @Test public void uploadsAreReleasedWhenTheShellIsKnownToBeGone() {
        PhoneOperations operations = new PhoneOperations(() -> 0);
        operations.setUploads(3);
        operations.begin("browser", "1", 100);
        operations.shellTerminated();
        assertEquals("browser", operations.active().get(0).kind);
        assertEquals(1, operations.active().size());
    }
    @Test public void webUploadReportsReplaceThePreviousCount() {
        PhoneOperations operations = new PhoneOperations(() -> 0);
        operations.setUploads(3);
        assertEquals(3, operations.active().size());
        operations.setUploads(1);
        assertEquals(1, operations.active().size());
        operations.setUploads(0);
        assertTrue(operations.active().isEmpty());
    }
    @Test public void admissionNeverInterruptsExistingWorkAndRejectsNewWork() {
        PhoneOperations operations = new PhoneOperations(() -> 0);
        operations.setUploads(1);
        assertFalse(operations.admit(() -> true));
        assertEquals(1, operations.active().size());
        operations.setUploads(0);
        operations.foreground(true);
        assertFalse(operations.admit(() -> true));
        operations.foreground(false);
        assertTrue(operations.admit(() -> true));
        assertThrows(IllegalStateException.class, () -> operations.setUploads(1));
        assertThrows(IllegalStateException.class, () -> operations.begin("browser", "late", 100));
        operations.installationPending(false);
        operations.begin("browser", "retry", 100);
        assertEquals(1, operations.active().size());
    }
    @Test public void pendingInstallationAfterRestartKeepsLaunchesFenced() {
        PhoneOperations operations = new PhoneOperations(() -> 0);
        operations.installationPending(true);
        assertThrows(IllegalStateException.class, operations::requireOpen);
        operations.setUploads(0);
        operations.shellTerminated();
        assertThrows(IllegalStateException.class, operations::requireOpen);
    }
    @Test public void externalDialogSurvivesAProcessRestartUntilItsResult() {
        java.util.List<String> persisted = new java.util.ArrayList<>();
        PhoneOperations first = new PhoneOperations(() -> 0);
        first.restoreNative(persisted, held -> { persisted.clear(); persisted.addAll(held); });
        first.begin("save-file", "download", PhoneOperations.UNTIL_ENDED);
        PhoneOperations restarted = new PhoneOperations(() -> 9999999);
        restarted.restoreNative(persisted, held -> { persisted.clear(); persisted.addAll(held); });
        assertFalse(restarted.admit(() -> true));
        assertEquals("save-file", restarted.active().get(0).kind);
        restarted.end("save-file", "download");
        assertTrue(persisted.isEmpty());
        assertTrue(restarted.admit(() -> true));
    }
    @Test public void reopeningDuringSessionStreamingPreventsTheOsCommit() throws Exception {
        PhoneOperations operations = new PhoneOperations(() -> 0);
        assertTrue(operations.admit(() -> true));
        operations.foreground(true);
        boolean[] committed = {false};
        assertThrows(java.io.IOException.class, () -> operations.commitIfQuiet(() -> true, () -> committed[0] = true));
        assertFalse(committed[0]);
        operations.foreground(false);
        operations.commitIfQuiet(() -> true, () -> committed[0] = true);
        assertTrue(committed[0]);
    }
}
