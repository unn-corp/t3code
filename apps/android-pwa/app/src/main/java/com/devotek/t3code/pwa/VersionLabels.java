package com.devotek.t3code.pwa;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Display labels only. Never use these strings to select, pin, verify, or restore an APK. */
final class VersionLabels {
    private static final Pattern NIGHTLY = Pattern.compile("^\\d+\\.\\d+\\.\\d+-nightly\\.\\d{8}\\.(\\d+)$");
    private static final Pattern LEGACY = Pattern.compile("^(\\d+\\.\\d+\\.\\d+)-fork\\.(\\d+)$");
    static String format(String release, String upstream, int buildNumber) {
        Matcher nightly = NIGHTLY.matcher(release), legacy = LEGACY.matcher(release);
        String label;
        if (nightly.matches()) label = "Arcwright build " + nightly.group(1) + " · Nightly";
        else if (legacy.matches()) {
            if (upstream.isEmpty()) upstream = legacy.group(1);
            label = "Arcwright build " + legacy.group(2) + " · Legacy";
        } else if (buildNumber > 0) label = "Arcwright build " + buildNumber + " · Stable";
        else if (!upstream.isEmpty()) label = release.equals(upstream) ? "Arcwright Development" : "Arcwright Stable";
        else return release;
        return upstream.isEmpty() ? label : upstream + " · " + label;
    }
    private VersionLabels() { }
}
