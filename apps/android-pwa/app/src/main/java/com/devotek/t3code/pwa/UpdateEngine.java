package com.devotek.t3code.pwa;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Build;
import androidx.core.content.IntentCompat;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Orchestrates the native updater: discovery, verified staging, the install guard, the PackageInstaller
 * hand-off, and recovery. One instance owns all update work in the process, serialized by a lock, so the
 * launch check, the WorkManager job, and a tap on Install can never overlap.
 */
final class UpdateEngine {
    /** INTENT only applies a pending install request or staged update; it never reaches the network for discovery. */
    enum Trigger { LAUNCH, WORKER, MANUAL, INTENT }

    /** A failure whose message is safe to show the user. */
    static class UpdateException extends Exception { UpdateException(String message) { super(message); } }

    private static final long LAUNCH_INTERVAL_MS = 10 * 60_000L;
    private static final long CANCEL_DEFER_MS = 24 * 60 * 60_000L;
    private static final long OUTCOME_VISIBLE_MS = 24 * 60 * 60_000L;
    private static final int MANIFESTS_PER_CHECK = 6;
    static final String EXTRA_TRANSACTION = "t3.updater.transaction";

    @android.annotation.SuppressLint("StaticFieldLeak") // Holds the application context only.
    private static UpdateEngine instance;
    static synchronized UpdateEngine get(Context context) {
        if (instance == null) instance = new UpdateEngine(context.getApplicationContext());
        return instance;
    }

    private static final class Candidate {
        final UpdateEligibility.Decision decision;
        final String manifestSha256;
        Candidate(UpdateEligibility.Decision decision, String manifestSha256) { this.decision = decision; this.manifestSha256 = manifestSha256; }
    }

    private final Context app;
    private final File apkDir, recoveryDir;
    private final UpdateStore store;
    private final String storeError;
    private final ReleaseClient client = new ReleaseClient();
    private final PhoneOperations operations = PhoneOperations.shared();
    private final ReentrantLock busy = new ReentrantLock();
    private final CopyOnWriteArrayList<Runnable> listeners = new CopyOnWriteArrayList<>();
    private volatile String activity;
    private volatile Candidate available;
    private UpdateEligibility.Installed installedCache;
    private String pairedRecoveryReadinessCacheKey;
    private boolean pairedRecoveryReadinessCached;
    private boolean pairedRecoveryReadinessValue;
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(task -> {
        Thread thread = new Thread(task, "t3-updater-recheck"); thread.setDaemon(true); return thread;
    });
    private ScheduledFuture<?> recheck;

    private UpdateEngine(Context context) {
        app = context;
        File root = new File(context.getNoBackupFilesDir(), "updates");
        apkDir = new File(root, "apks"); recoveryDir = new File(root, "recovery");
        UpdateStore opened = null; String error = null;
        try { opened = UpdateStore.open(new File(root, "state")); apkDir.mkdirs(); recoveryDir.mkdirs(); }
        catch (IOException failure) { error = "Updater storage is unavailable."; }
        store = opened; storeError = error;
        operations.installationPending(store != null && store.snapshot().pending != null);
        if (store != null) {
            int boot = android.provider.Settings.Global.getInt(app.getContentResolver(), android.provider.Settings.Global.BOOT_COUNT, -1);
            UpdateState initial = store.snapshot();
            if (initial.recoveredFromCorruption && initial.corruptionBoot < 0 && boot >= 0)
                store.tryMutate(state -> state.corruptionBoot = boot);
            if (boot >= 0 && initial.nativeOperationsBoot >= 0 && boot != initial.nativeOperationsBoot) {
                store.tryMutate(state -> state.nativeOperations.clear());
            }
            operations.restoreNative(store.snapshot().nativeOperations, held -> {
                try { store.mutate(state -> { state.nativeOperations = new ArrayList<>(held); state.nativeOperationsBoot = boot; }); }
                catch (IOException errorSaving) { throw new IllegalStateException("Could not record the phone operation safely.", errorSaving); }
            });
        }
    }

    void addListener(Runnable listener) { listeners.add(listener); }
    void removeListener(Runnable listener) { listeners.remove(listener); }
    private void changed() { for (Runnable listener : listeners) listener.run(); }
    private static long now() { return System.currentTimeMillis(); }

    private static String sourceChannel(String version) {
        return version != null && version.matches(".*-nightly\\.\\d{8}\\.\\d+") ? "nightly" : "stable";
    }

    private UpdateState.Identity runningIdentity(UpdateState state) {
        UpdateState.Identity identity = state == null ? null : state.identity;
        if (identity != null && identity.versionCode == runningVersionCode()
                && !identity.version.isEmpty() && !identity.commit.isEmpty()) return identity;
        UpdateState.Identity fallback = new UpdateState.Identity();
        fallback.version = BuildConfig.SOURCE_VERSION;
        fallback.commit = BuildConfig.SOURCE_COMMIT;
        fallback.channel = defaultChannel();
        fallback.versionCode = runningVersionCode();
        return fallback;
    }

    // ---- lifecycle ---------------------------------------------------------------------------

    UpdateEligibility.Installed installed() {
        if (installedCache == null) installedCache = ApkVerifier.installed(app);
        return installedCache;
    }
    boolean supported() { return store != null && Build.VERSION.SDK_INT >= 28 && installed() != null; }

    private long runningVersionCode() {
        UpdateEligibility.Installed installed = installed();
        if (installed != null) return installed.versionCode;
        try {
            PackageInfo info = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        } catch (PackageManager.NameNotFoundException error) { return 0; }
    }

    private String defaultChannel() {
        try {
            PackageInfo info = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
            return UpdateEligibility.defaultChannel(info.firstInstallTime, info.lastUpdateTime);
        } catch (PackageManager.NameNotFoundException error) { return "stable"; }
    }

    private UpdateReconciler.Running running(UpdateState state) throws IOException {
        long code = runningVersionCode();
        // Hashing the APK is the expensive part, so it only happens when an identity must be proven.
        boolean needDigest = state.pending != null || state.identity == null || state.identity.versionCode != code
            || state.identity.artifactSha256.isEmpty();
        String digest = needDigest ? ApkVerifier.sha256(new File(app.getApplicationInfo().sourceDir)) : state.identity.artifactSha256;
        return new UpdateReconciler.Running(BuildConfig.SOURCE_VERSION, BuildConfig.SOURCE_COMMIT, code, digest);
    }

    /**
     * Runs before any WebView exists. Returns true when native recovery must open instead of the app.
     * {@code bypass} is the user choosing to continue from recovery.
     */
    boolean startup(boolean bypass) {
        if (store == null) return false;
        boolean[] recover = {false};
        try {
            UpdateReconciler.Running running = running(store.snapshot());
            store.mutate(state -> {
                UpdateReconciler.reconcile(state, running, defaultChannel(), now(), abandonExpiredSession(running));
                if (bypass) { state.forceRecovery = false; state.unhealthyLaunches = 0; }
                if (state.pending != null || state.recoveryRequired()) recover[0] = true; else state.unhealthyLaunches++;
            });
        } catch (IOException | RuntimeException error) { return false; }
        operations.installationPending(store.snapshot().pending != null);
        return recover[0];
    }

