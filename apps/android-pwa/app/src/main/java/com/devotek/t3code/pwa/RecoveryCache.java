package com.devotek.t3code.pwa;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Retention for verified recovery APKs: the two newest previous builds, plus anything an install references. */
final class RecoveryCache {
    static final int KEEP = 2;
    private RecoveryCache() { }

    /** Entries that may be deleted. Duplicates by digest are collapsed first; protected digests always stay. */
    static List<UpdateState.Recovery> evictable(List<UpdateState.Recovery> entries, Set<String> protectedDigests) {
        List<UpdateState.Recovery> sorted = new ArrayList<>(entries);
        sorted.sort((a, b) -> a.versionCode != b.versionCode ? Long.compare(b.versionCode, a.versionCode) : Long.compare(b.cachedAt, a.cachedAt));
        Set<String> seen = new HashSet<>();
        List<UpdateState.Recovery> evict = new ArrayList<>();
        int kept = 0;
        for (UpdateState.Recovery entry : sorted) {
            boolean duplicate = !seen.add(entry.sha256);
            if (protectedDigests.contains(entry.sha256) && !duplicate) continue;
            if (!duplicate && kept < KEEP) { kept++; continue; }
            evict.add(entry);
        }
        return evict;
    }

    /** Files in the cache directory that no state entry references, such as an interrupted download. */
    static List<File> orphans(File directory, Set<String> referencedFiles) {
        File[] files = directory.listFiles();
        if (files == null) return Collections.emptyList();
        List<File> orphans = new ArrayList<>();
        for (File file : files) if (file.isFile() && !referencedFiles.contains(file.getName())) orphans.add(file);
        return orphans;
    }
}
