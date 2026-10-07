package com.devotek.t3code.pwa;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class NativeNotifications {
    static final int PERMISSION = 4;
    static final String ALERTS = "t3-agent-alerts-v1";
    static final String QUIET = "t3-agent-alerts-quiet-v1";
    static final String CONNECTION = "t3-background-connection-v1";
    static final String ROUTE = "t3NotificationRoute";
    private final MainActivity activity;
    private JavaScriptReplyProxy permissionReply;
    private String permissionId;
    NativeNotifications(MainActivity activity) { this.activity = activity; channels(activity); }
    static SharedPreferences store(Context context) { return context.getSharedPreferences("t3-native-notifications", Context.MODE_PRIVATE); }
    static JSONObject read(Context context, String key) {
        if ("connections".equals(key)) return NotificationCredentials.read(context);
        try { return new JSONObject(store(context).getString(key, "{}")); }
        catch (JSONException ignored) { return new JSONObject(); }
    }
    static boolean allowed(Context context) { return NotificationManagerCompat.from(context).areNotificationsEnabled(); }
    static void channels(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel alerts = new NotificationChannel(ALERTS, "Agent alerts", NotificationManager.IMPORTANCE_DEFAULT);
        NotificationChannel quiet = new NotificationChannel(QUIET, "Silent agent alerts", NotificationManager.IMPORTANCE_DEFAULT);
        quiet.setSound(null, null); quiet.enableVibration(false);
        NotificationChannel connection = new NotificationChannel(CONNECTION, "Background connections", NotificationManager.IMPORTANCE_LOW);
        connection.setSound(null, null); connection.setShowBadge(false);
        manager.createNotificationChannel(alerts); manager.createNotificationChannel(quiet); manager.createNotificationChannel(connection);
    }
    static Intent open(Context context, String route) {
        return new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(ROUTE, route);
    }
    static PendingIntent tap(Context context, String route) {
        return PendingIntent.getActivity(context, route.hashCode(), open(context, route), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    static void alert(Context context, String environmentId, JSONObject thread, String kind) throws JSONException {
        JSONObject prefs = read(context, "preferences");
        String option = switch (kind) {
            case "agent_completed" -> "notifyOnCompletion";
            case "agent_failed" -> "notifyOnFailure";
            case "plan_ready" -> "notifyOnPlanReady";
            default -> "notifyOnInput";
        };
        if (!prefs.optBoolean("enabled") || !prefs.optBoolean(option, true) || !allowed(context) || MainActivity.visible) return;
        String title = switch (kind) {
            case "agent_completed" -> "Thread completed";
            case "agent_failed" -> "Thread failed";
            case "plan_ready" -> "Plan ready";
            default -> "Input or approval needed";
        };
        String body = prefs.optBoolean("showProjectAndThreadNames", true) ? thread.optString("title", "Arcwright Code") : "Open Arcwright Code to view the thread.";
        String threadId = thread.getString("id");
        String route = "/" + android.net.Uri.encode(environmentId) + "/" + android.net.Uri.encode(threadId);
        post(context, environmentId + ":" + threadId, title, body, route, prefs.optBoolean("playSound", true));
    }
    static void post(Context context, String tag, String title, String body, String route, boolean sound) {
        if (!allowed(context)) return;
        try {
        NotificationManagerCompat.from(context).notify(tag, 1, new NotificationCompat.Builder(context, sound ? ALERTS : QUIET)
            .setSmallIcon(com.devotek.t3code.pwa.R.drawable.notification_icon).setContentTitle(title).setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body)).setAutoCancel(true)
            .setDefaults(sound ? android.app.Notification.DEFAULT_SOUND : 0)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setContentIntent(tap(context, route)).build());
        } catch (SecurityException ignored) { /* Permission may be revoked between checking and posting. */ }
    }
    private JSONObject status() throws JSONException {
        boolean asked = store(activity).getBoolean("permissionAsked", false);
        return new JSONObject().put("permission", allowed(activity) ? "ready" : asked ? "permission-blocked" : "permission-needed")
            .put("background", store(activity).getBoolean("background", false));
    }
    private void respond(JavaScriptReplyProxy reply, String id, JSONObject result, String error) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        try {
            JSONObject response = new JSONObject().put("id", id);
            if (error == null) response.put("result", result); else response.put("error", error);
            reply.postMessage(response.toString());
        } catch (JSONException | IllegalStateException ignored) { /* The originating WebView can close during the permission dialog. */ }
    }
    void install(android.webkit.WebView webView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(webView, "t3Notifications", Collections.singleton("https://appassets.androidplatform.net"),
            (view, message, origin, mainFrame, reply) -> {
                if (!mainFrame || !MainActivity.isAppOrigin(origin)) return;
                String raw = message.getData();
                if (raw == null || raw.length() > 65536) return;
                activity.runOnUiThread(() -> handle(raw, reply));
            });
    }
    private void handle(String raw, JavaScriptReplyProxy reply) {
        String id = "";
        try {
            JSONObject request = new JSONObject(raw); id = request.getString("id");
            JSONObject payload = request.optJSONObject("payload");
            switch (request.getString("action")) {
                case "status": break;
                case "requestPermission":
                    if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                        if (permissionReply != null) throw new JSONException("A notification permission request is already open.");
                        permissionReply = reply; permissionId = id;
                        PhoneOperations.shared().begin("permission", "notifications", PhoneOperations.UNTIL_ENDED);
                        store(activity).edit().putBoolean("permissionAsked", true).apply();
                        activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, PERMISSION); return;
                    }
                    break;
                case "configure": {
                    JSONObject prefs = payload.getJSONObject("preferences");
                    JSONArray ids = payload.getJSONArray("environmentIds");
                    JSONObject connections = read(activity, "connections");
                    if (!prefs.optBoolean("enabled")) {
                        // Opting out must not queue events for the next time alerts are enabled.
                        android.content.SharedPreferences.Editor editor = store(activity).edit();
                        connections.keys().forEachRemaining(key -> editor.remove("state:" + key));
                        editor.apply();
                        activity.getSystemService(NotificationManager.class).cancelAll();
                    }
                    java.util.Set<String> keep = new java.util.HashSet<>();
                    if (prefs.optBoolean("enabled")) for (int i = 0; i < ids.length(); i++) keep.add(ids.getString(i));
                    java.util.List<String> removed = new java.util.ArrayList<>();
                    connections.keys().forEachRemaining(key -> { if (!keep.contains(key)) removed.add(key); });
                    for (String key : removed) { connections.remove(key); store(activity).edit().remove("state:" + key).apply(); }
                    NotificationCredentials.write(activity, connections);
                    store(activity).edit().putString("preferences", prefs.toString()).putString("environmentIds", new JSONArray(keep).toString()).apply();
                    refresh(); break;
                }
                case "register": {
                    String environmentId = payload.getString("environmentId");
                    JSONArray allowedIds = new JSONArray(store(activity).getString("environmentIds", "[]"));
                    boolean active = false;
                    for (int i = 0; i < allowedIds.length(); i++) if (environmentId.equals(allowedIds.getString(i))) active = true;
                    if (!active || !read(activity, "preferences").optBoolean("enabled")) throw new JSONException("Environment alerts are disabled.");
                    String token = payload.getString("token");
                    okhttp3.HttpUrl base = okhttp3.HttpUrl.parse(payload.getString("httpBaseUrl"));
                    if (base == null || !base.username().isEmpty() || !base.password().isEmpty() || token.isEmpty() || token.length() > 8192) throw new JSONException("Invalid environment connection.");
                    JSONObject connections = read(activity, "connections");
                    connections.put(environmentId, new JSONObject().put("httpBaseUrl", base.toString()).put("token", token));
                    NotificationCredentials.write(activity, connections); refresh(); break;
                }
                case "background":
                    if (payload.getBoolean("enabled") && !allowed(activity)) throw new JSONException("Allow notifications before enabling background alerts.");
                    store(activity).edit().putBoolean("background", payload.getBoolean("enabled")).apply(); refresh(); break;
                case "test":
                    if (!allowed(activity)) throw new JSONException("Allow notifications in Android settings first.");
                    post(activity, "t3-notification-preview", "Arcwright Code", "Android notifications are working on this phone.", "/settings", true); break;
                case "settings":
                    if (Build.VERSION.SDK_INT >= 26) activity.openSettings(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName()));
                    else activity.openSettings(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + activity.getPackageName())));
                    break;
                case "battery":
                    activity.openSettings(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); break;
                default: throw new JSONException("Unknown notification action.");
            }
            respond(reply, id, status(), null);
        } catch (Exception error) { respond(reply, id, null, "Could not update Android notifications."); }
    }
    void permissionResult() {
        PhoneOperations.shared().end("permission", "notifications");
        if (permissionReply == null) return;
        try { respond(permissionReply, permissionId, status(), null); } catch (JSONException ignored) { }
        permissionReply = null; permissionId = null;
    }
    /** After an app update the foreground service is gone; try to bring back background alerts without the UI. */
    static void restartBackground(Context context) {
        if (!read(context, "preferences").optBoolean("enabled") || !allowed(context) || read(context, "connections").length() == 0
                || !store(context).getBoolean("background", false)) return;
        try { androidx.core.content.ContextCompat.startForegroundService(context, new Intent(context, AgentNotificationService.class)); }
        catch (IllegalStateException | SecurityException ignored) { /* Android may refuse; alerts resume when the app opens. */ }
    }
    void refresh() {
        boolean enabled = read(activity, "preferences").optBoolean("enabled") && allowed(activity)
            && read(activity, "connections").length() > 0 && (MainActivity.visible || store(activity).getBoolean("background", false));
        Intent intent = new Intent(activity, AgentNotificationService.class);
        // Start/update while visible. onPause keeps an already-started service alive without
        // attempting a new foreground-service start after Android's background cutoff.
        if (enabled && MainActivity.visible) {
            try { androidx.core.content.ContextCompat.startForegroundService(activity, intent); }
            catch (IllegalStateException | SecurityException ignored) { /* Retry when the app resumes. */ }
        }
        else if (!enabled) activity.stopService(intent);
    }
}
