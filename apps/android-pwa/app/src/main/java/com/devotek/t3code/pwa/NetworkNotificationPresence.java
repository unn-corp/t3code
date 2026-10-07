package com.devotek.t3code.pwa;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** Ephemeral presence across the phone's paired environments, never a new agent session.
 * Lease durations use the server's clock; elapsed time uses Android's monotonic clock. */
final class NetworkNotificationPresence {
    static final long MAX_LEASE_MS = 45_000;
    private static final class Host {
        long unknownUntil;
        long visibleUntil;
        boolean received;
        Host(long now) { unknownUntil = now + MAX_LEASE_MS; }
    }
    private final Map<String, Host> hosts = new HashMap<>();
    void configure(Set<String> ids, long now) {
        hosts.keySet().retainAll(ids);
        for (String id : ids) hosts.computeIfAbsent(id, key -> new Host(now));
    }
    void update(String id, JSONObject snapshot, long now) {
        Host host = hosts.get(id);
        if (host == null) return;
        long sampled = Iso8601.parse(snapshot.optString("updatedAt"));
        JSONArray leases = snapshot.optJSONArray("leases");
        if (leases == null) throw new IllegalArgumentException("Missing activity leases");
        long until = 0;
        for (int i = 0; i < leases.length(); i++) {
            JSONObject lease = leases.optJSONObject(i);
            if (lease == null || !lease.optBoolean("visible")) continue;
            String state = lease.optString("appState", "active");
            if ("background".equals(state) || "inactive".equals(state)) continue;
            // Focus and recent input do not matter: an idle visible window still suppresses.
            long remaining = Math.max(0, Math.min(MAX_LEASE_MS,
                Iso8601.parse(lease.optString("expiresAt")) - sampled));
            until = Math.max(until, now + remaining);
        }
        host.received = true;
        host.visibleUntil = until;
    }
    boolean ready(long now) {
        for (Host host : hosts.values()) if (!host.received && now < host.unknownUntil) return false;
        return true;
    }
    boolean suppressed(long now) {
        for (Host host : hosts.values()) if (now < host.visibleUntil) return true;
        return false;
    }
}
