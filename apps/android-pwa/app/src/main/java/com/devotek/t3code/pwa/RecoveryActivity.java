package com.devotek.t3code.pwa;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Native recovery with no WebView and no bridge, so it still opens when the bundled shell is broken.
 * It opens before the shell after repeated unhealthy launches or a failed identity check, and from the
 * launcher shortcut. It can only install builds that were digest- and signer-verified into the cache; it
 * never uninstalls or clears data, so pairings, drafts, and queues stay in place.
 */
@android.annotation.SuppressLint("InlinedApi") // The install permission screen is only offered where the updater is supported (API 28+).
public final class RecoveryActivity extends Activity {
    static final String BYPASS = "t3.recovery.bypass";
    static volatile boolean visible;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(task -> new Thread(task, "t3-recovery"));
    private final Runnable refresher = () -> runOnUiThread(this::render);
    private UpdateEngine engine;
    private LinearLayout content;
    private volatile boolean busy;

    static Intent intent(Context context) {
        return new Intent(context, RecoveryActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        engine = UpdateEngine.get(this);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xff101012);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        content.setPadding(pad, pad * 2, pad, pad);
        scroll.addView(content);
        scroll.setFitsSystemWindows(true);
        setContentView(scroll);
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        NativeSettings.returned(this, code);
    }

    @Override protected void onResume() { super.onResume(); visible = true; engine.foreground(true); engine.addListener(refresher); render(); }
    @Override protected void onPause() { visible = false; engine.foreground(false); engine.removeListener(refresher); super.onPause(); }
    @Override protected void onDestroy() { worker.shutdown(); super.onDestroy(); }

