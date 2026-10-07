package com.devotek.t3code.pwa;

import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.app.PendingIntent;
import androidx.core.app.NotificationCompat;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import okhttp3.*;
import org.json.JSONArray;
import org.json.JSONObject;

/** Read-only shell streams; no provider jobs or conversations are ever started here. */
public final class AgentNotificationService extends Service {
    private static final int ONGOING_ID = 9;
    private static final String STOP = "com.devotek.t3code.pwa.STOP_ALERTS";
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, Connection> connections = new HashMap<>();
    private final NetworkNotificationPresence presence = new NetworkNotificationPresence();
    private final PhoneAlertQueue pendingAlerts = new PhoneAlertQueue();
    private final OkHttpClient http = new OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS).pingInterval(30, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build();
    private volatile boolean destroyed;
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onCreate() {
        super.onCreate(); NativeNotifications.channels(this);
        worker.scheduleWithFixedDelay(() -> {
            if (!NativeNotifications.allowed(this)) stopSelf();
        }, 30, 30, TimeUnit.SECONDS);
        worker.scheduleWithFixedDelay(this::flushAlerts, 3, 3, TimeUnit.SECONDS);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            NativeNotifications.store(this).edit().putBoolean("background", false).apply(); stopSelf(); return START_NOT_STICKY;
        }
        if (!NativeNotifications.allowed(this) || !NativeNotifications.read(this, "preferences").optBoolean("enabled")) {
            stopSelf(); return START_NOT_STICKY;
        }
        if (!MainActivity.visible && !NativeNotifications.store(this).getBoolean("background", false)) {
            stopSelf(); return START_NOT_STICKY;
        }
        android.app.Notification notification = ongoing("Connecting to your environments");
        if (Build.VERSION.SDK_INT >= 29) startForeground(ONGOING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        else startForeground(ONGOING_ID, notification);
        worker.execute(this::sync);
        return START_STICKY;
    }
    private android.app.Notification ongoing(String text) {
        PendingIntent stop = PendingIntent.getService(this, 0, new Intent(this, AgentNotificationService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, NativeNotifications.CONNECTION)
            .setSmallIcon(R.drawable.notification_icon).setContentTitle("Arcwright Code background alerts").setContentText(text)
            .setOnlyAlertOnce(true).setOngoing(true).setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(NativeNotifications.tap(this, "/settings"))
            .addAction(0, "Stop background alerts", stop).build();
    }
    private void updateStatus() {
        if (destroyed) return;
        long live = connections.values().stream().filter(connection -> connection.connected).count();
        NativeNotifications.store(this).edit().putInt("connectedCount", (int) live).apply();
        getSystemService(android.app.NotificationManager.class).notify(ONGOING_ID,
            ongoing(live + " of " + connections.size() + " environments connected"));
    }
    private void sync() {
        if (destroyed) return;
        JSONObject desired = NativeNotifications.read(this, "connections");
        java.util.Set<String> ids = new java.util.HashSet<>();
        desired.keys().forEachRemaining(ids::add);
        presence.configure(ids, android.os.SystemClock.elapsedRealtime());
        pendingAlerts.configure(ids);
        for (String id : new java.util.ArrayList<>(connections.keySet())) {
            JSONObject value = desired.optJSONObject(id);
            if (value == null || !value.toString().equals(connections.get(id).config.toString())) {
                connections.remove(id).close();
            }
        }
        desired.keys().forEachRemaining(id -> {
            if (!connections.containsKey(id)) {
                JSONObject config = desired.optJSONObject(id);
                if (config != null) {
                    Connection connection = new Connection(id, config);
                    connections.put(id, connection); connection.connect();
                }
            }
        });
        updateStatus();
    }
    private void queueAlert(String environmentId, JSONObject thread, String kind) throws org.json.JSONException {
        long now = android.os.SystemClock.elapsedRealtime();
        pendingAlerts.offer(environmentId, thread, kind, now);
        flushAlerts();
    }
    private void flushAlerts() {
        if (destroyed) return;
        long now = android.os.SystemClock.elapsedRealtime();
        try {
            JSONArray alerts = pendingAlerts.take(now, NativeNotifications.phoneVisible(this) || presence.suppressed(now), presence.ready(now));
            for (int i = 0; i < alerts.length(); i++) {
                JSONObject alert = alerts.getJSONObject(i);
                NativeNotifications.alert(this, alert.getString("environmentId"), alert.getJSONObject("thread"), alert.getString("kind"));
            }
        } catch (org.json.JSONException ignored) { }
    }
    @Override public void onDestroy() {
        destroyed = true;
        // Evicting an idle TLS connection performs network I/O. Service.onDestroy runs on the
        // main thread, so keep both socket and pool teardown on the worker during APK replacement.
        worker.execute(() -> {
            for (Connection connection : connections.values()) connection.close();
            connections.clear();
            http.dispatcher().executorService().shutdown();
            http.connectionPool().evictAll();
        });
        worker.shutdown();
        stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy();
    }
    private final class Connection {
        final String id;
        final JSONObject config;
        final ThreadAlertState state;
        WebSocket socket;
        volatile boolean closed;
        boolean connected;
        int retries;
        Connection(String id, JSONObject config) {
            this.id = id; this.config = config;
            state = new ThreadAlertState(NativeNotifications.store(AgentNotificationService.this).getString("state:" + id, "{}"));
        }
        void connect() {
            if (closed || destroyed) return;
            try {
                HttpUrl base = HttpUrl.get(config.getString("httpBaseUrl"));
                // Each socket needs a fresh, single-use ticket. Never reuse the WebView's ticket.
                Request ticketRequest = new Request.Builder().url(base.resolve("api/auth/websocket-ticket"))
                    .header("Authorization", "Bearer " + config.getString("token"))
                    .post(RequestBody.create(new byte[0], null)).build();
                try (Response response = http.newCall(ticketRequest).execute()) {
                    if (response.code() == 401 || response.code() == 403) { closed = true; updateStatus(); return; }
                    if (!response.isSuccessful() || response.body() == null) throw new java.io.IOException("Ticket unavailable");
                    String ticket = new JSONObject(response.body().string()).getString("ticket");
                    HttpUrl address = base.resolve("ws").newBuilder().addQueryParameter("wsTicket", ticket)
                        .addQueryParameter("orchestrationProtocol", "2")
                        .addQueryParameter("clientSurface", "mobile").addQueryParameter("clientOs", "android")
                        .addQueryParameter("clientAppVersion", BuildConfig.VERSION_NAME).addQueryParameter("connectionMethod", "direct").build();
                    socket = http.newWebSocket(new Request.Builder().url(address).build(), new WebSocketListener() {
                        @Override public void onOpen(WebSocket webSocket, Response handshake) {
                            if (destroyed || closed) { webSocket.cancel(); return; }
                            try {
                                webSocket.send(new JSONObject().put("_tag", "Request").put("id", "1")
                                    .put("tag", "orchestration.subscribeShell").put("payload", new JSONObject())
                                    .put("headers", new JSONArray()).toString());
                                webSocket.send(new JSONObject().put("_tag", "Request").put("id", "2")
                                    .put("tag", "subscribeBackgroundPolicy").put("payload", new JSONObject())
                                    .put("headers", new JSONArray()).toString());
                            } catch (org.json.JSONException ignored) { webSocket.cancel(); }
                        }
                        @Override public void onMessage(WebSocket webSocket, String text) {
                            enqueue(() -> receive(webSocket, text));
                        }
                        @Override public void onClosing(WebSocket webSocket, int code, String reason) { webSocket.close(code, reason); }
                        @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) { enqueue(() -> { if (socket == webSocket) retry(); }); }
                        @Override public void onClosed(WebSocket webSocket, int code, String reason) { enqueue(() -> { if (socket == webSocket) retry(); }); }
                    });
                }
            } catch (Exception error) { retry(); }
        }
        void enqueue(Runnable action) {
            if (destroyed) return;
            try { worker.execute(action); } catch (java.util.concurrent.RejectedExecutionException ignored) { }
        }
        void receive(WebSocket webSocket, String text) {
            if (closed || destroyed || socket != webSocket) return;
            try {
                if (text.length() > 4 * 1024 * 1024) { webSocket.cancel(); retry(); return; }
                Object decoded = new org.json.JSONTokener(text).nextValue();
                JSONArray frames = decoded instanceof JSONArray ? (JSONArray) decoded : new JSONArray().put(decoded);
                for (int f = 0; f < frames.length(); f++) {
                    JSONObject frame = frames.optJSONObject(f);
                    if (frame == null) continue;
                    if ("Ping".equals(frame.optString("_tag"))) { webSocket.send("{\"_tag\":\"Pong\"}"); continue; }
                    String requestId = frame.optString("requestId");
                    if ("2".equals(requestId)) {
                        if ("Chunk".equals(frame.optString("_tag"))) {
                            JSONArray values = frame.getJSONArray("values");
                            for (int i = 0; i < values.length(); i++) presence.update(id, values.getJSONObject(i), android.os.SystemClock.elapsedRealtime());
                            webSocket.send("{\"_tag\":\"Ack\",\"requestId\":\"2\"}");
                            flushAlerts();
                        }
                        // Older hosts may reject the subscription. Their unknown lease expires
                        // instead of breaking the independent shell stream or blocking forever.
                        continue;
                    }
                    if (!"1".equals(requestId)) continue;
                    if ("Exit".equals(frame.optString("_tag"))) { webSocket.close(1000, "Subscription ended"); retry(); return; }
                    if (!"Chunk".equals(frame.optString("_tag"))) continue;
                    JSONArray values = frame.getJSONArray("values");
                    for (int i = 0; i < values.length(); i++) consume(values.getJSONObject(i));
                    webSocket.send("{\"_tag\":\"Ack\",\"requestId\":\"1\"}");
                }
                NativeNotifications.store(AgentNotificationService.this).edit().putString("state:" + id, state.save()).apply();
            } catch (Exception error) {
                android.util.Log.w("T3Alerts", "Invalid shell update: " + error.getClass().getSimpleName());
                webSocket.cancel(); retry();
            }
        }
        void consume(JSONObject item) throws org.json.JSONException {
            pendingAlerts.reconcile(id, item);
            JSONArray alerts = state.consume(item);
            if ("snapshot".equals(item.optString("kind")) && !item.has("resolvedRepositoryIdentityRoots")) {
                android.util.Log.d("T3Alerts", "Background snapshot: " + item.getJSONObject("snapshot").getJSONArray("threads").length() + " threads");
                connected = true; retries = 0; updateStatus();
            }
            for (int i = 0; i < alerts.length(); i++) {
                JSONObject alert = alerts.getJSONObject(i);
                queueAlert(id, alert.getJSONObject("thread"), alert.getString("kind"));
            }
        }
        void retry() {
            if (closed || destroyed) return;
            if (socket != null) { WebSocket old = socket; socket = null; old.cancel(); }
            connected = false; updateStatus();
            // A failed socket may report both a close and a failure. Only schedule one retry.
            if (reconnect != null && !reconnect.isDone()) return;
            long seconds = Math.min(300, 5L << Math.min(retries++, 6));
            reconnect = worker.schedule(() -> { reconnect = null; connect(); }, seconds, TimeUnit.SECONDS);
        }
        java.util.concurrent.ScheduledFuture<?> reconnect;
        void close() {
            closed = true;
            if (reconnect != null) reconnect.cancel(false);
            if (socket != null) socket.cancel();
        }
    }
}
