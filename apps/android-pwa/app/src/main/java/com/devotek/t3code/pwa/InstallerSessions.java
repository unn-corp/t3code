package com.devotek.t3code.pwa;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Exact local confirmation of orphaned installer sessions, never arbitrary package-manager IDs. */
final class InstallerSessions {
    static final class Session {
        final int id;
        final long createdAt;
        final String installer, target;
        final boolean active;
        Session(int id, long createdAt, String installer, String target, boolean active) {
            this.id = id; this.createdAt = createdAt; this.installer = installer; this.target = target; this.active = active;
        }
    }
    static String refusal(List<Session> confirmed, List<Session> fresh, String ownPackage, boolean pending) {
        if (pending) return "Finish the recorded Android installation first.";
        if (confirmed.isEmpty() || confirmed.size() != fresh.size()) return "The unfinished installation list changed. Review it again.";
        Set<Integer> ids = new HashSet<>();
        for (Session selected : confirmed) {
            if (!ids.add(selected.id)) return "An installation was selected twice.";
            Session current = null;
            for (Session entry : fresh) if (entry.id == selected.id) current = entry;
            if (current == null || current.createdAt != selected.createdAt) return "The unfinished installation list changed. Review it again.";
            if (!ownPackage.equals(current.installer) || !ownPackage.equals(current.target)) return "The installation does not belong to Arcwright Code.";
            if (current.active) return "Android is still using that installation. Wait for it to finish.";
        }
        return null;
    }
    private InstallerSessions() { }
}