    /** Records which build is running after a package replacement, without counting a launch. */
    void reconcile() {
        if (store == null) return;
        UpdateReconciler.Result[] result = {UpdateReconciler.Result.NONE};
        try {
            UpdateReconciler.Running running = running(store.snapshot());
            store.mutate(state -> result[0] = UpdateReconciler.reconcile(state, running, defaultChannel(), now(), abandonExpiredSession(running)));
        } catch (IOException | RuntimeException ignored) { /* The next launch reconciles again. */ }
        operations.installationPending(store.snapshot().pending != null);
        if (result[0] == UpdateReconciler.Result.VERIFIED) UpdateNotifications.clear(app);
        // The user may never open the app after a bad install, so offer recovery where they will see it.
        if (result[0] == UpdateReconciler.Result.IDENTITY_MISMATCH || result[0] == UpdateReconciler.Result.INSTALL_ABANDONED) UpdateNotifications.failure(app);
        changed();
    }

    /** A timeout alone cannot prove an OS installer stopped. Abandon its recorded session first. */
    private boolean abandonExpiredSession(UpdateReconciler.Running running) {
        UpdateState.Pending pending = store.snapshot().pending;
        if (pending == null || running.versionCode != pending.previousVersionCode || now() - pending.startedAt <= UpdateReconciler.ABANDON_MS) return false;
        if (pending.sessionId < 0) return true; // No session could have been committed before its id was durable.
        try {
            PackageInstaller installer = app.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionInfo session = installer.getSessionInfo(pending.sessionId);
            if (session != null) {
                if (!app.getPackageName().equals(session.getInstallerPackageName())) return false;
                installer.abandonSession(pending.sessionId);
            }
            return installer.getSessionInfo(pending.sessionId) == null;
        } catch (RuntimeException error) { return false; } // Unknown OS state keeps the phone-work fence.
    }

    /** The bundled shell rendered and said so through the bridge, so this build is not crash-looping. */
    void healthy() {
        if (store != null) store.tryMutate(state -> { state.unhealthyLaunches = 0; state.forceRecovery = false; state.shellReportsHealth = true; });
        changed();
    }

    /** Called from every activity of the app, so the recovery screen counts as the app being open. */
    void foreground(boolean visible) {
        operations.foreground(MainActivity.visible || RecoveryActivity.visible);
        if (store == null) return;
        store.tryMutate(state -> state.backgroundSince = visible ? 0 : now());
        if (!visible) {
            UpdateState state = store.snapshot();
            // Leaving the app starts the quiet wait; look again when it can have passed.
            if (state.intent != null || (state.automatic && state.target != null)) scheduleRecheck(InstallGuard.BACKGROUND_QUIET_MS + 2000);
        }
    }

    boolean recoveryRequired() { return store != null && store.snapshot().recoveryRequired(); }
    /** A copy of the persisted state, or null when updater storage is unavailable. */
    UpdateState snapshot() { return store == null ? null : store.snapshot(); }

    // ---- policy ------------------------------------------------------------------------------

    void configure(String channel, Boolean automatic) throws UpdateException {
        if (store == null) throw new UpdateException(storeError);
        if (channel != null && !"stable".equals(channel) && !"nightly".equals(channel)) throw new UpdateException("Unknown update channel.");
        UpdateState before = store.snapshot();
        if (before.recoveredFromCorruption) {
            int boot = android.provider.Settings.Global.getInt(app.getContentResolver(), android.provider.Settings.Global.BOOT_COUNT, -1);
            boolean sessionsClosed;
            try { sessionsClosed = app.getPackageManager().getPackageInstaller().getMySessions().isEmpty(); }
            catch (RuntimeException error) { sessionsClosed = false; }
            if (boot < 0 || before.corruptionBoot < 0 || boot == before.corruptionBoot || !sessionsClosed)
                throw new UpdateException("Restart the phone and finish any pending installer before reviewing recovered update settings.");
        }
        try {
            store.mutate(state -> {
                if (channel != null) {
                    state.channel = channel;
                    if ("stable".equals(channel) && state.target != null && "nightly".equals(state.target.channel)) state.target = null;
                }
                if (automatic != null) state.automatic = automatic;
                // Review is admitted only after a proven reboot and no surviving installer sessions.
                state.recoveredFromCorruption = false;
            });
        } catch (IOException error) { throw new UpdateException("Could not save update settings."); }
        available = null;
        changed();
    }

    void pinCurrent() throws UpdateException {
        if (store == null) throw new UpdateException(storeError);
        ensureIdentityDigest();
        try {
            store.mutate(state -> {
                UpdateState.Pin pin = new UpdateState.Pin();
                pin.versionCode = runningVersionCode(); pin.reason = "manual";
                if (state.identity != null) { pin.version = state.identity.version; pin.commit = state.identity.commit; pin.artifactSha256 = state.identity.artifactSha256; }
                state.intent = null;
                state.pin = pin;
            });
        } catch (IOException error) { throw new UpdateException("Could not save the pin."); }
        changed();
    }

    void resume() throws UpdateException {
        if (store == null) throw new UpdateException(storeError);
        try { store.mutate(state -> { state.pin = null; state.deferUntil = 0; state.forceRecovery = false; }); }
        catch (IOException error) { throw new UpdateException("Could not resume updates."); }
        changed();
    }

    // ---- check and stage ---------------------------------------------------------------------

