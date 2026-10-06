package com.devotek.t3code.pwa;

import java.net.URI;

/** Browser documents never load the trusted app shell or local Android files. */
final class BrowserPolicy {
    static boolean allowedUrl(String raw) {
        if ("about:blank".equals(raw)) return true;
        try {
            URI uri = new URI(raw);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            return ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                && host != null && uri.getUserInfo() == null
                && !"appassets.androidplatform.net".equalsIgnoreCase(host);
        } catch (Exception ignored) { return false; }
    }
    static int pixels(double css, float scale) {
        if (!Double.isFinite(css) || css < 0 || css > 16384) throw new IllegalArgumentException("Invalid browser bounds");
        return (int) Math.round(css * scale);
    }
}
