package com.devotek.t3code.pwa;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Exercises the release bridge and actual phone WebView with an in-memory page, never a provider. */
public final class BrowserSmokeInstrumentation extends Instrumentation {
    private WebView shell;
    private int sequence;
    private ServerSocket server;
    private String environmentId;
    private boolean testFold;
    private String stage = "startup";
    private static final String KEY = "phone-browser-instrumentation";
    private static final String PAGE = """
        <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Phone browser fixture</title><style>body{font:20px sans-serif;margin:12px}input,button{font:20px sans-serif;padding:12px}</style>
        <label for="message">Message</label><input id="message"><button id="send" onclick="document.querySelector('#result').textContent=document.querySelector('#message').value">Send</button>
        <p id="result">Ready</p><a href="/next">Next page</a><div style="height:2000px">Scroll content</div>
        """;
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        environmentId = arguments.getString("environmentId");
        testFold = "true".equals(arguments.getString("testFold"));
        start();
    }
    @Override public void onStart() {
        Bundle receipt = new Bundle();
        int resultCode = android.app.Activity.RESULT_CANCELED;
        try {
            require(environmentId != null && !environmentId.isBlank(), "Pass an enabled environmentId; the test only creates an unsaved synthetic tab");
            server = new ServerSocket(0);
            Thread pages = new Thread(() -> {
                while (!server.isClosed()) try (Socket socket = server.accept()) {
                    byte[] request = new byte[4096]; socket.getInputStream().read(request);
                    byte[] body = PAGE.getBytes(StandardCharsets.UTF_8);
                    socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    socket.getOutputStream().write(body);
                } catch (java.io.IOException ignored) { }
            }, "phone-browser-fixture"); pages.setDaemon(true); pages.start();
            Intent launch = new Intent(Intent.ACTION_MAIN).setClassName(getTargetContext().getPackageName(), "com.devotek.t3code.pwa.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            android.app.Activity activity = startActivitySync(launch);
            runOnMainSync(() -> {
                activity.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                shell = findShell(activity.getWindow().getDecorView());
            });
            require(shell != null, "Trusted shell missing");
            await("typeof window.t3Browser?.onmessage==='function'", 20000);
            eval("window.__phoneSmokePrevious=window.t3Browser.onmessage;window.__phoneSmokeReplies={};window.t3Browser.onmessage=e=>{try{const r=JSON.parse(e.data);if(r.id&&r.id.startsWith('smoke:'))window.__phoneSmokeReplies[r.id]=r;}catch{}window.__phoneSmokePrevious?.(e)};true");
            String url = "http://127.0.0.1:" + server.getLocalPort() + "/";
            request("ensure", new JSONObject().put("key", KEY).put("environmentId", environmentId).put("threadId", "synthetic").put("tabId", "synthetic").put("url", url));
            JSONObject dimensions = (JSONObject) eval("({width:innerWidth,height:innerHeight})");
            request("surface", bounds(dimensions, .80));
            command("navigate", new JSONObject().put("url", url));
            JSONObject snapshot = (JSONObject) command("snapshot", new JSONObject());
            require(snapshot.getString("title").equals("Phone browser fixture"), "Native page did not load");
            require(snapshot.getJSONObject("screenshot").getString("data").length() > 100, "Screenshot missing");
            require(snapshot.getJSONArray("interactiveElements").length() >= 3, "No agent locators");
            stage = "typing and native tap";
            command("type", new JSONObject().put("locator", "role=textbox[name='Message']").put("text", "Phone test").put("clear", true));
            command("press", new JSONObject().put("key", "1"));
            command("press", new JSONObject().put("key", "."));
            Object typed = command("evaluate", new JSONObject().put("expression", "document.querySelector('#message').value"));
            require("Phone test1.".equals(typed), "Native keys produced: " + typed);
            command("evaluate", new JSONObject().put("expression", "window.__touchTrace=[];['pointerdown','pointerup','click'].forEach(type=>document.addEventListener(type,e=>__touchTrace.push({type,target:e.target.id,x:e.clientX,y:e.clientY})));true"));
            command("click", new JSONObject().put("locator", "role=button[name='Send']"));
            command("waitFor", new JSONObject().put("text", "Phone test1.").put("timeoutMs", 3000));
            require("Phone test1.".equals(command("evaluate", new JSONObject().put("expression", "document.querySelector('#result').textContent"))), "Native tap/keyboard did not activate page");
            require(Boolean.TRUE.equals(command("evaluate", new JSONObject().put("expression", "typeof t3Browser==='undefined' && typeof t3Notifications==='undefined' && typeof t3Download==='undefined'"))), "A native bridge leaked into a browser page");
            stage = "resize";
            JSONObject before = (JSONObject) command("evaluate", new JSONObject().put("expression", "({width:innerWidth,height:innerHeight})"));
            request("surface", bounds(dimensions, .45));
            Object resized = command("evaluate", new JSONObject().put("expression", "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({width:innerWidth,height:innerHeight}))))"));
            require(resized instanceof JSONObject && ((JSONObject) resized).getInt("width") < before.getInt("width"), "Phone viewport did not resize live");
            if (testFold) {
                stage = "folded display";
                shellCommand("cmd device_state state 0");
                JSONObject folded = (JSONObject) await("innerWidth!==" + dimensions.getInt("width") + "&&({width:innerWidth,height:innerHeight})", 15000);
                request("surface", bounds(folded, .80));
                JSONObject foldedPage = (JSONObject) command("evaluate", new JSONObject().put("expression", "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({width:innerWidth,height:innerHeight}))))"));
                require(foldedPage.getInt("width") < before.getInt("width"), "Browser did not adapt to cover screen");
                receipt.putString("foldedViewport", foldedPage.toString());
                receipt.putString("foldedResolution", shellCommand("wm size"));
                stage = "unfolded display";
                shellCommand("cmd device_state state 3");
                JSONObject unfolded = (JSONObject) await("innerWidth===" + dimensions.getInt("width") + "&&({width:innerWidth,height:innerHeight})", 15000);
                request("surface", bounds(unfolded, .80));
                JSONObject unfoldedPage = (JSONObject) command("evaluate", new JSONObject().put("expression", "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({width:innerWidth,height:innerHeight}))))"));
                require(unfoldedPage.getInt("width") > foldedPage.getInt("width"), "Browser did not adapt to inner screen");
                receipt.putString("unfoldedViewport", unfoldedPage.toString());
                receipt.putString("unfoldedResolution", shellCommand("wm size"));
            }
            stage = "scroll and history";
            command("scroll", new JSONObject().put("deltaY", 500));
            require(((Number) command("evaluate", new JSONObject().put("expression", "scrollY"))).intValue() > 0, "Native page did not scroll");
            command("navigate", new JSONObject().put("url", url + "next"));
            command("back", new JSONObject());
            command("waitFor", new JSONObject().put("text", "Ready"));
            request("hide", new JSONObject().put("owner", "phone-smoke-owner"));
            require(!((JSONObject) command("status", new JSONObject())).getBoolean("visible"), "Browser did not hide");
            receipt.putString("result", "Native navigation, screenshot, semantic typing, digit/punctuation keys, real touch click, bridge isolation, live resize, scroll, history and hide verified");
            resultCode = android.app.Activity.RESULT_OK;
        } catch (Throwable error) {
            receipt.putString("failure", stage + ": " + error);
            try {
                receipt.putString("pageDiagnostic", String.valueOf(command("evaluate", new JSONObject().put("expression", "({trace:window.__touchTrace,result:document.querySelector('#result')?.textContent,input:document.querySelector('#message')?.value,viewport:{width:innerWidth,height:innerHeight,scale:visualViewport.scale,dpr:devicePixelRatio},button:document.querySelector('#send')?.getBoundingClientRect().toJSON()})"))));
                receipt.putString("nativeDiagnostic", String.valueOf(command("status", new JSONObject())));
            } catch (Exception ignored) { }
        } finally {
            if (testFold) try { shellCommand("cmd device_state state reset"); } catch (Exception ignored) { }
            try { if (shell != null) { request("close", new JSONObject().put("key", KEY)); eval("window.t3Browser.onmessage=window.__phoneSmokePrevious;delete window.__phoneSmokeReplies;delete window.__phoneSmokePrevious;true"); } } catch (Exception ignored) { }
            try { if (server != null) server.close(); } catch (Exception ignored) { }
        }
        finish(resultCode, receipt);
    }
    private String shellCommand(String command) throws Exception {
        try (android.os.ParcelFileDescriptor descriptor = getUiAutomation().executeShellCommand(command);
             java.io.InputStream stream = new android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor);
             java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int read;
            while ((read = stream.read(buffer)) != -1) output.write(buffer, 0, read);
            return output.toString(StandardCharsets.UTF_8);
        }
    }
    private JSONObject bounds(JSONObject dimensions, double fraction) throws Exception {
        return new JSONObject().put("key", KEY).put("owner", "phone-smoke-owner").put("x", 10).put("y", 120)
            .put("width", dimensions.getDouble("width") * fraction).put("height", Math.max(200, dimensions.getDouble("height") - 150))
            .put("shellWidth", dimensions.getDouble("width")).put("visible", true);
    }
    private Object command(String operation, JSONObject input) throws Exception {
        return request("command", new JSONObject().put("key", KEY).put("operation", operation).put("input", input));
    }
    private Object request(String action, JSONObject payload) throws Exception {
        String id = "smoke:" + ++sequence;
        eval("window.t3Browser.postMessage(" + JSONObject.quote(new JSONObject().put("id", id).put("action", action).put("payload", payload).toString()) + ");true");
        Object result = await("window.__phoneSmokeReplies[" + JSONObject.quote(id) + "]||null", 20000);
        JSONObject response = (JSONObject) result;
        if (response.has("error")) throw new IllegalStateException(action + "/" + payload.optString("operation") + ": " + response.getString("error"));
        return response.opt("result");
    }
    private Object await(String expression, long timeout) throws Exception {
        long deadline = SystemClock.uptimeMillis() + timeout;
        do {
            Object value = eval(expression);
            if (value != null && value != JSONObject.NULL && !Boolean.FALSE.equals(value)) return value;
            Thread.sleep(40);
        } while (SystemClock.uptimeMillis() < deadline);
        throw new IllegalStateException("Timed out: " + expression);
    }
    private Object eval(String expression) throws Exception {
        CountDownLatch done = new CountDownLatch(1); String[] value = new String[1];
        runOnMainSync(() -> shell.evaluateJavascript(expression, result -> { value[0] = result; done.countDown(); }));
        require(done.await(5, TimeUnit.SECONDS), "Shell evaluation timed out");
        return new JSONTokener(value[0]).nextValue();
    }
    private static WebView findShell(View view) {
        if (view instanceof WebView webView && webView.getUrl() != null && webView.getUrl().startsWith("https://appassets.androidplatform.net")) return webView;
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) { WebView found = findShell(group.getChildAt(i)); if (found != null) return found; }
        return null;
    }
    private static void require(boolean condition, String message) { if (!condition) throw new IllegalStateException(message); }
}
