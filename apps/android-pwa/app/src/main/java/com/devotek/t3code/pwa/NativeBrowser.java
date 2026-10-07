package com.devotek.t3code.pwa;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.KeyCharacterMap;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Phone-rendered browser tabs. Only the separate trusted shell receives a native bridge. */
final class NativeBrowser {
    private final MainActivity activity;
    private final WebView shell;
    private final FrameLayout container;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, Tab> tabs = new LinkedHashMap<>();
    private JavaScriptReplyProxy events;
    private String shownKey;
    private String shownOwner;
    private String runtime;
    private boolean destroyed;

    NativeBrowser(MainActivity activity, WebView shell, FrameLayout container) {
        this.activity = activity; this.shell = shell; this.container = container;
        try (java.io.InputStream input = activity.getAssets().open("t3-browser-runtime.js")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
            runtime = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        } catch (java.io.IOException error) { throw new IllegalStateException("Missing phone browser runtime", error); }
    }
    void install() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(shell, "t3Browser", Collections.singleton("https://appassets.androidplatform.net"),
            (view, message, origin, mainFrame, reply) -> {
                if (!mainFrame || !MainActivity.isAppOrigin(origin)) return;
                String raw = message.getData();
                if (raw == null || raw.length() > 131072) return;
                activity.runOnUiThread(() -> handle(raw, reply));
            });
    }
    private void reply(JavaScriptReplyProxy target, String id, Object value, String error) {
        // Every browser command finishes through this method, including failures, so it is the one place that
        // releases the hold an automatic app update keeps while the phone is controlled.
        PhoneOperations.shared().end("browser", id);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        try {
            JSONObject result = new JSONObject().put("id", id);
            if (error == null) result.put("result", value == null ? JSONObject.NULL : value);
            else result.put("error", error);
            target.postMessage(result.toString());
        } catch (JSONException | IllegalStateException ignored) { /* The shell can reload during an operation. */ }
    }
    private void handle(String raw, JavaScriptReplyProxy reply) {
        String id = "";
        try {
            JSONObject request = new JSONObject(raw); id = request.getString("id");
            String action = request.getString("action");
            JSONObject payload = request.optJSONObject("payload");
            if (payload == null) payload = new JSONObject();
            events = reply;
            if (destroyed) throw new IllegalStateException("Phone browser is closed");
            if (!"close".equals(action) && !"hide".equals(action)) PhoneOperations.shared().requireOpen();
            switch (action) {
                case "retainEnvironments": {
                    JSONArray ids = payload.getJSONArray("environmentIds");
                    java.util.Set<String> keep = new java.util.HashSet<>();
                    for (int i = 0; i < ids.length(); i++) keep.add(ids.getString(i));
                    for (Tab tab : new java.util.ArrayList<>(tabs.values())) if (!keep.contains(tab.environmentId)) close(tab.key);
                    break;
                }
                case "ensure": {
                    Tab tab = ensure(payload);
                    reply(reply, id, status(tab), null); return;
                }
                case "surface": surface(payload); break;
                case "hide":
                    if (payload.getString("owner").equals(shownOwner)) hide();
                    break;
                case "close": close(payload.getString("key")); break;
                case "command": {
                    // Held from here until reply(); a lease expires it if a callback is ever lost.
                    PhoneOperations.shared().begin("browser", id, PhoneOperations.BROWSER_LEASE_MS);
                    if (!MainActivity.visible) throw new IllegalStateException("Open Arcwright Code on the phone to control its browser");
                    Tab tab = tabs.get(payload.getString("key"));
                    if (tab == null) throw new IllegalArgumentException("Phone browser tab is no longer open");
                    command(tab, payload.getString("operation"), payload.optJSONObject("input"), reply, id); return;
                }
                default: throw new IllegalArgumentException("Unknown phone browser action");
            }
            reply(reply, id, new JSONObject(), null);
        } catch (Exception error) { reply(reply, id, null, error.getMessage()); }
    }
    private Tab ensure(JSONObject payload) throws JSONException {
        String key = payload.getString("key");
        String environmentId = payload.getString("environmentId");
        String epoch = payload.optString("serverEpoch", "");
        for (Tab old : new java.util.ArrayList<>(tabs.values())) {
            if (old.environmentId.equals(environmentId) && !old.epoch.equals(epoch)) close(old.key);
        }
        Tab tab = tabs.get(key);
        if (tab == null) {
            if (tabs.size() >= 8) throw new IllegalStateException("Close a phone browser tab before opening another (maximum 8)");
            tab = new Tab(key, environmentId, epoch, payload.getString("threadId"), payload.getString("tabId"));
            tabs.put(key, tab);
        }
        String url = payload.optString("url", "about:blank");
        if (!tab.started) navigate(tab, url);
        report(tab);
        return tab;
    }
    private void navigate(Tab tab, String url) {
        if (!BrowserPolicy.allowedUrl(url)) throw new IllegalArgumentException("Only http and https pages can open in the phone browser");
        beginNavigation(tab);
        tab.started = true; tab.failed = false; tab.loading = true; tab.url = url;
        try { tab.webView.loadUrl(url); }
        catch (RuntimeException error) { endNavigation(tab); throw error; }
    }
    private void beginNavigation(Tab tab) {
        // Page loading continues after a readiness:none command replies. Keep that work held separately.
        PhoneOperations.shared().begin("navigation", tab.key, PhoneOperations.UNTIL_ENDED);
    }
    private void endNavigation(Tab tab) { PhoneOperations.shared().end("navigation", tab.key); }
    private void surface(JSONObject payload) throws JSONException {
        Tab tab = tabs.get(payload.getString("key"));
        if (tab == null) throw new IllegalArgumentException("Phone browser tab is no longer open");
        String owner = payload.getString("owner");
        if (!payload.optBoolean("visible", true)) {
            if (owner.equals(shownOwner)) hide();
            return;
        }
        // Positions are measured in the shell's CSS pixels, including fold/IME resize.
        double shellWidth = payload.getDouble("shellWidth");
        if (shellWidth <= 0) throw new IllegalArgumentException("Invalid shell width");
        float scale = (float) (shell.getWidth() / shellWidth);
        int width = BrowserPolicy.pixels(payload.getDouble("width"), scale);
        int height = BrowserPolicy.pixels(payload.getDouble("height"), scale);
        if (width < 1 || height < 1) { if (owner.equals(shownOwner)) hide(); return; }
        int x = BrowserPolicy.pixels(payload.getDouble("x"), scale);
        int y = BrowserPolicy.pixels(payload.getDouble("y"), scale);
        width = Math.min(width, shell.getWidth() - x); height = Math.min(height, shell.getHeight() - y);
        if (width < 1 || height < 1) { if (owner.equals(shownOwner)) hide(); return; }
        if (!tab.key.equals(shownKey)) hide();
        FrameLayout.LayoutParams bounds = new FrameLayout.LayoutParams(width, height);
        bounds.leftMargin = x; bounds.topMargin = y;
        tab.webView.setLayoutParams(bounds);
        tab.webView.setVisibility(MainActivity.visible ? View.VISIBLE : View.INVISIBLE);
        tab.webView.bringToFront();
        shownKey = tab.key; shownOwner = owner;
        presentation(tab, MainActivity.visible);
    }
    private void hide() {
        if (shownKey != null && tabs.containsKey(shownKey)) {
            Tab tab = tabs.get(shownKey); tab.webView.setVisibility(View.INVISIBLE); presentation(tab, false);
        }
        shownKey = null; shownOwner = null;
    }
    private void close(String key) {
        Tab tab = tabs.get(key);
        if (tab == null) return;
        if (key.equals(shownKey)) hide();
        tabs.remove(key);
        tab.closed = true; container.removeView(tab.webView); tab.webView.stopLoading(); tab.webView.destroy(); endNavigation(tab);
        if (events != null && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) try {
            events.postMessage(new JSONObject().put("closed", key).toString());
        } catch (JSONException | IllegalStateException ignored) { }
    }
    void shellNavigating() { hide(); events = null; }
    private void foreground(boolean value) {
        if (events == null || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        try { events.postMessage(new JSONObject().put("foreground", value).toString()); }
        catch (JSONException | IllegalStateException ignored) { }
    }
    void pause() { foreground(false); for (Tab tab : tabs.values()) { tab.webView.onPause(); tab.webView.setVisibility(View.INVISIBLE); presentation(tab, false); } }
    void resume() { foreground(true); for (Tab tab : tabs.values()) tab.webView.onResume();
        if (shownKey != null && tabs.containsKey(shownKey)) { Tab tab = tabs.get(shownKey); tab.webView.setVisibility(View.VISIBLE); presentation(tab, true); }
    }
    boolean goBack() {
        Tab tab = tabs.get(shownKey);
        if (tab == null || !tab.webView.canGoBack()) return false;
        beginNavigation(tab); tab.webView.goBack(); return true;
    }
    void destroy() { destroyed = true; handler.removeCallbacksAndMessages(null);
        for (String key : new java.util.ArrayList<>(tabs.keySet())) close(key);
    }
    private void presentation(Tab tab, boolean visible) {
        if (events == null || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        try { events.postMessage(new JSONObject().put("presentation", new JSONObject().put("key", tab.key).put("visible", visible)).toString()); }
        catch (JSONException | IllegalStateException ignored) { }
    }
    private JSONObject status(Tab tab) throws JSONException {
        return new JSONObject().put("available", !tab.closed && MainActivity.visible).put("visible", tab.key.equals(shownKey) && MainActivity.visible)
            .put("tabId", tab.tabId).put("url", tab.url).put("title", tab.title).put("loading", tab.loading)
            .put("viewport", new JSONObject().put("width", Math.max(1, Math.round(tab.webView.getWidth() / tab.webView.getScale())))
                .put("height", Math.max(1, Math.round(tab.webView.getHeight() / tab.webView.getScale()))));
    }
    private void report(Tab tab) {
        if (tab.closed || events == null) return;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        try {
            JSONObject nav = new JSONObject().put("_tag", tab.failed ? "LoadFailed" : tab.loading ? "Loading" : "Success")
                .put("url", tab.url).put("title", tab.title);
            if ("about:blank".equals(tab.url)) nav = new JSONObject().put("_tag", "Idle");
            if (tab.failed) nav.put("code", tab.errorCode).put("description", tab.errorDescription);
            events.postMessage(new JSONObject().put("event", new JSONObject().put("key", tab.key).put("environmentId", tab.environmentId)
                .put("threadId", tab.threadId).put("tabId", tab.tabId).put("navStatus", nav)
                .put("visible", tab.key.equals(shownKey) && MainActivity.visible)
                .put("canGoBack", tab.webView.canGoBack()).put("canGoForward", tab.webView.canGoForward())).toString());
        } catch (JSONException | IllegalStateException ignored) { }
    }
    private void command(Tab tab, String operation, JSONObject input, JavaScriptReplyProxy target, String id) throws JSONException {
        if (input == null) input = new JSONObject();
        switch (operation) {
            case "status": reply(target, id, status(tab), null); return;
            case "navigate": {
                navigate(tab, input.getString("url"));
                if ("none".equals(input.optString("readiness"))) { reply(target, id, status(tab), null); return; }
                waitNavigation(tab, target, id, SystemClock.uptimeMillis() + Math.min(60000, input.optInt("timeoutMs", 15000))); return;
            }
            case "back": case "forward": case "refresh": {
                if (("back".equals(operation) && !tab.webView.canGoBack()) ||
                    ("forward".equals(operation) && !tab.webView.canGoForward())) break;
                beginNavigation(tab);
                tab.loading = true; tab.failed = false;
                if ("back".equals(operation)) tab.webView.goBack();
                else if ("forward".equals(operation)) tab.webView.goForward();
                else tab.webView.reload();
                waitNavigation(tab, target, id, SystemClock.uptimeMillis() + Math.min(60000, input.optInt("timeoutMs", 15000))); return;
            }
            case "press": press(tab, input); break;
            case "snapshot": {
                evaluate(tab, "snapshot", input, target, id, true); return;
            }
            case "click": {
                evaluate(tab, "click", input, target, id, false); return;
            }
            case "type": case "scroll": case "evaluate": case "waitFor":
                evaluate(tab, operation, input, target, id, false); return;
            default: throw new IllegalArgumentException("This operation is not supported by the phone browser");
        }
        reply(target, id, new JSONObject().put("tabId", tab.tabId), null);
    }
    private void waitNavigation(Tab tab, JavaScriptReplyProxy target, String id, long deadline) {
        if (tab.closed || destroyed) { reply(target, id, null, "Phone browser tab closed during navigation"); return; }
        if (tab.failed) { reply(target, id, null, tab.errorDescription); return; }
        if (!tab.loading) { try { reply(target, id, status(tab), null); } catch (JSONException ignored) { } return; }
        if (SystemClock.uptimeMillis() >= deadline) { reply(target, id, null, "Phone browser navigation timed out"); return; }
        handler.postDelayed(() -> waitNavigation(tab, target, id, deadline), 80);
    }
    private void touch(Tab tab, double x, double y) {
        float scale = tab.webView.getScale();
        long time = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(time, time, MotionEvent.ACTION_DOWN, (float) x * scale, (float) y * scale, 0);
        MotionEvent up = MotionEvent.obtain(time, time + 30, MotionEvent.ACTION_UP, (float) x * scale, (float) y * scale, 0);
        down.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        up.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
        tab.webView.dispatchTouchEvent(down); down.recycle();
        handler.postDelayed(() -> {
            if (!tab.closed && !destroyed) tab.webView.dispatchTouchEvent(up);
            up.recycle();
        }, 30);
    }
    private void press(Tab tab, JSONObject input) throws JSONException {
        String key = input.getString("key");
        int code = switch (key) {
            case "Enter" -> KeyEvent.KEYCODE_ENTER; case "Tab" -> KeyEvent.KEYCODE_TAB;
            case "Escape" -> KeyEvent.KEYCODE_ESCAPE; case "Backspace" -> KeyEvent.KEYCODE_DEL;
            case "Delete" -> KeyEvent.KEYCODE_FORWARD_DEL; case "ArrowUp" -> KeyEvent.KEYCODE_DPAD_UP;
            case "ArrowDown" -> KeyEvent.KEYCODE_DPAD_DOWN; case "ArrowLeft" -> KeyEvent.KEYCODE_DPAD_LEFT;
            case "ArrowRight" -> KeyEvent.KEYCODE_DPAD_RIGHT; case "Home" -> KeyEvent.KEYCODE_MOVE_HOME;
            case "End" -> KeyEvent.KEYCODE_MOVE_END; case "PageDown" -> KeyEvent.KEYCODE_PAGE_DOWN;
            case "PageUp" -> KeyEvent.KEYCODE_PAGE_UP; case " " -> KeyEvent.KEYCODE_SPACE;
            default -> KeyEvent.KEYCODE_UNKNOWN;
        };
        int modifiers = 0; JSONArray mods = input.optJSONArray("modifiers");
        if (mods != null) for (int i = 0; i < mods.length(); i++) modifiers |= switch (mods.getString(i)) {
            case "Control" -> KeyEvent.META_CTRL_ON; case "Alt" -> KeyEvent.META_ALT_ON;
            case "Shift" -> KeyEvent.META_SHIFT_ON; case "Meta" -> KeyEvent.META_META_ON; default -> 0;
        };
        if (key.length() == 1) {
            KeyEvent[] characters = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(key.toCharArray());
            if (characters == null) throw new IllegalArgumentException("Use type for characters unavailable on the Android keyboard");
            for (KeyEvent character : characters) tab.webView.dispatchKeyEvent(new KeyEvent(character.getDownTime(), character.getEventTime(),
                character.getAction(), character.getKeyCode(), character.getRepeatCount(), character.getMetaState() | modifiers));
            return;
        }
        if (code == KeyEvent.KEYCODE_UNKNOWN) throw new IllegalArgumentException("Unsupported phone browser key");
        long time = SystemClock.uptimeMillis();
        tab.webView.dispatchKeyEvent(new KeyEvent(time, time, KeyEvent.ACTION_DOWN, code, 0, modifiers));
        tab.webView.dispatchKeyEvent(new KeyEvent(time, time, KeyEvent.ACTION_UP, code, 0, modifiers));
    }
    private void evaluate(Tab tab, String operation, JSONObject input, JavaScriptReplyProxy target, String id, boolean screenshot) {
        String resultKey = "__t3_result_" + UUID.randomUUID().toString().replace("-", "");
        String quoted = JSONObject.quote(resultKey);
        String source = "(()=>{window[" + quoted + "]={done:false};Promise.resolve().then(()=> (" + runtime + ")(" + JSONObject.quote(operation) + "," + input + "))"
            + ".then(value=>{const json=JSON.parse(JSON.stringify(value??null));window[" + quoted + "]={done:true,value:json}})"
            + ".catch(error=>window[" + quoted + "]={done:true,error:String(error.message||error)});return true})()";
        tab.webView.evaluateJavascript(source, ignored -> pollEvaluation(tab, resultKey, target, id, screenshot, operation,
            SystemClock.uptimeMillis() + Math.min(60000, input.optInt("timeoutMs", 15000))));
    }
    private void pollEvaluation(Tab tab, String key, JavaScriptReplyProxy target, String id, boolean screenshot, String operation, long deadline) {
        if (tab.closed || destroyed) { reply(target, id, null, "Phone browser tab closed during evaluation"); return; }
        tab.webView.evaluateJavascript("window[" + JSONObject.quote(key) + "]||null", raw -> {
            try {
                Object parsed = new JSONTokener(raw).nextValue();
                if (parsed instanceof JSONObject result && result.optBoolean("done")) {
                    tab.webView.evaluateJavascript("delete window[" + JSONObject.quote(key) + "]", null);
                    if (result.has("error")) { reply(target, id, null, result.getString("error")); return; }
                    Object value = result.opt("value");
                    if ("click".equals(operation) && value instanceof JSONObject point) {
                        touch(tab, point.getDouble("x"), point.getDouble("y"));
                        value = new JSONObject().put("tabId", tab.tabId);
                    }
                    if (screenshot && value instanceof JSONObject snapshot) {
                        capture(tab, snapshot, target, id); return;
                    }
                    reply(target, id, value, null); return;
                }
                if (SystemClock.uptimeMillis() >= deadline) {
                    tab.webView.evaluateJavascript("delete window[" + JSONObject.quote(key) + "]", null);
                    reply(target, id, null, "Phone browser evaluation timed out"); return;
                }
                handler.postDelayed(() -> pollEvaluation(tab, key, target, id, screenshot, operation, deadline), 50);
            } catch (Exception error) { reply(target, id, null, error.getMessage()); }
        });
    }
    private void capture(Tab tab, JSONObject snapshot, JavaScriptReplyProxy target, String id) {
        if (!tab.key.equals(shownKey) || !tab.webView.isShown()) {
            reply(target, id, null, "Show the phone browser before taking a screenshot"); return;
        }
        int width = Math.max(1, tab.webView.getWidth()), height = Math.max(1, tab.webView.getHeight());
        float scale = Math.min(1f, 1600f / Math.max(width, height));
        Bitmap bitmap = Bitmap.createBitmap(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), Bitmap.Config.ARGB_8888);
        java.util.function.IntConsumer complete = result -> {
            try {
                if (tab.closed || destroyed || !tab.key.equals(shownKey) || !MainActivity.visible)
                    reply(target, id, null, "Phone browser closed or hidden during screenshot");
                else if (result != 0) reply(target, id, null, "Phone browser screenshot failed; retry after the page is visible");
                else {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes);
                    snapshot.put("screenshot", new JSONObject().put("mimeType", "image/png").put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
                        .put("width", bitmap.getWidth()).put("height", bitmap.getHeight()));
                    reply(target, id, snapshot, null);
                }
            } catch (Exception error) { reply(target, id, null, error.getMessage()); }
            finally { bitmap.recycle(); }
        };
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            int[] location = new int[2]; tab.webView.getLocationInWindow(location);
            android.graphics.Rect bounds = new android.graphics.Rect(location[0], location[1], location[0] + width, location[1] + height);
            try { android.view.PixelCopy.request(activity.getWindow(), bounds, bitmap, complete::accept, handler); }
            catch (RuntimeException error) { bitmap.recycle(); reply(target, id, null, error.getMessage()); }
        } else {
            Canvas canvas = new Canvas(bitmap); canvas.scale(scale, scale); tab.webView.draw(canvas); complete.accept(0);
        }
    }
    private final class Tab {
        final String key, environmentId, epoch, threadId, tabId;
        final WebView webView;
        String url = "about:blank", title = "", errorDescription = "";
        boolean started, loading, failed, closed;
        int errorCode;
        Tab(String key, String environmentId, String epoch, String threadId, String tabId) {
            this.key = key; this.environmentId = environmentId; this.epoch = epoch; this.threadId = threadId; this.tabId = tabId;
            webView = new WebView(activity);
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setSupportZoom(true); settings.setBuiltInZoomControls(true); settings.setDisplayZoomControls(false);
            settings.setUseWideViewPort(true); settings.setLoadWithOverviewMode(true);
            settings.setMediaPlaybackRequiresUserGesture(true);
            // Unstyled web pages use black text and expect the browser's white canvas.
            webView.setBackgroundColor(0xffffffff);
            webView.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    if (!BrowserPolicy.allowedUrl(request.getUrl().toString())) return true;
                    if (request.isForMainFrame()) {
                        try { beginNavigation(Tab.this); }
                        catch (IllegalStateException error) { return true; }
                    }
                    return false;
                }
                @Override public void onPageStarted(WebView view, String next, Bitmap icon) {
                    if (closed || !BrowserPolicy.allowedUrl(next)) { view.stopLoading(); endNavigation(Tab.this); return; }
                    try { beginNavigation(Tab.this); }
                    catch (IllegalStateException error) { view.stopLoading(); loading = false; failed = true; errorDescription = error.getMessage(); report(Tab.this); return; }
                    url = next; loading = true; failed = false; report(Tab.this);
                }
                @Override public void onPageFinished(WebView view, String next) {
                    // An obsolete main-frame callback must not finish a newer navigation.
                    if (closed || !next.equals(view.getUrl()) || view.getProgress() < 100) return;
                    endNavigation(Tab.this);
                    if (BrowserPolicy.allowedUrl(next)) url = next;
                    title = view.getTitle() == null ? "" : view.getTitle(); loading = false; report(Tab.this);
                }
                @Override public void doUpdateVisitedHistory(WebView view, String next, boolean reload) {
                    url = next; report(Tab.this);
                }
                @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    if (!request.isForMainFrame() || !request.getUrl().toString().equals(view.getUrl())) return;
                    endNavigation(Tab.this);
                    loading = false; failed = true; errorCode = error.getErrorCode(); errorDescription = error.getDescription().toString(); report(Tab.this);
                }
                @Override public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
                    handler.cancel();
                    if (!error.getUrl().equals(view.getUrl())) return;
                    endNavigation(Tab.this); loading = false; failed = true; errorCode = WebViewClient.ERROR_FAILED_SSL_HANDSHAKE;
                    errorDescription = "The page certificate could not be verified."; report(Tab.this);
                }
            });
            webView.setWebChromeClient(new WebChromeClient() {
                @Override public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<android.net.Uri[]> callback, FileChooserParams params) {
                    return activity.chooseFile(callback, params);
                }
                @Override public void onReceivedTitle(WebView view, String next) { title = next == null ? "" : next; report(Tab.this); }
            });
            webView.setVisibility(View.INVISIBLE);
            container.addView(webView, new FrameLayout.LayoutParams(400, 600));
        }
    }
}
