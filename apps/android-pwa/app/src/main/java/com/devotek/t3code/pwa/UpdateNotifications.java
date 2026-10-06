package com.devotek.t3code.pwa;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/** Prompts the updater cannot show in the shell: Android's install confirmation and failure recovery. */
final class UpdateNotifications {
    static final String CHANNEL = "t3-app-updates-v1";
    private static final int CONFIRM = 7001, FAILURE = 7002;
    private UpdateNotifications() { }

    private static void channel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        context.getSystemService(NotificationManager.class).createNotificationChannel(
            new NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT));
    }

    /** Global notification permission does not imply that this individual channel is enabled. */
    static boolean confirmationAvailable(Context context) {
        try {
            if (!NativeNotifications.allowed(context)) return false;
            channel(context);
            if (Build.VERSION.SDK_INT < 26) return true;
            NotificationChannel updates = context.getSystemService(NotificationManager.class).getNotificationChannel(CHANNEL);
            return updates != null && updates.getImportance() != NotificationManager.IMPORTANCE_NONE;
        } catch (RuntimeException unavailable) { return false; }
    }

    static Intent settings(Context context) {
        channel(context);
        return new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName())
            .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL);
    }

    /** Opens Android's confirmation directly while T3 Code is on screen; otherwise asks through a notification. */
    static void confirm(Context context, Intent confirmation) {
        confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (MainActivity.visible || RecoveryActivity.visible) {
            try { context.startActivity(confirmation); return; } catch (RuntimeException ignored) { /* Fall back to the notification. */ }
        }
        post(context, CONFIRM, "Confirm the T3 Code update", "Tap to let Android finish installing the verified update.",
            PendingIntent.getActivity(context, CONFIRM, confirmation, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    }

    static void clear(Context context) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        manager.cancel(CONFIRM); manager.cancel(FAILURE);
    }

    static void failure(Context context) {
        post(context, FAILURE, "T3 Code update did not install", "Open recovery to check the installed build or install a recovery build.",
            PendingIntent.getActivity(context, FAILURE, RecoveryActivity.intent(context), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    }

    private static void post(Context context, int id, String title, String text, PendingIntent tap) {
        if (!confirmationAvailable(context)) return;
        try {
            NotificationManagerCompat.from(context).notify(id, new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(com.devotek.t3code.pwa.R.drawable.notification_icon).setContentTitle(title).setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text)).setAutoCancel(true)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setCategory(Notification.CATEGORY_SERVICE).setContentIntent(tap).build());
        } catch (SecurityException ignored) { /* Permission may be revoked between checking and posting. */ }
    }
}
