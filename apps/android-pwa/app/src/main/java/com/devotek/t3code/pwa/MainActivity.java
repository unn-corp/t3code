package com.devotek.t3code.pwa;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.widget.FrameLayout;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/** A hostless web client. Remote environments are authenticated by the existing Connections flow. */
public final class MainActivity extends ComponentActivity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int FILE_PICKER = 1;
    private static final int SAVE_FILE = 2;
    private static final int MEDIA_PERMISSION = 3;
    private static final int MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest mediaRequest;
    private byte[] pendingDownload;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { navigateBack(); }
        });
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        webView = new WebView(this);
        webView.setBackgroundColor(0xff101012);
        FrameLayout container = new FrameLayout(this);
        container.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        setContentView(container);
        // Inset the container: WebView padding does not constrain CSS fixed headers or the viewport.
        ViewCompat.setOnApplyWindowInsetsListener(container, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets keyboard = insets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            return insets;
        });
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        // Connections also supports explicit HTTP endpoints on private networks, as the native mobile client does.
        // Remote documents never navigate inside this WebView or receive its download bridge.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        // Release builds never expose this device's environment credentials over ADB debugging.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
            .addPathHandler("/", this::loadAsset).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request.isForMainFrame() && isAppOrigin(request.getUrl())
                        && !request.getUrl().getPath().startsWith("/api/")) return loadAsset("index.html");
                return loader.shouldInterceptRequest(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (isAppOrigin(request.getUrl())) return false;
                if (request.isForMainFrame()) openExternal(request.getUrl());
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try { startActivityForResult(params.createIntent(), FILE_PICKER); }
                catch (ActivityNotFoundException error) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    toast("No file picker is installed.");
                }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> requestMedia(request));
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (mediaRequest == request) mediaRequest = null;
            }
        });
        installDownloadBridge();
        webView.setDownloadListener((url, agent, disposition, mime, length) -> {
            Uri uri = Uri.parse(url);
            if ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) openExternal(uri);
            else toast("This download cannot be opened.");
        });
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(ORIGIN + "/settings/connections");
        }
    }

    private static boolean isAppOrigin(Uri uri) {
        return "https".equals(uri.getScheme()) && "appassets.androidplatform.net".equals(uri.getHost())
            && uri.getPort() == -1 && uri.getUserInfo() == null;
    }

    private WebResourceResponse loadAsset(String path) {
        // Only main-frame navigations fall back to the shell; missing bundles/API calls stay 404.
        if (path.isEmpty()) path = "index.html";
        if (path.contains("..") || path.contains("\\")) return missingAsset();
        try {
            InputStream data = getAssets().open(path);
            String extension = MimeTypeMap.getFileExtensionFromUrl(path);
            String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
            if (extension.equals("js") || extension.equals("mjs")) mime = "text/javascript";
            if (extension.equals("wasm")) mime = "application/wasm";
            if (mime == null) mime = "application/octet-stream";
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            headers.put("X-Content-Type-Options", "nosniff");
            return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, data);
        } catch (IOException error) { return missingAsset(); }
    }

    private static WebResourceResponse missingAsset() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
            Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private void openExternal(Uri uri) {
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme()) && !"mailto".equals(uri.getScheme())) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
        catch (ActivityNotFoundException error) { toast("No app can open this link."); }
    }

    private void requestMedia(PermissionRequest request) {
        if (!isAppOrigin(request.getOrigin()) || mediaRequest != null) { request.deny(); return; }
        ArrayList<String> permissions = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) permissions.add(Manifest.permission.RECORD_AUDIO);
            else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) permissions.add(Manifest.permission.CAMERA);
            else { request.deny(); return; }
        }
        mediaRequest = request;
        ArrayList<String> missing = new ArrayList<>();
        for (String permission : permissions) {
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
        }
        if (missing.isEmpty()) { request.grant(request.getResources()); mediaRequest = null; }
        else requestPermissions(missing.toArray(new String[0]), MEDIA_PERMISSION);
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != MEDIA_PERMISSION || mediaRequest == null) return;
        boolean granted = results.length > 0;
        for (int result : results) granted &= result == PackageManager.PERMISSION_GRANTED;
        if (granted) mediaRequest.grant(mediaRequest.getResources());
        else mediaRequest.deny();
        mediaRequest = null;
    }

    private void installDownloadBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(webView, "t3Download", Collections.singleton(ORIGIN),
            (view, message, sourceOrigin, isMainFrame, reply) -> {
                if (!isMainFrame || !isAppOrigin(sourceOrigin)) return;
                String data = message.getData();
                if (data == null || data.length() > MAX_DOWNLOAD_BYTES * 4 / 3 + 4096) return;
                runOnUiThread(() -> saveDownload(data));
            });
        // The existing web UI exports via blob anchors. Keep that UI and use Android's Save dialog.
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
        WebViewCompat.addDocumentStartJavaScript(webView, """
            document.addEventListener('click', async (event) => {
              const anchor = event.target instanceof Element ? event.target.closest('a[download]') : null;
              if (!anchor || !anchor.href.startsWith('blob:')) return;
              event.preventDefault();
              try {
                const blob = await (await fetch(anchor.href)).blob();
                if (blob.size > 33554432) throw new Error('Download exceeds 32 MB.');
                const reader = new FileReader();
                reader.onload = () => t3Download.postMessage(JSON.stringify({
                  name: anchor.download || 'download', mime: blob.type || 'application/octet-stream',
                  data: String(reader.result).split(',')[1]
                }));
                reader.readAsDataURL(blob);
              } catch (error) { alert(error.message || 'Could not save the download.'); }
            }, true);
            """, Collections.singleton(ORIGIN));
    }

    private void saveDownload(String json) {
        if (pendingDownload != null) { toast("Finish saving the current file first."); return; }
        try {
            JSONObject file = new JSONObject(json);
            byte[] bytes = Base64.decode(file.getString("data"), Base64.DEFAULT);
            if (bytes.length > MAX_DOWNLOAD_BYTES) return;
            String name = file.optString("name", "download").replaceAll("[\\\\/\\p{Cntrl}]", "_");
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
            String mime = file.optString("mime", "application/octet-stream").split(";")[0];
            intent.setType(mime.contains("/") ? mime : "application/octet-stream");
            intent.putExtra(Intent.EXTRA_TITLE, name);
            pendingDownload = bytes;
            startActivityForResult(intent, SAVE_FILE);
        } catch (JSONException | IllegalArgumentException | ActivityNotFoundException error) {
            pendingDownload = null;
            toast("Could not save the download.");
        }
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == FILE_PICKER && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
        }
        if (code == SAVE_FILE && pendingDownload != null) {
            byte[] bytes = pendingDownload;
            pendingDownload = null;
            if (result == RESULT_OK && data != null && data.getData() != null) {
                try (OutputStream stream = getContentResolver().openOutputStream(data.getData())) {
                    if (stream == null) throw new IOException("No output stream");
                    stream.write(bytes);
                    toast("File saved.");
                } catch (IOException error) { toast("Could not save the file."); }
            }
        }
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        webView.saveState(state);
        super.onSaveInstanceState(state);
    }
    @Override protected void onResume() {
        super.onResume();
        if (webView != null) { webView.onResume(); webView.evaluateJavascript("window.dispatchEvent(new Event('focus'))", null); }
    }
    @Override protected void onPause() {
        if (webView != null) {
            webView.evaluateJavascript("window.dispatchEvent(new Event('pagehide'))", null);
            webView.onPause();
        }
        super.onPause();
    }
    private void navigateBack() {
        if (webView.canGoBack()) webView.goBack();
        else finish();
    }
    @Override protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (mediaRequest != null) mediaRequest.deny();
        webView.destroy();
        super.onDestroy();
    }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_SHORT).show(); }
}
