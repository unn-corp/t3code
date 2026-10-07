package com.devotek.t3code.pwa;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Crash-safe persistence for {@link UpdateState}: write a temp file, fsync it, then rename. A failed
 * write throws and leaves the previous state in place, so callers that must persist before acting
 * (the installer hand-off) stop instead of proceeding on memory alone.
 */
final class UpdateStore {
    interface Mutation { void apply(UpdateState state); }
    interface BeforeCommit { void run() throws IOException; }

    private final File file, backup, temp, backupTemp;
    private final BeforeCommit beforeCommit;
    private UpdateState state;

    private UpdateStore(File directory, BeforeCommit beforeCommit) {
        file = new File(directory, "state.json"); backup = new File(directory, "state.json.bak"); temp = new File(directory, "state.json.tmp");
        backupTemp = new File(directory, "state.json.bak.tmp");
        this.beforeCommit = beforeCommit;
    }

    static UpdateStore open(File directory) throws IOException {
        return open(directory, () -> { });
    }

    /** The checkpoint lets process-death tests interrupt the write without changing filesystem semantics. */
    static UpdateStore open(File directory, BeforeCommit beforeCommit) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create updater storage");
        UpdateStore store = new UpdateStore(directory, beforeCommit);
        UpdateState loaded = read(store.file);
        if (loaded == null) {
            boolean uncertain = store.file.exists() || store.backup.exists();
            loaded = read(store.backup);
            if (loaded == null) loaded = new UpdateState();
            // A backup is one mutation behind: a pending session or external dialog may be missing.
            if (uncertain) {
                loaded.automatic = false; loaded.recoveredFromCorruption = true;
                loaded.corruptionBoot = -1;
                loaded.lastError = "Updater safety state was unreadable. Restart the phone, finish any pending installer, then review update settings.";
            }
        }
        store.state = loaded;
        return store;
    }

    private static UpdateState read(File source) {
        if (!source.isFile() || source.length() > 1_048_576) return null;
        try (FileInputStream input = new FileInputStream(source)) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
            return UpdateState.from(new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8)));
        } catch (IOException | JSONException | RuntimeException error) { return null; }
    }

    synchronized UpdateState snapshot() { return state.copy(); }

    /** Applies the change to a copy, persists it durably, and only then publishes it. */
    synchronized UpdateState mutate(Mutation mutation) throws IOException {
        UpdateState next = state.copy();
        mutation.apply(next);
        byte[] bytes;
        try { bytes = next.toJson().toString().getBytes(StandardCharsets.UTF_8); }
        catch (JSONException error) { throw new IOException("Cannot encode updater state", error); }
        writeAndSync(temp, bytes);
        if (file.exists()) {
            // Never move the primary away: Android kills this process during replacement, including
            // lifecycle writes. Keep the committed primary readable until one atomic rename replaces it.
            // Encode the last committed state so a recovered, damaged primary cannot overwrite a good backup.
            try { writeAndSync(backupTemp, state.toJson().toString().getBytes(StandardCharsets.UTF_8)); }
            catch (JSONException error) { throw new IOException("Cannot encode updater backup", error); }
            if (!backupTemp.renameTo(backup)) throw new IOException("Cannot commit updater backup");
        }
        beforeCommit.run();
        // Same-directory POSIX rename replaces the existing file atomically on Android. No delete fallback.
        if (!temp.renameTo(file)) throw new IOException("Cannot commit updater state");
        state = next;
        return next.copy();
    }

    private static void writeAndSync(File destination, byte[] bytes) throws IOException {
        try (FileOutputStream output = new FileOutputStream(destination)) {
            output.write(bytes); output.flush(); output.getFD().sync();
        }
    }

    /** Match ownership while holding the same lock as persistence. A stale callback has no effects. */
    synchronized boolean tryMutatePending(String transaction, Mutation mutation) {
        if (transaction == null || state.pending == null || !transaction.equals(state.pending.transactionId)) return false;
        try { mutate(mutation); return true; } catch (IOException | RuntimeException ignored) { return false; }
    }

    /** Best-effort write for bookkeeping that must never block the UI thread's lifecycle callbacks. */
    synchronized void tryMutate(Mutation mutation) {
        try { mutate(mutation); } catch (IOException | RuntimeException ignored) { /* Next lifecycle event retries. */ }
    }
}
