package com.devotek.t3code.pwa;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Real Android shell/recovery/guard checks. Run only in an isolated emulator with no paired hosts. */
public final class UpdaterSmokeInstrumentation extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle receipt = new Bundle();
        UpdateEngine engine = UpdateEngine.get(getTargetContext());
        UpdateStore store = null;
        UpdateState original = null;
        Activity activity = null;
        Runnable health = null;
        int result = Activity.RESULT_CANCELED;
        try {
            Field field = UpdateEngine.class.getDeclaredField("store"); field.setAccessible(true);
            store = (UpdateStore) field.get(engine);
            require(store != null, "Updater persistence unavailable");
            original = store.snapshot();
            require(original.identity == null, "Use a fresh isolated emulator; this test refuses an existing installation's state.");
            store.mutate(state -> { state.lastCheckedAt = System.currentTimeMillis(); state.automatic = false; });
            CountDownLatch rendered = new CountDownLatch(1);
            health = () -> { UpdateState state = engine.snapshot(); if (state != null && state.shellReportsHealth) rendered.countDown(); };
            engine.addListener(health);
            activity = startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName(getTargetContext(), MainActivity.class.getName()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            require(rendered.await(30, TimeUnit.SECONDS), "A fresh unpaired shell failed to report actual render health");
            require(engine.snapshot().unhealthyLaunches == 0, "Working onboarding must not enter recovery after repeated launches");
            getTargetContext().getSharedPreferences("updater-smoke", 0).edit().putString("connection-marker", "fixture-only").commit();
            engine.configure("nightly", false);
            String digest = "d".repeat(64);
            store.mutate(state -> {
                UpdateState.Target target = new UpdateState.Target();
                target.sha256 = digest; target.version = "1.0.1-nightly.fixture"; target.commit = "b".repeat(40);
                target.versionCode = engine.installed().versionCode + 1; target.recoverySha256 = "e".repeat(64);
                state.target = target;
                UpdateState.Recovery recovery = new UpdateState.Recovery(); recovery.sha256 = target.recoverySha256;
                state.recovery.add(recovery);
            });
            PhoneOperations.shared().setUploads(1);
            engine.requestInstall(digest);
            require("waiting".equals(engine.status().getString("phase")), "Manual install must wait for foreground and upload work: " + engine.status());
            require(engine.snapshot().pending == null && engine.snapshot().intent != null, "An idle blocker must retain the request without starting an installer");
            require(!engine.snapshot().automatic, "Manual installation changed the automatic policy");
            try { engine.requestInstall("f".repeat(64)); throw new AssertionError("Stale artifact was admitted"); }
            catch (UpdateEngine.UpdateException expected) { }
            PhoneOperations.shared().setUploads(0);
            engine.cancelRequest();
            require(engine.snapshot().intent == null && !engine.snapshot().automatic, "Cancel must withdraw the request without changing policy");
            engine.pinCurrent(); engine.resume();
            require(engine.snapshot().pin == null && !engine.snapshot().automatic, "Resume updates changed automatic policy");
            final MainActivity shell = (MainActivity) activity;
            CountDownLatch returned = new CountDownLatch(1);
            android.app.Application application = (android.app.Application) getTargetContext().getApplicationContext();
            android.app.Application.ActivityLifecycleCallbacks lifecycle = new android.app.Application.ActivityLifecycleCallbacks() {
                public void onActivityResumed(Activity current) { if (current == shell) returned.countDown(); }
                public void onActivityCreated(Activity current, Bundle saved) { }
                public void onActivityStarted(Activity current) { }
                public void onActivityPaused(Activity current) { }
                public void onActivityStopped(Activity current) { }
                public void onActivitySaveInstanceState(Activity current, Bundle saved) { }
                public void onActivityDestroyed(Activity current) { }
            };
            application.registerActivityLifecycleCallbacks(lifecycle);
            try {
                Intent settings = UpdateNotifications.settings(shell);
                String settingsPackage = settings.resolveActivity(getTargetContext().getPackageManager()).getPackageName();
                // Our main thread being idle does not mean Android Settings has taken focus yet.
                // Sending Back before its window appears can close T3 instead of returning from Settings.
                android.view.accessibility.AccessibilityEvent opened = getUiAutomation().executeAndWaitForEvent(
                    () -> runOnMainSync(() -> shell.openSettings(settings)),
                    event -> event.getEventType() == android.view.accessibility.AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                        && settingsPackage.contentEquals(event.getPackageName() == null ? "" : event.getPackageName()),
                    10_000);
                opened.recycle();
                waitForIdleSync();
                require(engine.snapshot().nativeOperations.stream().anyMatch(key -> key.startsWith("settings:")), "Android Settings did not persist its operation hold");
                try (android.os.ParcelFileDescriptor back = getUiAutomation().executeShellCommand("input keyevent 4")) {
                    new java.io.FileInputStream(back.getFileDescriptor()).readAllBytes();
                }
                require(returned.await(10, TimeUnit.SECONDS), "Android Settings did not return to the app");
                require(engine.snapshot().nativeOperations.isEmpty(), "Matching Settings result failed to release its hold");
            } finally { application.unregisterActivityLifecycleCallbacks(lifecycle); }
            checkSlowNavigation((MainActivity) activity);
            // The isolated fixture lowers this channel independently of the global permission;
            // the user can still independently disable App updates, which must block admission.
            try (android.os.ParcelFileDescriptor grant = getUiAutomation().executeShellCommand(
                    "pm grant " + getTargetContext().getPackageName() + " android.permission.POST_NOTIFICATIONS")) {
                new java.io.FileInputStream(grant.getFileDescriptor()).readAllBytes();
            }
            android.app.NotificationManager notifications = getTargetContext().getSystemService(android.app.NotificationManager.class);
            notifications.createNotificationChannel(new android.app.NotificationChannel(UpdateNotifications.CHANNEL,
                "App updates", android.app.NotificationManager.IMPORTANCE_NONE));
            require(NativeNotifications.allowed(getTargetContext()), "Global notification permission must be enabled for the channel test");
            require(!UpdateNotifications.confirmationAvailable(getTargetContext()), "A blocked App updates channel admitted installation");
            require(engine.blockers(engine.snapshot()).stream().anyMatch(blocker -> blocker.label.contains("App updates notifications")),
                "The blocked channel must explain why installation is waiting");
            Intent channelSettings = UpdateNotifications.settings(getTargetContext());
            require(android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS.equals(channelSettings.getAction())
                && UpdateNotifications.CHANNEL.equals(channelSettings.getStringExtra(android.provider.Settings.EXTRA_CHANNEL_ID)),
                "Recovery must target the blocked App updates channel");
            final Activity main = activity;
            runOnMainSync(main::finish);
            store.mutate(state -> { state.target = null; state.intent = null; state.forceRecovery = true; });
            ActivityMonitor monitor = addMonitor(RecoveryActivity.class.getName(), null, false);
            runOnMainSync(() -> getTargetContext().startActivity(new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)));
            Activity recovered = waitForMonitorWithTimeout(monitor, 10_000);
            require(recovered != null && !hasWebView(recovered.getWindow().getDecorView()), "Recovery must open before any WebView");
            runOnMainSync(recovered::finish);
            require("fixture-only".equals(getTargetContext().getSharedPreferences("updater-smoke", 0).getString("connection-marker", "")), "Native operations cleared local state");
            receipt.putString("result", "fresh-shell-health; manual-wait; upload-hold; stale-build-rejection; cancel; pin-resume; recovery-before-WebView; local-state-preserved; Android-settings-hold-and-return; native-navigation-hold; blocked-update-channel");
            receipt.putInt("checks", 11);
            result = Activity.RESULT_OK;
        } catch (Throwable error) {
            receipt.putString("error", error.toString());
        } finally {
            if (health != null) engine.removeListener(health);
            PhoneOperations.shared().setUploads(0);
            if (store != null && original != null) {
                UpdateState saved = original;
                try { store.mutate(state -> { state.target = saved.target; state.intent = saved.intent; state.pin = saved.pin; state.forceRecovery = false; state.automatic = false; }); }
                catch (Exception ignored) { }
            }
        }
        finish(result, receipt);
    }
    private void checkSlowNavigation(MainActivity activity) throws Exception {
        CountDownLatch requested = new CountDownLatch(1), release = new CountDownLatch(1), finished = new CountDownLatch(1);
        String key = "updater-slow-navigation-fixture";
        Field browserField = MainActivity.class.getDeclaredField("browser"); browserField.setAccessible(true);
        NativeBrowser browser = (NativeBrowser) browserField.get(activity);
        java.lang.reflect.Method ensure = NativeBrowser.class.getDeclaredMethod("ensure", org.json.JSONObject.class); ensure.setAccessible(true);
        java.lang.reflect.Method close = NativeBrowser.class.getDeclaredMethod("close", String.class); close.setAccessible(true);
        try (java.net.ServerSocket server = new java.net.ServerSocket(0)) {
            Thread response = new Thread(() -> {
                try (java.net.Socket socket = server.accept()) {
                    socket.getInputStream().read(new byte[4096]); requested.countDown();
                    if (!release.await(15, TimeUnit.SECONDS)) return;
                    byte[] body = "<!doctype html><title>Slow fixture</title>Loaded".getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    socket.getOutputStream().write(body);
                } catch (Exception ignored) { }
            }, "updater-slow-page-fixture");
            response.setDaemon(true); response.start();
            try {
                org.json.JSONObject payload = new org.json.JSONObject().put("key", key).put("environmentId", "isolated-fixture")
                    .put("threadId", "fixture").put("tabId", "fixture").put("url", "http://127.0.0.1:" + server.getLocalPort() + "/");
                runOnMainSync(() -> {
                    try {
                        Object tab = ensure.invoke(browser, payload);
                        Field web = tab.getClass().getDeclaredField("webView"); web.setAccessible(true);
                        WebView view = (WebView) web.get(tab);
                        android.webkit.WebViewClient original = view.getWebViewClient();
                        view.setWebViewClient(new android.webkit.WebViewClient() {
                            @Override public void onPageStarted(WebView current, String url, android.graphics.Bitmap icon) { original.onPageStarted(current, url, icon); }
                            @Override public void onPageFinished(WebView current, String url) { original.onPageFinished(current, url); finished.countDown(); }
                        });
                    } catch (Exception error) { throw new RuntimeException(error); }
                });
                require(requested.await(10, TimeUnit.SECONDS), "Slow native browser fixture was not requested");
                InstallGuard.Input input = new InstallGuard.Input(); input.now = System.currentTimeMillis();
                input.backgroundSince = input.now - InstallGuard.BACKGROUND_QUIET_MS - 1;
                input.operations = PhoneOperations.shared().active();
                require(InstallGuard.blockers(input).stream().anyMatch(blocker -> "commands".equals(blocker.reason)), "A returned ensure/navigation failed to hold installation while its page was loading");
                release.countDown();
                require(finished.await(10, TimeUnit.SECONDS), "Slow native browser fixture did not finish");
                require(PhoneOperations.shared().active().stream().noneMatch(operation -> "navigation".equals(operation.kind) && key.equals(operation.id)), "Finished page retained its navigation hold");
            } finally {
                release.countDown(); runOnMainSync(() -> { try { close.invoke(browser, key); } catch (Exception error) { throw new RuntimeException(error); } });
            }
        }
    }
    private static boolean hasWebView(View view) {
        if (view instanceof WebView) return true;
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) if (hasWebView(group.getChildAt(i))) return true;
        return false;
    }
    private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
