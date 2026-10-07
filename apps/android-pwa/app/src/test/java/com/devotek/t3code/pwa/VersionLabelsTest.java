package com.devotek.t3code.pwa;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public final class VersionLabelsTest {
    @Test public void keepsT3VersionSeparateFromForkNightlyAndAndroidCode() {
        assertEquals("0.0.45 · Arcwright build 35 · Nightly", VersionLabels.format("1.0.1-nightly.20261007.35", "0.0.45", 35));
    }
    @Test public void presentsLegacyBuildWithoutItsVersionSuffix() {
        assertEquals("0.0.45 · Arcwright build 4 · Legacy", VersionLabels.format("0.0.45-fork.4", "", 0));
    }
    @Test public void doesNotInferUnknownUpstreamProvenance() {
        assertEquals("Arcwright build 31 · Nightly", VersionLabels.format("1.0.1-nightly.20261006.31", "", 0));
        assertEquals("dev", VersionLabels.format("dev", "", 0));
    }
    @Test public void stableUsesTheForkCounter() {
        assertEquals("0.0.45 · Arcwright build 36 · Stable", VersionLabels.format("1.0.1", "0.0.45", 36));
    }
}
