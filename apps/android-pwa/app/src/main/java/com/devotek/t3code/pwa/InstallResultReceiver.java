package com.devotek.t3code.pwa;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** PackageInstaller's session result. Not exported: only the pending intent this app handed Android reaches it. */
public final class InstallResultReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) { UpdateEngine.get(context).installerResult(intent); }
}
