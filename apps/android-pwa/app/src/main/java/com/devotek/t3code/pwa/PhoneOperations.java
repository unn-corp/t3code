package com.devotek.t3code.pwa;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Phone work an installation would destroy: browser automation, file transfers, native dialogs,
 * and web uploads. Holds fail closed. Dialogs and uploads have no timeout, because a missing
 * heartbeat does not prove the work stopped; they end only when the work reports it ended, when the
 * shell that owned them is known to be gone, or when the process dies for process-owned work. External Android dialog holds persist across process death.
 * A browser command keeps a lease only because native code bounds every command to 60 seconds.
 */
final class PhoneOperations {
    interface Clock { long now(); }
    interface Commit { void run() throws java.io.IOException; }
    interface Persistence { void save(List<String> nativeOperations); }
    /** The hold lasts until the operation ends or its owner is known to have terminated. */
    static final long UNTIL_ENDED = 0;
    /** Above the 60 second ceiling every native browser command enforces itself. */
    static final long BROWSER_LEASE_MS = 5 * 60_000L;

    static final class Operation {
        final String kind, id;
        final long expiresAt;
        Operation(String kind, String id, long expiresAt) { this.kind = kind; this.id = id; this.expiresAt = expiresAt; }
    }

    private static final PhoneOperations SHARED = new PhoneOperations(System::currentTimeMillis);
    static PhoneOperations shared() { return SHARED; }

    private Persistence persistence = held -> {};
    private boolean installing;
    private boolean foreground;
    private final Clock clock;
    private final Map<String, Operation> active = new HashMap<>();
    PhoneOperations(Clock clock) { this.clock = clock; }

    /** {@code leaseMs} of {@link #UNTIL_ENDED} never expires. */
    synchronized void begin(String kind, String id, long leaseMs) {
        requireOpen();
        persistChange(kind, id, true);
        active.put(kind + ":" + id, new Operation(kind, id, leaseMs <= 0 ? Long.MAX_VALUE : clock.now() + leaseMs));
    }
    synchronized void end(String kind, String id) { persistChange(kind, id, false); active.remove(kind + ":" + id); }
    synchronized void endAll(String kind) { active.keySet().removeIf(key -> key.startsWith(kind + ":")); }

    /** The web shell reports its in-flight upload count; zero releases the hold. Nothing here ever times out. */
    synchronized void setUploads(int count) {
        if (count > 0) requireOpen();
        endAll("upload");
        for (int i = 0; i < Math.min(count, 64); i++) begin("upload", String.valueOf(i), UNTIL_ENDED);
    }

    /** The shell's page was replaced or destroyed, so any upload it owned was cancelled with it. */
    void shellTerminated() { endAll("upload"); }

    synchronized void restoreNative(List<String> holds, Persistence persistence) {
        this.persistence = persistence;
        for (String key : holds) {
            int separator = key.indexOf(':');
            if (separator > 0) active.put(key, new Operation(key.substring(0, separator), key.substring(separator + 1), Long.MAX_VALUE));
        }
    }
    private void persistChange(String kind, String id, boolean add) {
        if ("browser".equals(kind) || "navigation".equals(kind) || "upload".equals(kind)) return;
        List<String> held = new ArrayList<>();
        for (Operation operation : active.values())
            if (!"browser".equals(operation.kind) && !"navigation".equals(operation.kind) && !"upload".equals(operation.kind)) held.add(operation.kind + ":" + operation.id);
        String key = kind + ":" + id;
        held.remove(key);
        if (add) held.add(key);
        persistence.save(held);
    }

    synchronized void requireOpen() {
        if (installing) throw new IllegalStateException("An app installation is in progress. Wait until it finishes.");
    }
    synchronized void foreground(boolean value) { foreground = value; }
    /** Launch admission and operation registration share this monitor. Never stop existing work. */
    synchronized boolean admit(java.util.function.BooleanSupplier ready) {
        if (installing || foreground || !active().isEmpty() || !ready.getAsBoolean()) return false;
        installing = true;
        return true;
    }
    /** Session bytes are already written. Recheck under the launch fence immediately at OS commit. */
    synchronized void commitIfQuiet(java.util.function.BooleanSupplier ready, Commit commit) throws java.io.IOException {
        if (!installing || foreground || !active().isEmpty() || !ready.getAsBoolean())
            throw new java.io.IOException("Phone activity changed before installation.");
        commit.run();
    }
    synchronized void installationPending(boolean value) { installing = value; }

    synchronized List<Operation> active() {
        long now = clock.now();
        active.values().removeIf(operation -> operation.expiresAt <= now);
        return new ArrayList<>(active.values());
    }
}