    private boolean metered() {
        ConnectivityManager manager = app.getSystemService(ConnectivityManager.class);
        return manager == null || manager.isActiveNetworkMetered();
    }
    private boolean online() {
        ConnectivityManager manager = app.getSystemService(ConnectivityManager.class);
        if (manager == null || manager.getActiveNetwork() == null) return false;
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    /** Discovers, stages, and applies a pending request or automatic install when every guard allows. Never throws. */
    void run(Trigger trigger) {
        if (store == null || !supported()) return;
        try {
            if (!busy.tryLock(trigger == Trigger.MANUAL ? 3 : 0, TimeUnit.SECONDS)) return;
        } catch (InterruptedException error) { Thread.currentThread().interrupt(); return; }
        try {
            ensureIdentityDigest();
            UpdateState state = store.snapshot();
            if (state.pending != null) return;
            if (trigger == Trigger.INTENT || (trigger == Trigger.LAUNCH && now() - state.lastCheckedAt < LAUNCH_INTERVAL_MS)) { apply(); return; }
            if (!online()) { remember("Offline. Updates are checked when the phone reconnects."); apply(); return; }
            activity = "checking"; changed();
            try { stage(trigger, state); }
            catch (IOException error) { remember("Could not check for updates: " + safe(error)); }
            catch (UpdateException error) { remember(error.getMessage()); }
            finally { activity = null; }
            apply();
        } finally { busy.unlock(); changed(); }
    }

    private static String safe(Exception error) { return error.getMessage() == null ? "network error" : error.getMessage(); }
    private void remember(String message) { if (store != null) store.tryMutate(state -> state.lastError = message); }

    private void ensureIdentityDigest() {
        try {
            UpdateState state = store.snapshot();
            if (state.identity != null && state.identity.versionCode == runningVersionCode() && state.identity.artifactSha256.isEmpty()) {
                String digest = ApkVerifier.sha256(new File(app.getApplicationInfo().sourceDir));
                store.tryMutate(next -> { if (next.identity != null && next.identity.artifactSha256.isEmpty()) next.identity.artifactSha256 = digest; });
            }
        } catch (IOException ignored) { /* Retried on the next check. */ }
    }

    private List<Candidate> discover(UpdateEligibility.Installed installed, UpdateState state) throws IOException {
        List<ReleaseRef> releases = client.list();
        List<Candidate> found = new ArrayList<>();
        int fetched = 0, failed = 0;
        for (ReleaseRef release : releases) {
            if (release.draft || release.asset(ReleaseManifest.ASSET_NAME) == null) continue;
            if (++fetched > MANIFESTS_PER_CHECK) break;
            String text;
            try { text = client.manifest(release); } catch (IOException error) { failed++; continue; }
            try {
                ReleaseManifest manifest = ReleaseManifest.parse(text);
                found.add(new Candidate(UpdateEligibility.evaluate(installed, release, manifest, state.channel, state.pin != null, now()),
                    ReleaseClient.manifestDigest(text)));
            } catch (ReleaseManifest.Invalid ignored) { /* A malformed release is never eligible. */ }
        }
        if (found.isEmpty() && failed > 0) throw new IOException("the release manifest could not be read");
        return found;
    }

    private void stage(Trigger trigger, UpdateState state) throws IOException, UpdateException {
        UpdateEligibility.Installed installed = installed();
        List<Candidate> candidates = discover(installed, state);
        List<UpdateEligibility.Decision> decisions = new ArrayList<>();
        for (Candidate candidate : candidates) decisions.add(candidate.decision);
        UpdateEligibility.Decision best = UpdateEligibility.best(decisions);
        Candidate chosen = null;
        for (Candidate candidate : candidates) if (candidate.decision == best) chosen = candidate;
        if (chosen == null) {
            available = null;
            // Nothing is eligible now, so a staged build was withdrawn, superseded, or pinned out: stop offering it.
            store.mutate(next -> { next.lastCheckedAt = now(); next.lastError = null; next.target = null; });
            sweep();
            return;
        }
        available = chosen;
        if (trigger != Trigger.MANUAL && metered()) {
            store.mutate(next -> { next.lastCheckedAt = now(); next.lastError = "An update is available. It downloads on an unmetered network or when you check manually."; });
            return;
        }
        activity = "downloading"; changed();
        stageFiles(chosen, installed);
        available = null;
    }

    private boolean fileMatches(File file, long bytes) { return file.isFile() && file.length() == bytes; }

    private boolean verifiedFileMatches(File file, String digest, long bytes) {
        try { ApkVerifier.verifyFile(file, digest, bytes); return true; }
        catch (ApkVerifier.Failure | IOException invalid) { return false; }
    }

    private UpdateCapacity.Snapshot capacitySnapshot() {
        String source = app.getApplicationInfo().sourceDir;
        return source == null ? UpdateCapacity.Snapshot.unknown() : AndroidStorage.inspect(apkDir, new File(source));
    }

    private static File pairedRecoveryFile(UpdateState state, File recoveryDirectory) throws IOException {
        if (state == null || state.target == null) return null;
        String digest = state.target.recoverySha256;
        if (digest == null || !digest.matches("[a-f0-9]{64}")) return null;
        UpdateState.Recovery recovery = state.recovery(digest);
        if (recovery == null || !digest.equals(recovery.sha256) || recovery.bytes <= 0
                || !(digest + ".apk").equals(recovery.file)) return null;
        File directory = recoveryDirectory.getCanonicalFile();
        File apk = new File(directory, recovery.file).getCanonicalFile();
        return directory.equals(apk.getParentFile()) && apk.isFile() && apk.length() == recovery.bytes ? apk : null;
    }

    private static String pairedRecoveryReadinessKey(UpdateState state, File recoveryDirectory) {
        try {
            File apk = pairedRecoveryFile(state, recoveryDirectory);
            if (apk == null) return null;
            UpdateState.Recovery recovery = state.recovery(state.target.recoverySha256);
            return state.target.recoverySha256 + "\n" + recovery.sha256 + "\n" + recovery.bytes + "\n"
                + apk.getPath() + "\n" + apk.length() + "\n" + apk.lastModified();
        } catch (IOException | RuntimeException unavailable) { return null; }
    }

    /** Readiness for installing a staged normal build means its own paired recovery is cached. */
    static boolean pairedRecoveryReady(UpdateState state, File recoveryDirectory) {
        try {
            File apk = pairedRecoveryFile(state, recoveryDirectory);
            return apk != null && ApkVerifier.sha256(apk).equals(state.target.recoverySha256);
        } catch (IOException | RuntimeException unavailable) { return false; }
    }

    private synchronized boolean pairedRecoveryReadyCached(UpdateState state) {
        String key = pairedRecoveryReadinessKey(state, recoveryDir);
        if (key == null) {
            pairedRecoveryReadinessCacheKey = null;
            pairedRecoveryReadinessCached = false;
            return false;
        }
        if (pairedRecoveryReadinessCached && key.equals(pairedRecoveryReadinessCacheKey))
            return pairedRecoveryReadinessValue;
        boolean ready = pairedRecoveryReady(state, recoveryDir);
        String after = pairedRecoveryReadinessKey(state, recoveryDir);
        if (key.equals(after)) {
            pairedRecoveryReadinessCacheKey = key;
            pairedRecoveryReadinessCached = true;
            pairedRecoveryReadinessValue = ready;
            return ready;
        }
        pairedRecoveryReadinessCacheKey = null;
        pairedRecoveryReadinessCached = false;
        return false;
    }

    /** Downloads and verifies recovery first, so a staged normal build always has its way back. */
    private void stageFiles(Candidate chosen, UpdateEligibility.Installed installed) throws IOException, UpdateException {
        ReleaseManifest manifest = chosen.decision.manifest;
        ReleaseRef release = chosen.decision.release;
        UpdateState state = store.snapshot();
        UpdateState.Identity identity = runningIdentity(state);
        String sourceVersion = identity.version;
        String sourceCommit = identity.commit;
        ReleaseManifest.Artifact pairedRecovery = manifest.recoveryForSource(sourceVersion, sourceCommit);
        if (pairedRecovery == null || pairedRecovery.versionCode <= manifest.normal.versionCode
                || !installed.packageName.equals(pairedRecovery.packageName)
                || !installed.signerSha256.equals(pairedRecovery.signerSha256)) {
            throw new UpdateException("This release has no valid recovery APK for the installed build.");
        }
        ReleaseManifest.Asset normalAsset = manifest.asset(manifest.normal.asset), recoveryAsset = manifest.asset(pairedRecovery.asset);
        if (normalAsset == null || recoveryAsset == null || !"android-recovery".equals(recoveryAsset.kind)
                || !"android".equals(recoveryAsset.platform)) {
            throw new UpdateException("This release has no valid recovery APK for the installed build.");
        }
        UpdateState.Recovery cached = state.recovery(recoveryAsset.sha256);
        boolean recoveryCached = cached != null
            && verifiedFileMatches(new File(recoveryDir, cached.file), recoveryAsset.sha256, recoveryAsset.bytes);
        UpdateState.Target existing = state.target;
        boolean normalStaged = existing != null && existing.versionCode == manifest.normal.versionCode && existing.sha256.equals(normalAsset.sha256)
            && existing.manifestSha256.equals(chosen.manifestSha256)
            && verifiedFileMatches(new File(apkDir, existing.file), normalAsset.sha256, normalAsset.bytes);
        if (!UpdateCapacity.canStageUpdate(capacitySnapshot(), normalAsset.bytes, normalStaged, recoveryAsset.bytes, recoveryCached))
            throw new UpdateException(UpdateCapacity.INSUFFICIENT_MESSAGE);
        if (!recoveryCached) {
            File file = fetchVerified(release, recoveryAsset, pairedRecovery, true, installed, recoveryDir);
            UpdateState.Recovery entry = new UpdateState.Recovery();
            entry.sha256 = recoveryAsset.sha256; entry.version = pairedRecovery.sourceVersion; entry.commit = pairedRecovery.sourceCommit;
            entry.channel = sourceChannel(pairedRecovery.sourceVersion); entry.file = file.getName(); entry.versionCode = pairedRecovery.versionCode;
            entry.bytes = recoveryAsset.bytes; entry.cachedAt = now();
            store.mutate(next -> { next.recovery.removeIf(old -> old.sha256.equals(entry.sha256)); next.recovery.add(entry); });
            recoveryCached = true;
        }
        File apk;
        if (normalStaged) apk = new File(apkDir, existing.file);
        else {
            if (!UpdateCapacity.canStageUpdate(capacitySnapshot(), normalAsset.bytes, false, recoveryAsset.bytes, true))
                throw new UpdateException(UpdateCapacity.INSUFFICIENT_MESSAGE);
            apk = fetchVerified(release, normalAsset, manifest.normal, false, installed, apkDir);
        }
        UpdateState.Target target = new UpdateState.Target();
        target.tag = release.tag; target.version = manifest.normal.sourceVersion; target.commit = manifest.normal.sourceCommit;
        target.channel = manifest.channel; target.sha256 = normalAsset.sha256; target.file = apk.getName(); target.bytes = normalAsset.bytes;
        target.versionCode = manifest.normal.versionCode; target.manifestSha256 = chosen.manifestSha256;
        target.recoverySha256 = recoveryAsset.sha256; target.verifiedAt = now();
        List<File> stale = new ArrayList<>();
        store.mutate(next -> {
            if (next.target != null && !next.target.file.equals(target.file)) stale.add(new File(apkDir, next.target.file));
            next.target = target; next.lastCheckedAt = now(); next.lastError = null;
            pruneRecovery(next, stale);
        });
        for (File file : stale) file.delete();
        sweep();
    }

    private void pruneRecovery(UpdateState next, List<File> deleted) {
        Set<String> keep = new HashSet<>();
        if (next.target != null) keep.add(next.target.recoverySha256);
        if (next.pending != null) keep.add(next.pending.targetSha256);
        for (UpdateState.Recovery evict : RecoveryCache.evictable(next.recovery, keep)) {
            next.recovery.remove(evict);
            if (next.recovery(evict.sha256) == null) deleted.add(new File(recoveryDir, evict.file));
        }
    }

    /** Removes interrupted downloads and files no state entry references. */
    private void sweep() {
        UpdateState state = store.snapshot();
        Set<String> apks = new HashSet<>(), recoveries = new HashSet<>();
        if (state.target != null) apks.add(state.target.file);
        for (UpdateState.Recovery entry : state.recovery) recoveries.add(entry.file);
        for (File orphan : RecoveryCache.orphans(apkDir, apks)) orphan.delete();
        for (File orphan : RecoveryCache.orphans(recoveryDir, recoveries)) orphan.delete();
    }

    private File fetchVerified(ReleaseRef release, ReleaseManifest.Asset asset, ReleaseManifest.Artifact artifact, boolean recovery,
            UpdateEligibility.Installed installed, File directory) throws IOException, UpdateException {
        File partial = new File(directory, asset.sha256 + ".part"), done = new File(directory, asset.sha256 + ".apk");
        client.download(release, asset.name, asset.bytes, partial, null);
        try {
            ApkVerifier.verifyFile(partial, asset.sha256, asset.bytes);
            // PackageManager reads archives by extension, so inspect a copy that ends in .apk.
            File inspect = new File(directory, asset.sha256 + ".inspect.apk");
            if (!partial.renameTo(inspect)) throw new IOException("Cannot stage the download");
            try { ApkVerifier.verifyFacts(ApkVerifier.read(app, inspect), artifact, recovery, installed); }
            finally { if (!inspect.renameTo(done)) inspect.delete(); }
        } catch (ApkVerifier.Failure failure) {
            partial.delete(); new File(directory, asset.sha256 + ".inspect.apk").delete(); done.delete();
            throw new UpdateException(failure.getMessage());
        }
        return done;
    }

    // ---- install -----------------------------------------------------------------------------

    private InstallGuard.Input guardInput(UpdateState state) {
        InstallGuard.Input input = new InstallGuard.Input();
        input.foreground = MainActivity.visible || RecoveryActivity.visible;
        input.backgroundSince = state.backgroundSince; input.now = now();
        input.operations = operations.active(); input.pending = state.pending != null;
        input.supported = supported(); input.uncertainState = state.recoveredFromCorruption;
        input.confirmationAvailable = UpdateNotifications.confirmationAvailable(app);
        input.installPermission = Build.VERSION.SDK_INT < 26 || app.getPackageManager().canRequestPackageInstalls();
        boolean rollback = state.intent != null && "rollback".equals(state.intent.kind);
        input.recoveryReady = rollback || pairedRecoveryReadyCached(state);
        if (rollback) {
            UpdateState.Recovery recovery = state.recovery(state.intent.targetSha256);
            input.storageReady = recovery != null
                && UpdateCapacity.canStartInstall(capacitySnapshot(), recovery.bytes);
        } else if (state.target != null) {
            input.storageReady = UpdateCapacity.canStartInstall(capacitySnapshot(), state.target.bytes);
        }
        return input;
    }

    /** What stands between a wanted installation and Android. Empty means it may be admitted now. */
    List<InstallGuard.Blocker> blockers(UpdateState state) {
        boolean rollback = state.intent != null && "rollback".equals(state.intent.kind);
        if (!rollback && (state.target == null || state.pin != null)) return new ArrayList<>();
        return InstallGuard.blockers(guardInput(state));
    }

    private boolean wanted(UpdateState state) {
        return state.intent != null || (state.automatic && !state.recoveredFromCorruption && state.deferUntil <= now()
            && state.target != null && !state.target.sha256.equals(state.failedArtifactSha256) && state.pin == null);
    }

    private static final long RETRY_MS = 5 * 60_000L;
    private static final long POLL_MS = 30_000L;

    /** Waits only for conditions that pass by themselves; a missing permission or cache waits for the person. */
    private void scheduleFor(List<InstallGuard.Blocker> blockers) {
        long delay = -1;
        for (InstallGuard.Blocker blocker : blockers) {
            long next = "idle-window".equals(blocker.reason) ? blocker.retryAfterMs + 2000
                : "commands".equals(blocker.reason) || "uploads".equals(blocker.reason) || "input-active".equals(blocker.reason)
                    || "storage".equals(blocker.reason) ? POLL_MS : -1;
            if (next > 0 && (delay < 0 || next < delay)) delay = next;
        }
        if (delay > 0) scheduleRecheck(delay);
    }

    private synchronized void scheduleRecheck(long delayMs) {
        if (recheck != null) recheck.cancel(false);
        recheck = timer.schedule(() -> run(Trigger.INTENT), delayMs, TimeUnit.MILLISECONDS);
        // Process death would drop the timer, so WorkManager carries the same recheck.
        try { AppUpdateWorker.scheduleRecheck(app, delayMs); } catch (RuntimeException ignored) { /* Timer still runs. */ }
    }

    /**
     * Admits a wanted installation if, and only if, the guard is clear. A person's request and an
     * automatic update take the same path: nothing here is waived, and a request never changes the policy.
     */
    private void apply() {
        UpdateEligibility.Installed installed = installed();
        UpdateState state = store.snapshot();
        if (state.pending != null || installed == null) return;
        UpdateState.Identity identity = runningIdentity(state);
        String stale = InstallIntents.staleReason(state, installed.versionCode, identity.version, identity.commit, now());
        if (stale != null) { store.tryMutate(next -> { next.intent = null; next.lastError = stale; }); state = store.snapshot(); }
        if (!wanted(state)) return;
        List<InstallGuard.Blocker> blockers = InstallGuard.blockers(guardInput(state));
        if (!blockers.isEmpty()) { scheduleFor(blockers); return; }
        try {
            if (state.intent != null && "rollback".equals(state.intent.kind)) applyRollback(state, installed);
            else applyUpdate(state, installed);
        } catch (RetryLater error) {
            remember(error.getMessage());
            scheduleRecheck(RETRY_MS);
        } catch (UpdateException error) {
            // Whatever was wanted cannot proceed as asked; do not leave it armed to fire later.
            store.tryMutate(next -> { if (next.target != null) next.failedArtifactSha256 = next.target.sha256; next.intent = null; next.lastError = error.getMessage(); });
        } finally { activity = null; }
    }

    /** The release could not be re-read right now; the request stays and is retried. */
    private static final class RetryLater extends UpdateException { RetryLater(String message) { super(message); } }

    private void applyUpdate(UpdateState state, UpdateEligibility.Installed installed) throws UpdateException {
        UpdateState.Target target = state.target;
        if (target == null) throw new UpdateException("No verified update is ready.");
        // Eligibility is decided again from the release as it exists now, never from the earlier check.
        activity = "verifying"; changed();
        UpdateState.Identity installedIdentity = runningIdentity(state);
        Candidate fresh;
        try { fresh = freshCandidate(target.tag, installed, state); }
        catch (IOException error) { throw new RetryLater("Could not re-check the release: " + safe(error)); }
        if (fresh == null || !fresh.decision.eligible()
                || !sameRelease(target, fresh, installedIdentity.version, installedIdentity.commit)) {
            store.tryMutate(next -> next.target = null);
            throw new UpdateException("The release changed, was withdrawn, or is no longer eligible.");
        }
        ReleaseManifest manifest = fresh.decision.manifest;
        ReleaseManifest.Artifact pairedRecovery = manifest.recoveryForSource(installedIdentity.version, installedIdentity.commit);
        if (pairedRecovery == null || pairedRecovery.versionCode <= manifest.normal.versionCode) {
            store.tryMutate(next -> next.target = null);
            throw new UpdateException("The release no longer has a recovery APK for the installed build.");
        }
        File apk = new File(apkDir, target.file);
        UpdateState.Recovery recovery = state.recovery(target.recoverySha256);
        ReleaseManifest.Asset pairedRecoveryAsset = manifest.asset(pairedRecovery.asset);
        if (recovery == null || pairedRecoveryAsset == null
                || !recovery.sha256.equals(pairedRecoveryAsset.sha256)
                || recovery.bytes != pairedRecoveryAsset.bytes) throw new UpdateException("A verified recovery build is not cached.");
        try {
            ApkVerifier.verifyFile(apk, target.sha256, target.bytes);
            ApkVerifier.verifyFacts(ApkVerifier.read(app, apk), manifest.normal, false, installed);
            File recoveryFile = new File(recoveryDir, recovery.file);
            ApkVerifier.verifyFile(recoveryFile, recovery.sha256, recovery.bytes);
            ApkVerifier.verifyFacts(ApkVerifier.read(app, recoveryFile), pairedRecovery, true, installed);
        } catch (ApkVerifier.Failure failure) { throw new UpdateException(failure.getMessage()); }
        catch (IOException error) { throw new UpdateException("Could not read the staged update."); }
        // Phone work may have started during the network check and verification.
        UpdateState latest = store.snapshot();
        List<InstallGuard.Blocker> blockers = InstallGuard.blockers(guardInput(latest));
        if (!blockers.isEmpty() || (latest.intent == null && !wanted(latest))) { scheduleFor(blockers); return; }
        UpdateState.Pending pending = new UpdateState.Pending();
        pending.transactionId = latest.intent != null ? latest.intent.transactionId : UUID.randomUUID().toString();
        pending.kind = "update"; pending.tag = target.tag;
        pending.targetVersion = target.version; pending.targetCommit = target.commit; pending.targetChannel = target.channel;
        pending.targetSha256 = target.sha256; pending.manifestSha256 = target.manifestSha256;
        pending.targetVersionCode = target.versionCode; pending.previousVersionCode = installed.versionCode;
        pending.userRequested = latest.intent != null;
        pending.requestedAt = latest.intent != null ? latest.intent.requestedAt : now();
        pending.previousCommit = BuildConfig.SOURCE_COMMIT; pending.startedAt = now();
        begin(apk, pending, null);
    }

    private void applyRollback(UpdateState state, UpdateEligibility.Installed installed) throws UpdateException {
        // Exactly the digest the person selected; there is no fallback to another cached build.
        UpdateState.Recovery entry = state.recovery(state.intent.targetSha256);
        if (entry == null) throw new UpdateException("The selected recovery build is no longer cached.");
        File file = new File(recoveryDir, entry.file);
        try {
            ApkVerifier.verifyFile(file, entry.sha256, entry.bytes);
            ReleaseManifest.Artifact expected = new ReleaseManifest.Artifact("recovery", entry.versionCode, entry.version, entry.commit,
                ReleaseManifest.PACKAGE, installed.signerSha256, ReleaseManifest.UPDATER_PROTOCOL);
            ApkVerifier.verifyFacts(ApkVerifier.read(app, file), expected, true, installed);
        } catch (ApkVerifier.Failure failure) { throw new UpdateException(failure.getMessage()); }
        catch (IOException error) { throw new UpdateException("Could not read the cached recovery build."); }
        List<InstallGuard.Blocker> blockers = InstallGuard.blockers(guardInput(store.snapshot()));
        if (!blockers.isEmpty()) { scheduleFor(blockers); return; }
        UpdateState.Pending pending = new UpdateState.Pending();
        pending.transactionId = state.intent.transactionId; pending.kind = "rollback"; pending.tag = "recovery";
        pending.targetVersion = entry.version; pending.targetCommit = entry.commit; pending.targetChannel = entry.channel;
        pending.targetSha256 = entry.sha256; pending.targetVersionCode = entry.versionCode;
        pending.userRequested = true;
        pending.requestedAt = state.intent.requestedAt;
        pending.previousVersionCode = installed.versionCode; pending.previousCommit = BuildConfig.SOURCE_COMMIT; pending.startedAt = now();
        UpdateState.Pin pin = new UpdateState.Pin();
        pin.versionCode = entry.versionCode; pin.version = entry.version; pin.commit = entry.commit; pin.reason = "rollback"; pin.artifactSha256 = entry.sha256;
        begin(file, pending, pin);
    }

    private void begin(File apk, UpdateState.Pending pending, UpdateState.Pin pin) throws UpdateException {
        // Acquire the phone-work fence before persisting/streaming the APK. It stays through OS
        // confirmation until replacement or a matching failure; new work cannot race this hand-off.
        if (!UpdateCapacity.canStartInstall(capacitySnapshot(), apk.length())) {
            scheduleRecheck(POLL_MS);
            changed();
            return;
        }
        if (!operations.admit(() -> InstallGuard.blockers(guardInput(store.snapshot())).isEmpty())) {
            scheduleRecheck(POLL_MS);
            return;
        }
        try {
            InstallTransaction.begin(store, new SessionInstaller(pending.transactionId), apk, true, pending, pin, now(), latest -> {
                boolean exact = "rollback".equals(pending.kind)
                    ? latest.intent != null && latest.intent.transactionId.equals(pending.transactionId)
                        && latest.intent.targetSha256.equals(pending.targetSha256)
                    : latest.target != null && latest.target.sha256.equals(pending.targetSha256)
                        && wanted(latest) && latest.pin == null
                        && (latest.intent == null || latest.intent.transactionId.equals(pending.transactionId));
                if (!exact) throw new IllegalStateException("The install request changed before admission.");
            });
        } catch (IOException | RuntimeException error) {
            operations.installationPending(false);
            if (error instanceof UpdateCapacity.Insufficient || error instanceof PhoneOperations.AdmissionChanged)
                throw new RetryLater(error.getMessage());
            throw new UpdateException("Android could not start the installation.");
        }
    }

    private interface Recording { void apply(UpdateState state) throws InstallIntents.Rejected; }

    /** Runs a validating change under the store's write; a rejection writes nothing. */
    private void record(Recording recording) throws UpdateException {
        InstallIntents.Rejected[] rejected = {null};
        try {
            store.mutate(state -> {
                try { recording.apply(state); }
                catch (InstallIntents.Rejected error) { rejected[0] = error; throw new IllegalStateException(error); }
            });
        } catch (IllegalStateException error) {
            if (rejected[0] != null) throw new UpdateException(rejected[0].getMessage());
            throw error;
        } catch (IOException error) { throw new UpdateException("Could not save the install request."); }
    }

    /**
     * The person asked to install the update whose digest they reviewed. This records the request and
     * returns; the install guard admits it once the app has been backgrounded for two minutes and phone
     * work has finished. The automatic-installation policy is untouched.
     */
    void requestInstall(String targetArtifactSha256) throws UpdateException {
        if (store == null || !supported()) throw new UpdateException("In-app updates are unavailable on this device.");
        record(state -> { InstallIntents.requestUpdate(state, targetArtifactSha256, now()); state.failedArtifactSha256 = ""; });
        changed();
        run(Trigger.INTENT);
    }

    /** The person selected a recorded recovery option; same waiting rules, same exact-digest binding. */
    void requestRollback(String optionId, String transactionId) throws UpdateException {
        if (store == null || !supported()) throw new UpdateException("In-app updates are unavailable on this device.");
        record(state -> {
            UpdateState.Identity identity = runningIdentity(state);
            InstallIntents.requestRollback(state, optionId, transactionId, installed().versionCode, identity.version, identity.commit, now());
        });
        changed();
        run(Trigger.INTENT);
    }

    void cancelRequest() throws UpdateException {
        if (store == null) throw new UpdateException(storeError);
        try { store.mutate(state -> { state.intent = null; state.deferUntil = now() + CANCEL_DEFER_MS; }); } catch (IOException error) { throw new UpdateException("Could not cancel the request."); }
        changed();
    }

    String recoveryTransactionId(UpdateState.Recovery entry) { return InstallIntents.recoveryTransactionId(installed().versionCode, entry.sha256); }

    private Candidate freshCandidate(String tag, UpdateEligibility.Installed installed, UpdateState state) throws IOException {
        for (ReleaseRef release : client.list()) {
            if (!release.tag.equals(tag)) continue;
            String text = client.manifest(release);
            try {
                ReleaseManifest manifest = ReleaseManifest.parse(text);
                return new Candidate(UpdateEligibility.evaluate(installed, release, manifest, state.channel, false, now()), ReleaseClient.manifestDigest(text));
            } catch (ReleaseManifest.Invalid invalid) { return null; }
        }
        return null;
    }

    static boolean exactTargetPair(UpdateState.Target target, ReleaseManifest manifest, String manifestSha256,
            String installedVersion, String installedCommit) {
        ReleaseManifest.Asset normal = manifest.asset(manifest.normal.asset);
        ReleaseManifest.Artifact pairedRecovery = manifest.recoveryForSource(installedVersion, installedCommit);
        ReleaseManifest.Asset recovery = pairedRecovery == null ? null : manifest.asset(pairedRecovery.asset);
        return manifestSha256.equals(target.manifestSha256) && manifest.normal.versionCode == target.versionCode
            && normal != null && normal.sha256.equals(target.sha256) && recovery != null
            && recovery.sha256.equals(target.recoverySha256) && pairedRecovery.versionCode > manifest.normal.versionCode;
    }

    private static boolean sameRelease(UpdateState.Target target, Candidate fresh, String installedVersion, String installedCommit) {
        return exactTargetPair(target, fresh.decision.manifest, fresh.manifestSha256, installedVersion, installedCommit);
    }

    // ---- recovery ----------------------------------------------------------------------------

    /** Cached builds Android would accept now: higher code than the installed app, different source. */
    List<UpdateState.Recovery> installableRecovery() {
        List<UpdateState.Recovery> result = new ArrayList<>();
        if (store == null) return result;
        long code = runningVersionCode();
        UpdateState.Identity identity = runningIdentity(store.snapshot());
        for (UpdateState.Recovery entry : store.snapshot().recovery) {
            if (InstallIntents.installable(entry, code, identity.version, identity.commit)
                    && new File(recoveryDir, entry.file).isFile()) result.add(entry);
        }
        result.sort((a, b) -> Long.compare(b.versionCode, a.versionCode));
        return result;
    }

    /** Downloads and verifies the newest published recovery build for use from the recovery screen. */
    void fetchRecovery() throws UpdateException {
        if (store == null || !supported()) throw new UpdateException("In-app updates are unavailable on this device.");
        try { if (!busy.tryLock(3, TimeUnit.SECONDS)) throw new UpdateException("An update check is still running."); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new UpdateException("Interrupted."); }
        try {
            activity = "checking"; changed();
            UpdateEligibility.Installed installed = installed();
            UpdateState.Identity identity = runningIdentity(store.snapshot());
            Candidate best = null;
            ReleaseManifest.Artifact bestRecovery = null;
            for (Candidate candidate : discover(installed, store.snapshot())) {
                UpdateEligibility.Reason reason = candidate.decision.reason;
                // Only the recovery side matters here, so a build that is not newer than this one still qualifies.
                if (reason != UpdateEligibility.Reason.ELIGIBLE && reason != UpdateEligibility.Reason.NOT_NEWER && reason != UpdateEligibility.Reason.PINNED) continue;
                for (ReleaseManifest.Artifact recovery : candidate.decision.manifest.allRecoveries()) {
                    ReleaseManifest.Asset asset = candidate.decision.manifest.asset(recovery.asset);
                    boolean sameSource = recovery.sourceCommit.equals(identity.commit) && recovery.sourceVersion.equals(identity.version);
                    if (recovery.versionCode <= installed.versionCode || sameSource
                            || !installed.packageName.equals(recovery.packageName) || !installed.signerSha256.equals(recovery.signerSha256)
                            || asset == null || !"android-recovery".equals(asset.kind) || !"android".equals(asset.platform)) continue;
                    if (bestRecovery == null || recovery.versionCode > bestRecovery.versionCode) {
                        best = candidate;
                        bestRecovery = recovery;
                    }
                }
            }
            if (best == null || bestRecovery == null) throw new UpdateException("No newer recovery build is published for this installation.");
            activity = "downloading"; changed();
            ReleaseManifest manifest = best.decision.manifest;
            ReleaseManifest.Asset asset = manifest.asset(bestRecovery.asset);
            UpdateState.Recovery cached = store.snapshot().recovery(asset.sha256);
            boolean recoveryCached = cached != null
                && verifiedFileMatches(new File(recoveryDir, cached.file), asset.sha256, asset.bytes);
            if (!recoveryCached && !UpdateCapacity.canStageRecovery(capacitySnapshot(), asset.bytes, false))
                throw new UpdateException(UpdateCapacity.INSUFFICIENT_MESSAGE);
            if (!recoveryCached) {
                File file = fetchVerified(best.decision.release, asset, bestRecovery, true, installed, recoveryDir);
                UpdateState.Recovery entry = new UpdateState.Recovery();
                entry.sha256 = asset.sha256; entry.version = bestRecovery.sourceVersion; entry.commit = bestRecovery.sourceCommit;
                entry.channel = sourceChannel(bestRecovery.sourceVersion); entry.file = file.getName(); entry.versionCode = bestRecovery.versionCode;
                entry.bytes = asset.bytes; entry.cachedAt = now();
                List<File> deleted = new ArrayList<>();
                store.mutate(next -> { next.recovery.add(entry); pruneRecovery(next, deleted); });
                for (File gone : deleted) gone.delete();
            }
        } catch (IOException error) { throw new UpdateException("Could not download the recovery build: " + safe(error)); }
        finally { activity = null; busy.unlock(); changed(); }
    }

    // ---- installer plumbing ------------------------------------------------------------------

    private final class SessionInstaller implements InstallTransaction.Installer {
        private final String transactionId;
        SessionInstaller(String transactionId) { this.transactionId = transactionId; }

        @Override public void commit(File apk, boolean silent) throws IOException {
            PackageInstaller installer = app.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(app.getPackageName());
            params.setSize(apk.length());
            // Silent replacement only applies when Android allows it for this installer; otherwise it asks.
            if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(silent
                ? PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED : PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
            int id = installer.createSession(params);
            try (PackageInstaller.Session session = installer.openSession(id)) {
                store.mutate(state -> {
                    if (state.pending == null || !transactionId.equals(state.pending.transactionId)) throw new IllegalStateException("The installation changed.");
                    state.pending.sessionId = id;
                });
                try (OutputStream out = session.openWrite("base.apk", 0, apk.length()); InputStream in = new FileInputStream(apk)) {
                    byte[] buffer = new byte[64 * 1024]; int count;
                    while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
                    session.fsync(out);
                }
                Intent intent = new Intent(app, InstallResultReceiver.class).setPackage(app.getPackageName()).putExtra(EXTRA_TRANSACTION, transactionId);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                operations.commitIfQuiet(() -> {
                    UpdateState latest = store.snapshot();
                    return !MainActivity.visible && !RecoveryActivity.visible && latest.pending != null
                        && transactionId.equals(latest.pending.transactionId) && latest.backgroundSince > 0
                        && now() - latest.backgroundSince >= InstallGuard.BACKGROUND_QUIET_MS;
                }, () -> {
                    if (!UpdateCapacity.canCommit(capacitySnapshot(), apk.length())) throw new UpdateCapacity.Insufficient();
                    session.commit(PendingIntent.getBroadcast(app, id, intent, flags).getIntentSender());
                });
            } catch (IOException | RuntimeException error) {
                try { installer.abandonSession(id); } catch (RuntimeException ignored) { /* Already closed. */ }
                if (error instanceof IOException && !(error instanceof UpdateCapacity.Insufficient)
                        && !UpdateCapacity.canStartInstall(capacitySnapshot(), apk.length())) throw new UpdateCapacity.Insufficient();
                throw error;
            }
        }
    }

    /** Called by {@link InstallResultReceiver}. Success normally never arrives: the process is replaced. */
    void installerResult(Intent result) {
        if (store == null) return;
        int status = result.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String message = result.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        String transaction = result.getStringExtra(EXTRA_TRANSACTION);
        UpdateState.Pending recorded = store.snapshot().pending;
        if (recorded == null || transaction == null || !transaction.equals(recorded.transactionId)) return;
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = IntentCompat.getParcelableExtra(result, Intent.EXTRA_INTENT, Intent.class);
            boolean updated = store.tryMutatePending(transaction, state -> {
                state.pending.installerResult = "awaiting-confirmation";
                if (confirm != null) state.pending.confirmationFilterUri = confirm.cloneFilter().toUri(Intent.URI_INTENT_SCHEME);
            });
            UpdateState.Pending latest = store.snapshot().pending;
            // A failed bookkeeping write must not cancel Android's already-committed installation
            // or destroy its confirmation. Its notification remains a fallback for this exact session.
            if (confirm != null && latest != null && transaction.equals(latest.transactionId) && recorded.sessionId == latest.sessionId)
                UpdateNotifications.confirm(app, UpdateNotifications.confirmation(app, confirm, recorded.sessionId));
            if (updated) changed();
            return;
        }
        if (status == PackageInstaller.STATUS_SUCCESS) {
            if (store.tryMutatePending(transaction, state -> state.pending.installerResult = "success")) changed();
            return;
        }
        boolean cancelled = status == PackageInstaller.STATUS_FAILURE_ABORTED;
        boolean insufficientStorage = status == PackageInstaller.STATUS_FAILURE_STORAGE;
        boolean updated = store.tryMutatePending(transaction, state -> {
            UpdateState.Pending pending = state.pending;
            UpdateState.Outcome outcome = new UpdateState.Outcome();
            outcome.transactionId = pending.transactionId; outcome.kind = pending.kind; outcome.at = now();
            outcome.result = cancelled ? "cancelled" : insufficientStorage ? "waiting" : "failed";
            outcome.message = cancelled ? "The installation was cancelled." : insufficientStorage
                ? UpdateCapacity.INSUFFICIENT_MESSAGE : (message == null ? "Android rejected the installation." : message);
            state.lastOutcome = outcome; state.pending = null;
            if (!cancelled && !insufficientStorage) state.failedArtifactSha256 = pending.targetSha256;
            if (insufficientStorage && pending.userRequested && state.intent == null) {
                UpdateState.Intent intent = new UpdateState.Intent();
                intent.kind = pending.kind; intent.targetSha256 = pending.targetSha256;
                intent.transactionId = pending.transactionId; intent.requestedAt = pending.requestedAt;
                state.intent = intent;
                state.lastError = UpdateCapacity.INSUFFICIENT_MESSAGE;
            }
            // A refused install must not nag: wait a day before asking again.
            if (cancelled) state.deferUntil = now() + CANCEL_DEFER_MS; else state.lastError = outcome.message;
        });
        if (!updated) return;
        operations.installationPending(store.snapshot().pending != null);
        if (!cancelled) UpdateNotifications.failure(app);
        if (insufficientStorage && recorded.userRequested) scheduleRecheck(POLL_MS);
        changed();
    }

    // ---- status ------------------------------------------------------------------------------

    /** Reopens the already-admitted Android prompt; never creates a session or bypasses admission. */
    void openInstallConfirmation(String transactionId) throws UpdateException {
        if (store == null) throw new UpdateException(storeError);
        UpdateState.Pending pending = store.snapshot().pending;
        if (pending == null || !pending.transactionId.equals(transactionId) || !"awaiting-confirmation".equals(pending.installerResult))
            throw new UpdateException("That installation is no longer awaiting Android confirmation.");
        boolean owned = false;
        try {
            for (PackageInstaller.SessionInfo session : app.getPackageManager().getPackageInstaller().getMySessions())
                if (session.getSessionId() == pending.sessionId) { owned = true; break; }
        } catch (RuntimeException unavailable) { throw new UpdateException("Android's installation session is unavailable. Try again."); }
        android.app.PendingIntent prompt = owned ? UpdateNotifications.existingConfirmation(app, pending) : null;
        if (prompt == null) throw new UpdateException("Android's confirmation is no longer available. Finish or cancel the pending Android installer before retrying.");
        UpdateState.Pending latest = store.snapshot().pending;
        if (latest == null || !transactionId.equals(latest.transactionId) || latest.sessionId != pending.sessionId
                || !"awaiting-confirmation".equals(latest.installerResult))
            throw new UpdateException("That installation has changed. Review its current status.");
        try { UpdateNotifications.openConfirmation(app, prompt); }
        catch (android.app.PendingIntent.CanceledException | RuntimeException unavailable) {
            throw new UpdateException("Android could not open its confirmation. Finish or cancel the pending Android installer before retrying.");
        }
    }

    private static String recentOutcome(UpdateState state) {
        if (state.lastOutcome == null || now() - state.lastOutcome.at > OUTCOME_VISIBLE_MS) return null;
        return state.lastOutcome.result;
    }

    JSONObject status() {
        try {
            UpdateState state = store == null ? new UpdateState() : store.snapshot();
            boolean ok = supported();
            UpdateState.Identity identity = state.identity;
            JSONObject current = new JSONObject().put("version", identity == null ? BuildConfig.SOURCE_VERSION : identity.version)
                .put("commit", identity == null ? BuildConfig.SOURCE_COMMIT : identity.commit).put("versionCode", runningVersionCode())
                .put("channel", identity == null ? "stable" : identity.channel).put("artifactSha256", identity == null ? "" : identity.artifactSha256)
                .put("installationSequence", identity == null ? 0 : identity.sequence).put("recovery", BuildConfig.RECOVERY_BUILD);
            if (!BuildConfig.UPSTREAM_VERSION.isEmpty()) current.put("upstreamVersion", BuildConfig.UPSTREAM_VERSION);
            if (!BuildConfig.UPSTREAM_COMMIT.isEmpty()) current.put("upstreamCommit", BuildConfig.UPSTREAM_COMMIT);
            if (BuildConfig.FORK_BUILD_NUMBER > 0) current.put("forkBuildNumber", BuildConfig.FORK_BUILD_NUMBER);
            List<InstallGuard.Blocker> blockers = ok ? blockers(state) : new ArrayList<>();
            JSONArray blockerJson = new JSONArray();
            for (InstallGuard.Blocker blocker : blockers)
                blockerJson.put(new JSONObject().put("reason", blocker.reason).put("label", blocker.label).put("retryAfterMs", blocker.retryAfterMs));
            JSONArray cached = new JSONArray();
            for (UpdateState.Recovery entry : installableRecovery())
                cached.put(new JSONObject().put("versionCode", entry.versionCode).put("version", entry.version).put("commit", entry.commit)
                    .put("channel", sourceChannel(entry.version)).put("sha256", entry.sha256).put("transactionId", recoveryTransactionId(entry)));
            JSONObject target = null;
            UpdateState.Pending pending = state.pending;
            if (pending != null) target = build(pending.targetVersion, pending.targetCommit, pending.targetVersionCode, pending.targetChannel, pending.targetSha256, pending.tag);
            else if (state.target != null) target = build(state.target.version, state.target.commit, state.target.versionCode, state.target.channel, state.target.sha256, state.target.tag);
            else if (available != null) {
                ReleaseManifest manifest = available.decision.manifest;
                target = build(manifest.normal.sourceVersion, manifest.normal.sourceCommit, manifest.normal.versionCode, manifest.channel,
                    manifest.asset(manifest.normal.asset).sha256, available.decision.release.tag);
            }
            JSONObject pin = null;
            if (state.pin != null) pin = new JSONObject().put("versionCode", state.pin.versionCode).put("version", state.pin.version)
                .put("commit", state.pin.commit).put("reason", state.pin.reason).put("artifactSha256", state.pin.artifactSha256);
            UpdateState.Intent intent = state.intent;
            JSONObject request = intent == null ? null : new JSONObject().put("kind", intent.kind)
                .put("targetArtifactSha256", intent.targetSha256).put("transactionId", intent.transactionId).put("requestedAt", Iso8601.format(intent.requestedAt));
            String outcome = recentOutcome(state);
            String phase;
            if (state.recoveryRequired()) phase = "recovery";
            else if (pending != null) phase = "installing";
            else if (activity != null) phase = activity;
            // A request is a person's explicit wish: it waits like an automatic install, whatever the policy says.
            else if (intent != null) phase = "waiting";
            else if (state.pin != null) phase = "pinned";
            else if (state.target != null && state.target.sha256.equals(state.failedArtifactSha256)) phase = "failed";
            else if (state.target != null) phase = state.automatic && !blockers.isEmpty() ? "waiting" : "staged";
            else if (available != null) phase = "available";
            else if ("failed".equals(outcome) || "cancelled".equals(outcome)) phase = "failed";
            else if ("completed".equals(outcome)) phase = "completed";
            else phase = "idle";
            if ("cancelled".equals(outcome) && state.pin == null && state.target == null && pending == null) phase = "idle";
            return new JSONObject().put("protocol", ReleaseManifest.UPDATER_PROTOCOL).put("supported", ok)
                .put("unsupportedReason", ok ? JSONObject.NULL : storeError != null ? storeError : "Android 9 or newer is required to verify updates in the app.")
                .put("phase", phase).put("current", current)
                .put("policy", new JSONObject().put("channel", state.channel == null ? defaultChannel() : state.channel)
                    .put("automaticInstallation", state.automatic && !state.recoveredFromCorruption).put("pin", pin == null ? JSONObject.NULL : pin))
                .put("target", target == null ? JSONObject.NULL : target).put("blockers", blockerJson)
                .put("recovery", new JSONObject().put("ready", pairedRecoveryReadyCached(state)).put("cached", cached))
                .put("installPermission", Build.VERSION.SDK_INT < 26 || app.getPackageManager().canRequestPackageInstalls() ? "granted" : "needed")
                .put("silentInstall", silentInstall())
                .put("lastCheckedAt", state.lastCheckedAt > 0 ? Iso8601.format(state.lastCheckedAt) : JSONObject.NULL)
                .put("lastError", state.lastError == null ? JSONObject.NULL : state.lastError)
                .put("transactionId", pending != null ? pending.transactionId : intent != null ? intent.transactionId : JSONObject.NULL)
                .put("installRequest", request == null ? JSONObject.NULL : request)
                .put("confirmationPending", pending != null && "awaiting-confirmation".equals(pending.installerResult));
        } catch (JSONException error) { throw new IllegalStateException(error); }
    }

    private static JSONObject build(String version, String commit, long code, String channel, String sha, String tag) throws JSONException {
        return new JSONObject().put("version", version).put("commit", commit).put("versionCode", code).put("channel", channel)
            .put("artifactSha256", sha).put("tag", tag);
    }

    private boolean silentInstall() {
        if (Build.VERSION.SDK_INT < 31) return false;
        try { return app.getPackageName().equals(app.getPackageManager().getInstallSourceInfo(app.getPackageName()).getInstallingPackageName()); }
        catch (PackageManager.NameNotFoundException | RuntimeException error) { return false; }
    }
}
