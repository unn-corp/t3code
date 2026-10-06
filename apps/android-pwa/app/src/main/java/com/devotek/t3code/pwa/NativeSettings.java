package com.devotek.t3code.pwa;

import android.app.Activity;
import android.content.Intent;

/** Settings can outlive our process. Release the durable hold only for the matching activity result. */
final class NativeSettings {
    static final int REQUEST = 4;
    private static String owner(Activity activity) { return activity.getClass().getName() + ":" + REQUEST; }
    static void open(Activity activity, Intent intent) {
        PhoneOperations.shared().begin("settings", owner(activity), PhoneOperations.UNTIL_ENDED);
        try { activity.startActivityForResult(intent, REQUEST); }
        catch (RuntimeException error) { PhoneOperations.shared().end("settings", owner(activity)); throw error; }
    }
    static boolean returned(Activity activity, int code) {
        if (code != REQUEST) return false;
        PhoneOperations.shared().end("settings", owner(activity));
        return true;
    }
    private NativeSettings() { }
}
