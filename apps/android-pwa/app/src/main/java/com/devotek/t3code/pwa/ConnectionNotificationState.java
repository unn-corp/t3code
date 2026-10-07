package com.devotek.t3code.pwa;

/** Keep an unchanged foreground-service status from resurfacing after the user dismisses it. */
final class ConnectionNotificationState {
    private String postedText;

    synchronized boolean start() {
        if (postedText != null) return false;
        postedText = "Connecting to your environments";
        return true;
    }

    synchronized String changedStatus(int connected, int total) {
        String text = connected == total && total > 0
            ? "Background agent alerts are ready"
            : connected + " of " + total + " environments connected · Reconnecting";
        if (text.equals(postedText)) return null;
        postedText = text;
        return text;
    }
}
