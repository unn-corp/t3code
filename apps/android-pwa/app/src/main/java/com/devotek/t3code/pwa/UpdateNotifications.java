package com.devotek.t3code.pwa;

import android.app.ActivityOptions;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/** Prompts the updater cannot show in the shell: Android's install confirmation and failure recovery. */
final class UpdateNotifications {
    static final String CHANNEL = "t3-app-updates-v1";
    private static final int CONFIRM = 7001, FAILURE = 7002;
    // Keep a strong token reference while the process lives, even if its notification is dismissed.
    private static volatile PendingIntent retainedConfirmation;
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

    static PendingIntent confirmation(Context context, Intent confirmation, int sessionId) {
        confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent prompt = PendingIntent.getActivity(context, sessionId, confirmation,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        retainedConfirmation = prompt;
        return prompt;
    }

    /** Finds the existing OS-held prompt. If Android discarded it, no replacement is synthesized. */
    static PendingIntent existingConfirmation(Context context, UpdateState.Pending pending) {
        if (pending == null || pending.sessionId < 0 || !"awaiting-confirmation".equals(pending.installerResult)) return null;
        try {
            if (!pending.confirmationFilterUri.isEmpty()) {
                Intent filter = Intent.parseUri(pending.confirmationFilterUri, Intent.URI_INTENT_SCHEME);
                PendingIntent prompt = PendingIntent.getActivity(context, pending.sessionId, filter,
                    PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
                if (prompt != null) retainedConfirmation = prompt;
                return prompt;
            }
            // Updater-equipped older builds did not record filter identity. Their still-active
            // notification retains Android's original token; no new intent is synthesized.
            for (StatusBarNotification notification : context.getSystemService(NotificationManager.class).getActiveNotifications()) {
                if (notification.getId() == CONFIRM && context.getPackageName().equals(notification.getPackageName())
                        && notification.getPostTime() >= pending.startedAt) {
                    PendingIntent prompt = notification.getNotification().contentIntent;
                    if (prompt != null) retainedConfirmation = prompt;
                    return prompt;
                }
            }
        } catch (Exception unavailable) { /* The OS can discard an installer token; never invent one. */ }
        return null;
    }

    /** Opens Android's confirmation directly while Arcwright Code is on screen; otherwise asks through a notification. */
    static void confirm(Context context, PendingIntent confirmation) {
        if (MainActivity.visible || RecoveryActivity.visible) {
            try { openConfirmation(context, confirmation); return; } catch (PendingIntent.CanceledException | RuntimeException ignored) { /* Fall back to the notification. */ }
        }
        post(context, CONFIRM, "Confirm the Arcwright Code update", "Tap to let Android finish installing the verified update.",
            confirmation);
    }

    static void openConfirmation(Context context, PendingIntent confirmation) throws PendingIntent.CanceledException {
        if (!MainActivity.visible && !RecoveryActivity.visible) throw new IllegalStateException("Arcwright Code must be visible to open Android confirmation.");
        ActivityOptions options = ActivityOptions.makeBasic();
        // Sender opt-in is required from Android 14. Android 16 can additionally require
        // current visibility at send time, closing the lifecycle race after our own check.
        if (Build.VERSION.SDK_INT >= 36) options.setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_IF_VISIBLE);
        else if (Build.VERSION.SDK_INT >= 34) options.setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
        confirmation.send(context, 0, null, null, null, null, options.toBundle());
    }

    static void clear(Context context) {
        retainedConfirmation = null;
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        manager.cancel(CONFIRM); manager.cancel(FAILURE);
    }

    static void failure(Context context) {
        post(context, FAILURE, "Arcwright Code update did not install", "Open recovery to check the installed build or install a recovery build.",
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
