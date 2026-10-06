package com.devotek.t3code.pwa;

import static org.junit.Assert.*;
import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class RecoveryCacheTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private static UpdateState.Recovery entry(String sha, long code) {
        UpdateState.Recovery entry = new UpdateState.Recovery(); entry.sha256 = sha; entry.versionCode = code; entry.cachedAt = code;
        return entry;
    }
    private static List<String> digests(List<UpdateState.Recovery> list) {
        List<String> out = new ArrayList<>();
        for (UpdateState.Recovery entry : list) out.add(entry.sha256);
        Collections.sort(out);
        return out;
    }

    @Test public void keepsTheTwoNewestPreviousBuilds() {
        List<UpdateState.Recovery> entries = Arrays.asList(entry("a", 10), entry("b", 30), entry("c", 20), entry("d", 5));
        assertEquals(Arrays.asList("a", "d"), digests(RecoveryCache.evictable(entries, new HashSet<>())));
    }
    @Test public void neverEvictsABuildAnInstallReferences() {
        List<UpdateState.Recovery> entries = Arrays.asList(entry("a", 10), entry("b", 30), entry("c", 20), entry("d", 5));
        // The two newest (b, c) stay, and the referenced d stays in addition to them.
        assertEquals(Collections.singletonList("a"), digests(RecoveryCache.evictable(entries, new HashSet<>(Collections.singleton("d")))));
    }
    @Test public void collapsesDuplicateDigestsAndKeepsSmallCachesWhole() {
        assertEquals(Collections.singletonList("a"), digests(RecoveryCache.evictable(Arrays.asList(entry("a", 1), entry("a", 1)), new HashSet<>())));
        assertTrue(RecoveryCache.evictable(Arrays.asList(entry("a", 1), entry("b", 2)), new HashSet<>()).isEmpty());
        assertTrue(RecoveryCache.evictable(new ArrayList<>(), new HashSet<>()).isEmpty());
    }
    @Test public void findsInterruptedDownloadsThatNothingReferences() throws Exception {
        File dir = folder.newFolder("cache");
        assertTrue(new File(dir, "keep.apk").createNewFile());
        assertTrue(new File(dir, "abc.part").createNewFile());
        List<File> orphans = RecoveryCache.orphans(dir, new HashSet<>(Collections.singleton("keep.apk")));
        assertEquals(1, orphans.size());
        assertEquals("abc.part", orphans.get(0).getName());
        assertTrue(RecoveryCache.orphans(new File(dir, "missing"), new HashSet<>()).isEmpty());
    }
}