    private TextView text(String value, int sp, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value); view.setTextColor(bold ? 0xfff4f4f5 : 0xffc4c4cc); view.setTextSize(sp);
        if (bold) view.setTypeface(view.getTypeface(), android.graphics.Typeface.BOLD);
        view.setPadding(0, 0, 0, (int) (10 * getResources().getDisplayMetrics().density));
        return view;
    }

    private Button button(String label, View.OnClickListener action) {
        Button button = new Button(this);
        button.setText(label); button.setAllCaps(false); button.setOnClickListener(action); button.setEnabled(!busy);
        button.setGravity(Gravity.CENTER);
        return button;
    }

    private void render() {
        content.removeAllViews();
        JSONObject status = engine.status();
        JSONObject current = status.optJSONObject("current"), policy = status.optJSONObject("policy");
        content.addView(text("Arcwright Code recovery", 24, true));
        content.addView(text("This screen runs without the app interface. Your paired hosts, drafts, and queued work stay on this phone; "
            + "nothing here uninstalls the app or clears its data.", 15, false));
        if (current != null) {
            String commit = current.optString("commit");
            content.addView(text("Installed: " + VersionLabels.format(current.optString("version"), current.optString("upstreamVersion"), current.optInt("forkBuildNumber")) + " (Android code " + current.optLong("versionCode") + ", source "
                + (commit.length() > 8 ? commit.substring(0, 8) : commit) + ")", 15, false));
        }
        if (policy != null) {
            JSONObject pin = policy.optJSONObject("pin");
            content.addView(text("Channel: " + policy.optString("channel") + ". Automatic installation: "
                + (policy.optBoolean("automaticInstallation") ? "on" : "off") + ".", 15, false));
            if (pin != null) content.addView(text("Updates are pinned to " + VersionLabels.format(pin.optString("version"), "", 0) + " until you resume them.", 15, false));
        }
        if (!status.isNull("lastError")) content.addView(text(status.optString("lastError"), 14, false));
        UpdateState state = engine.snapshot();
        if (state != null && state.lastOutcome != null && !"completed".equals(state.lastOutcome.result))
            content.addView(text("Last installation " + state.lastOutcome.result + ": " + state.lastOutcome.message, 14, false));
        if (state != null && state.recoveryRequired())
            content.addView(text(state.forceRecovery ? "The last installed build did not match the verified update."
                : "The last " + state.unhealthyLaunches + " launches did not finish loading.", 15, true));

        if (state != null && state.pending != null && "awaiting-confirmation".equals(state.pending.installerResult)) {
            String transaction = state.pending.transactionId;
            content.addView(text("Android needs your approval to replace Arcwright Code with " + VersionLabels.format(state.pending.targetVersion, "", 0) + ".", 15, true));
            Button confirmation = button("Open Android update confirmation", view -> {
                try { engine.openInstallConfirmation(transaction); }
                catch (UpdateEngine.UpdateException error) { Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show(); render(); }
            });
            boolean available = UpdateNotifications.existingConfirmation(this, state.pending) != null;
            confirmation.setEnabled(!busy && available);
            content.addView(confirmation);
            if (!available) content.addView(text("Android's confirmation is unavailable. Finish or cancel the existing Android installer before retrying.", 14, false));
        }

        if (state != null && !state.nativeOperations.isEmpty()) content.addView(text("A phone picker or permission dialog has not returned its result. Close that dialog and return to Arcwright Code. If Android lost the result, restart the phone before retrying the update.", 15, true));
        if (state != null && state.intent != null) {
            content.addView(text("An install is waiting. It starts after Arcwright Code has been out of the foreground for 2 minutes and no phone work is running. "
                + "Leave this screen to let that time pass.", 15, true));
            content.addView(button("Cancel the waiting install", view -> background("Cancelled.", engine::cancelRequest)));
            for (InstallGuard.Blocker blocker : engine.blockers(state)) content.addView(text(blocker.label, 14, false));
        }
        if (state == null || state.pending == null) content.addView(button("Continue to Arcwright Code", view -> {
            startActivity(new Intent(this, MainActivity.class).putExtra(BYPASS, true).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
            finish();
        }));
        if (status.optBoolean("supported")) {
            if (!UpdateNotifications.confirmationAvailable(this))
                content.addView(button("Allow update confirmation notifications", view -> NativeSettings.open(this,
                    UpdateNotifications.settings(this))));
            if ("needed".equals(status.optString("installPermission")))
                content.addView(button("Allow Arcwright Code to install updates", view -> NativeSettings.open(this, new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())))));
            List<UpdateState.Recovery> builds = engine.installableRecovery();
            if (builds.isEmpty()) content.addView(text("No verified recovery build is cached for this installation.", 15, false));
            for (UpdateState.Recovery build : builds) {
                content.addView(button("Request recovery " + VersionLabels.format(build.version, "", 0) + " (Android code " + build.versionCode + ")",
                    view -> confirmInstall(build)));
            }
            content.addView(button("Download the latest recovery build", view -> background("Recovery build downloaded and verified.", engine::fetchRecovery)));
            if (policy != null && !policy.isNull("pin")) content.addView(button("Resume automatic updates", view -> background("Updates resumed.", engine::resume)));
        } else {
            content.addView(text(status.optString("unsupportedReason", "In-app recovery is unavailable on this Android version."), 15, false));
        }
        content.addView(text("If this phone cannot open Arcwright Code or this screen cannot install, use the signed recovery APK from the release: "
            + "verify its SHA-256 and certificate, then install it over the current app with adb or Android's package installer. "
            + "Never uninstall: that removes saved connections. The maintainer runbook has the exact steps.", 13, false));
    }

    private void confirmInstall(UpdateState.Recovery build) {
        new AlertDialog.Builder(this).setTitle("Request this recovery build?")
            .setMessage("This asks to replace the installed build with " + VersionLabels.format(build.version, "", 0) + " and pin it, so no automatic update replaces it until you resume updates. "
                + "Like every install it waits until Arcwright Code has been out of the foreground for 2 minutes and no phone work is running. "
                + "App data and pairings are kept. Android may ask you to confirm.")
            .setPositiveButton("Request", (dialog, which) -> background("Requested. Leave Arcwright Code for 2 minutes and it will install.",
                () -> engine.requestRollback(build.sha256, engine.recoveryTransactionId(build))))
            .setNegativeButton("Cancel", null).show();
    }

    private interface Task { void run() throws UpdateEngine.UpdateException; }

    private void background(String success, Task task) {
        busy = true; render();
        worker.execute(() -> {
            String message = success;
            try { task.run(); } catch (UpdateEngine.UpdateException error) { message = error.getMessage(); }
            catch (RuntimeException error) { message = "That did not complete."; }
            busy = false;
            String toast = message;
            runOnUiThread(() -> { if (toast != null) Toast.makeText(this, toast, Toast.LENGTH_LONG).show(); render(); });
        });
    }
}
