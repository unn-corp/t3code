package com.devotek.t3code.pwa;

import java.io.IOException;

/** Pure disk-space budget for staging and handing one APK to PackageInstaller. */
final class UpdateCapacity {
    static final long MIN_MARGIN_BYTES = 1024L * 1024L * 1024L;
    static final String INSUFFICIENT_MESSAGE = "Not enough free storage to safely install this APK. Free space, then retry.";

    static final class Snapshot {
        final long stagingAvailableBytes;
        final long installAvailableBytes;
        final boolean sameFilesystem;
        final boolean known;

        Snapshot(long stagingAvailableBytes, long installAvailableBytes, boolean sameFilesystem, boolean known) {
            this.stagingAvailableBytes = stagingAvailableBytes;
            this.installAvailableBytes = installAvailableBytes;
            this.sameFilesystem = sameFilesystem;
            this.known = known;
        }

        static Snapshot unknown() { return new Snapshot(-1, -1, false, false); }
    }

    /** Used when free space disappears between admission and the final OS commit. */
    static final class Insufficient extends IOException {
        Insufficient() { super(INSUFFICIENT_MESSAGE); }
    }

    private UpdateCapacity() { }

    /** Package/session copy plus room for installed package expansion. */
    static long installPeakBytes(long apkBytes) {
        if (apkBytes <= 0) return Long.MAX_VALUE;
        return multiplySaturated(apkBytes, 2);
    }

    /** Downloads only missing artifacts while retaining budget for the later install. */
    static boolean canStageUpdate(Snapshot snapshot, long normalBytes, boolean normalCached,
            long recoveryBytes, boolean recoveryCached) {
        long staging = addSaturated(normalCached ? 0 : normalBytes, recoveryCached ? 0 : recoveryBytes);
        return normalBytes > 0 && recoveryBytes > 0
            && enough(snapshot, staging, installPeakBytes(normalBytes));
    }

    /** A standalone recovery download must leave room for its eventual package replacement. */
    static boolean canStageRecovery(Snapshot snapshot, long recoveryBytes, boolean recoveryCached) {
        return recoveryBytes > 0 && enough(snapshot, recoveryCached ? 0 : recoveryBytes, installPeakBytes(recoveryBytes));
    }

    /** Rechecked after the quiet wait and before PackageInstaller allocates a session. */
    static boolean canStartInstall(Snapshot snapshot, long apkBytes) {
        return enough(snapshot, 0, installPeakBytes(apkBytes));
    }

    /** Rechecked after session bytes are written, immediately before PackageInstaller.commit. */
    static boolean canCommit(Snapshot snapshot, long apkBytes) {
        return apkBytes > 0 && enough(snapshot, 0, apkBytes);
    }

    static long marginBytes(long requiredBytes) {
        if (requiredBytes <= 0) return 0;
        long tenPercentCeiling = requiredBytes / 10 + (requiredBytes % 10 == 0 ? 0 : 1);
        return Math.max(tenPercentCeiling, MIN_MARGIN_BYTES);
    }

    private static boolean enough(Snapshot snapshot, long stagingBytes, long installBytes) {
        if (snapshot == null || !snapshot.known || snapshot.stagingAvailableBytes < 0 || snapshot.installAvailableBytes < 0
                || stagingBytes < 0 || installBytes < 0) return false;
        if (snapshot.sameFilesystem) {
            long total = addChecked(stagingBytes, installBytes);
            long required = total < 0 ? -1 : addChecked(total, marginBytes(total));
            return required >= 0 && snapshot.stagingAvailableBytes >= required;
        }
        long stagingRequired = addChecked(stagingBytes, marginBytes(stagingBytes));
        long installRequired = addChecked(installBytes, marginBytes(installBytes));
        return stagingRequired >= 0 && installRequired >= 0
            && snapshot.stagingAvailableBytes >= stagingRequired && snapshot.installAvailableBytes >= installRequired;
    }

    private static long addChecked(long left, long right) {
        if (left < 0 || right < 0 || Long.MAX_VALUE - left < right) return -1;
        return left + right;
    }

    private static long addSaturated(long left, long right) {
        if (left < 0 || right < 0 || Long.MAX_VALUE - left < right) return Long.MAX_VALUE;
        return left + right;
    }

    private static long multiplySaturated(long value, long multiplier) {
        if (value < 0 || multiplier < 0 || (value > 0 && multiplier > Long.MAX_VALUE / value)) return Long.MAX_VALUE;
        return value * multiplier;
    }
}
