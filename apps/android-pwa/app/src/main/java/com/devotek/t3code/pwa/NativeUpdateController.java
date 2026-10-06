package com.devotek.t3code.pwa;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The shell's window onto the native updater. Only the bundled app origin's main frame may call it,
 * and every action is re-validated natively: the web layer can request an update but never supply
 * a release, a file, or an eligibility decision.
 */
@android.annotation.SuppressLint("InlinedApi") // ACTION_MANAGE_UNKNOWN_APP_SOURCES is only used where the updater is supported (API 28+).
final class NativeUpdateController {
    private final MainActivity activity;
    private final UpdateEngine engine;
    // Network and install work can take minutes; cheap requests (including upload heartbeats) never queue behind it.
    private final ExecutorService slow = Executors.newSingleThreadExecutor(task -> new Thread(task, "t3-updater"));
    private final ExecutorService fast = Executors.newSingleThreadExecutor(task -> new Thread(task, "t3-updater-fast"));
    private volatile JavaScriptReplyProxy events;
    private final Runnable listener = this::push;

    NativeUpdateController(MainActivity activity, WebView shell) {
        this.activity = activity;
        this.engine = UpdateEngine.get(activity);
        this.shell = shell;
    }
    private final WebView shell;

    void install() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(shell, "t3Updates", Collections.singleton("https://appassets.androidplatform.net"),
            (view, message, origin, mainFrame, reply) -> {
                if (!mainFrame || !MainActivity.isAppOrigin(origin)) return;
                String raw = message.getData();
                if (raw == null || raw.length() > 8192) return;
                events = reply;
                String action = actionOf(raw);
                boolean heavy = "check".equals(action) || "install".equals(action) || "recovery".equals(action) || "configure".equals(action) || "resume".equals(action);
                (heavy ? slow : fast).execute(() -> handle(raw, reply));
            });
        engine.addListener(listener);
    }

    void shellNavigating() {
        events = null;
        // Replacing the page cancels every XHR it owned, so only now is an unfinished upload known to be over.
        PhoneOperations.shared().shellTerminated();
    }
    void destroy() { PhoneOperations.shared().shellTerminated(); engine.removeListener(listener); slow.shutdown(); fast.shutdown(); events = null; }

    private static String actionOf(String raw) {
        try { return new JSONObject(raw).optString("action"); } catch (JSONException error) { return ""; }
    }

    private void push() {
        JavaScriptReplyProxy target = events;
        if (target == null) return;
        String payload;
        try { payload = new JSONObject().put("event", engine.status()).toString(); } catch (JSONException | RuntimeException error) { return; }
        post(target, payload);
    }

    private void post(JavaScriptReplyProxy target, String payload) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        activity.runOnUiThread(() -> {
            try { target.postMessage(payload); } catch (IllegalStateException ignored) { /* The shell reloaded. */ }
        });
    }

    private void respond(JavaScriptReplyProxy reply, String id, String error) {
        try {
            JSONObject response = new JSONObject().put("id", id);
            if (error == null) response.put("result", engine.status()); else response.put("error", error);
            post(reply, response.toString());
        } catch (JSONException | RuntimeException ignored) { /* Nothing safe to report to a malformed request. */ }
    }

    private void handle(String raw, JavaScriptReplyProxy reply) {
        String id = "";
        try {
            JSONObject request = new JSONObject(raw);
            id = request.getString("id");
            JSONObject payload = request.optJSONObject("payload");
            if (payload == null) payload = new JSONObject();
            switch (request.getString("action")) {
                case "status": break;
                case "check": engine.run(UpdateEngine.Trigger.MANUAL); break;
                case "configure": {
                    String channel = payload.has("channel") ? payload.getString("channel") : null;
                    Boolean automatic = payload.has("automaticInstallation") ? payload.getBoolean("automaticInstallation") : null;
                    engine.configure(channel, automatic);
                    // A policy change can make a staged build eligible or a different one preferable.
                    engine.run(UpdateEngine.Trigger.WORKER);
                    break;
                }
                case "pin": engine.pinCurrent(); break;
                case "resume": engine.resume(); engine.run(UpdateEngine.Trigger.WORKER); break;
                case "install": {
                    // Root's shared "cancel-countdown" control arrives on this action; it withdraws a waiting request.
                    if ("cancel-countdown".equals(payload.optString("action"))) { engine.cancelRequest(); break; }
                    // The digest the person reviewed must be named; a missing or different one is a stale action.
                    engine.requestInstall(payload.optString("targetArtifactSha256", ""));
                    break;
                }
                case "cancel": engine.cancelRequest(); break;
                case "installPermission":
                    activity.runOnUiThread(() -> activity.openSettings(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName()))));
                    break;
                case "confirmationPermission":
                    activity.runOnUiThread(() -> activity.openSettings(UpdateNotifications.settings(activity)));
                    break;
                // Rollback to the recorded option the person chose. optionId is the cached build's digest.
                case "recovery": engine.requestRollback(payload.optString("optionId", ""), payload.optString("transactionId", "")); break;
                case "openRecovery": activity.runOnUiThread(() -> activity.startActivity(RecoveryActivity.intent(activity))); break;
                case "healthy": engine.healthy(); break;  // Only a rendered bundled shell can report health.
                case "operations": PhoneOperations.shared().setUploads(Math.max(0, payload.getInt("uploads"))); break;
                default: throw new UpdateEngine.UpdateException("Unknown update action.");
            }
            respond(reply, id, null);
        } catch (UpdateEngine.UpdateException error) { respond(reply, id, error.getMessage());
        } catch (JSONException | RuntimeException error) { respond(reply, id, "Could not update the app."); }
    }
}
