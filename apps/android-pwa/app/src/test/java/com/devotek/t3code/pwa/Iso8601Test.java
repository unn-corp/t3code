package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import org.junit.Test;

public final class Iso8601Test {
    @Test public void parsesUtcFractionsAndOffsets() {
        assertEquals(1_790_000_000_000L, Iso8601.parse(Iso8601.format(1_790_000_000_000L)));
        assertEquals(Iso8601.parse("2026-10-05T07:23:00Z"), Iso8601.parse("2026-10-05T09:23:00+02:00"));
        assertEquals(Iso8601.parse("2026-10-05T07:23:00Z") + 120, Iso8601.parse("2026-10-05T07:23:00.12Z"));
    }
    @Test public void rejectsAnythingButFullTimestamps() {
        for (String bad : new String[]{"", "2026-10-05", "2026-13-05T07:23:00Z", "2026-02-31T07:23:00Z", "2026-10-05T25:00:00Z", "yesterday", "2026-10-05T07:23:00"}) {
            try { Iso8601.parse(bad); fail("Accepted " + bad); } catch (IllegalArgumentException expected) { }
        }
    }
}
