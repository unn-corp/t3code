package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import org.junit.Test;

public final class UpdateCapacityTest {
    private static final long GIB = 1024L * 1024L * 1024L;

    @Test public void sameFilesystemBudgetIncludesMissingArtifactsInstallPeakAndMinimumMargin() {
        UpdateCapacity.Snapshot exactlyEnough = new UpdateCapacity.Snapshot(GIB + 350, GIB + 350, true, true);
        UpdateCapacity.Snapshot oneByteShort = new UpdateCapacity.Snapshot(GIB + 349, GIB + 349, true, true);

        assertTrue(UpdateCapacity.canStageUpdate(exactlyEnough, 100, false, 50, false));
        assertFalse(UpdateCapacity.canStageUpdate(oneByteShort, 100, false, 50, false));
        assertTrue(UpdateCapacity.canStageUpdate(new UpdateCapacity.Snapshot(GIB + 200, GIB + 200, true, true), 100, true, 50, true));
    }

    @Test public void separateFilesystemsAreBudgetedIndependently() {
        assertTrue(UpdateCapacity.canStageUpdate(new UpdateCapacity.Snapshot(GIB + 50, GIB + 200, false, true), 100, true, 50, false));
        assertFalse(UpdateCapacity.canStageUpdate(new UpdateCapacity.Snapshot(GIB + 49, GIB + 200, false, true), 100, true, 50, false));
        assertFalse(UpdateCapacity.canStageUpdate(new UpdateCapacity.Snapshot(GIB + 50, GIB + 199, false, true), 100, true, 50, false));
    }

    @Test public void standaloneRecoveryAndBothInstallPhasesReserveSpace() {
        assertTrue(UpdateCapacity.canStageRecovery(new UpdateCapacity.Snapshot(GIB + 300, GIB + 300, true, true), 100, false));
        assertFalse(UpdateCapacity.canStageRecovery(new UpdateCapacity.Snapshot(GIB + 299, GIB + 299, true, true), 100, false));
        assertTrue(UpdateCapacity.canStartInstall(new UpdateCapacity.Snapshot(GIB + 200, GIB + 200, true, true), 100));
        assertTrue(UpdateCapacity.canCommit(new UpdateCapacity.Snapshot(GIB + 100, GIB + 100, true, true), 100));
        assertFalse(UpdateCapacity.canCommit(new UpdateCapacity.Snapshot(GIB + 99, GIB + 99, true, true), 100));
    }

    @Test public void unknownInvalidAndOverflowingCapacityFailClosed() {
        assertFalse(UpdateCapacity.canStartInstall(UpdateCapacity.Snapshot.unknown(), 100));
        assertFalse(UpdateCapacity.canStartInstall(new UpdateCapacity.Snapshot(-1, 100, false, true), 100));
        assertFalse(UpdateCapacity.canStartInstall(new UpdateCapacity.Snapshot(100, 100, true, false), 100));
        assertFalse(UpdateCapacity.canStageRecovery(new UpdateCapacity.Snapshot(100, 100, true, true), 0, false));
        assertEquals(Long.MAX_VALUE, UpdateCapacity.installPeakBytes(Long.MAX_VALUE));
        assertFalse(UpdateCapacity.canStartInstall(new UpdateCapacity.Snapshot(Long.MAX_VALUE, Long.MAX_VALUE, true, true), Long.MAX_VALUE));
        assertFalse(UpdateCapacity.canStageUpdate(new UpdateCapacity.Snapshot(Long.MAX_VALUE, Long.MAX_VALUE, true, true),
                Long.MAX_VALUE, false, 1, false));
    }

    @Test public void marginIsAtLeastOneGiBAndGrowsToTenPercent() {
        assertEquals(GIB, UpdateCapacity.marginBytes(100));
        assertEquals(GIB, UpdateCapacity.marginBytes(10L * GIB));
        assertEquals(3L * GIB, UpdateCapacity.marginBytes(30L * GIB));
    }
}
