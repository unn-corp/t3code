package com.devotek.t3code.pwa;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After an update the new process proves which build is running, even if the user never opens the app. */
public final class PackageReplacedReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        UpdateEngine.get(context).reconcile();
        AppUpdateWorker.schedule(context);
        NativeNotifications.restartBackground(context);
    }
}
