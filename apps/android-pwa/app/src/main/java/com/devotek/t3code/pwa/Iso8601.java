package com.devotek.t3code.pwa;

import java.util.GregorianCalendar;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** RFC 3339 timestamps without java.time, which needs API 26 while the app supports API 24. */
final class Iso8601 {
    private static final Pattern FORMAT = Pattern.compile(
        "^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,9}))?(Z|[+-]\\d{2}:\\d{2})$");
    private Iso8601() { }

    /** Returns epoch milliseconds, or throws IllegalArgumentException for anything but a full timestamp. */
    static long parse(String value) {
        Matcher match = value == null ? null : FORMAT.matcher(value);
        if (match == null || !match.matches()) throw new IllegalArgumentException("Invalid timestamp");
        int month = Integer.parseInt(match.group(2)), day = Integer.parseInt(match.group(3));
        int hour = Integer.parseInt(match.group(4)), minute = Integer.parseInt(match.group(5));
        int second = Integer.parseInt(match.group(6));
        if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
            throw new IllegalArgumentException("Invalid timestamp");
        GregorianCalendar calendar = new GregorianCalendar(TimeZone.getTimeZone("UTC"));
        calendar.setLenient(false);
        calendar.clear();
        calendar.set(Integer.parseInt(match.group(1)), month - 1, day, hour, minute, second);
        long millis;
        try { millis = calendar.getTimeInMillis(); }
        catch (IllegalArgumentException error) { throw new IllegalArgumentException("Invalid timestamp"); }
        String fraction = match.group(7);
        if (fraction != null) millis += Integer.parseInt((fraction + "00").substring(0, 3));
        String zone = match.group(8);
        if (!"Z".equals(zone)) {
            int sign = zone.charAt(0) == '-' ? -1 : 1;
            int offsetHours = Integer.parseInt(zone.substring(1, 3)), offsetMinutes = Integer.parseInt(zone.substring(4, 6));
            if (offsetHours > 23 || offsetMinutes > 59) throw new IllegalArgumentException("Invalid timestamp");
            millis -= sign * (offsetHours * 60L + offsetMinutes) * 60_000L;
        }
        return millis;
    }

    static String format(long epochMillis) {
        GregorianCalendar calendar = new GregorianCalendar(TimeZone.getTimeZone("UTC"));
        calendar.setTimeInMillis(epochMillis);
        return String.format(java.util.Locale.ROOT, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
            calendar.get(java.util.Calendar.YEAR), calendar.get(java.util.Calendar.MONTH) + 1,
            calendar.get(java.util.Calendar.DAY_OF_MONTH), calendar.get(java.util.Calendar.HOUR_OF_DAY),
            calendar.get(java.util.Calendar.MINUTE), calendar.get(java.util.Calendar.SECOND),
            calendar.get(java.util.Calendar.MILLISECOND));
    }
}
