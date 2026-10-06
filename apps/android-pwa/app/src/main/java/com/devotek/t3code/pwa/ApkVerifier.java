package com.devotek.t3code.pwa;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.Build;
import android.os.Bundle;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.Set;

/**
 * Verification of a downloaded APK against the release manifest and the installed app. Digests
 * detect corruption and substitution relative to the recorded manifest; the trust root is the GitHub
 * HTTPS origin plus Android's signature rules, so a digest is never treated as authentication.
 */
final class ApkVerifier {
    static final class Failure extends Exception { Failure(String message) { super(message); } }

    /** Facts read from the APK file itself, independent of anything the release claims about it. */
    static final class Facts {
        String packageName = "", sourceCommit = "", sourceVersion = "";
        long versionCode;
        Set<String> signers = new HashSet<>();
        boolean multipleSigners, recovery;
        int protocol;
    }

    static final String META_COMMIT = "t3.updater.sourceCommit", META_VERSION = "t3.updater.sourceVersion",
        META_RECOVERY = "t3.updater.recovery", META_PROTOCOL = "t3.updater.protocol";
    private static final String META_PREFIX = "t3:";

    private ApkVerifier() { }

    static String hex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) { out[i * 2] = digits[(bytes[i] >> 4) & 15]; out[i * 2 + 1] = digits[bytes[i] & 15]; }
        return new String(out);
    }
    static String sha256(byte[] bytes) {
        try { return hex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }
    static String sha256(File file) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024]; int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
            return hex(digest.digest());
        } catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
    }

    static void verifyFile(File file, String sha256, long bytes) throws Failure, IOException {
        if (!file.isFile() || file.length() != bytes) throw new Failure("The downloaded update has the wrong size.");
        if (!sha256(file).equals(sha256)) throw new Failure("The downloaded update does not match its recorded digest.");
    }

    /** Pure comparison so every rule is testable without a device. */
    static void verifyFacts(Facts facts, ReleaseManifest.Artifact expected, boolean expectRecovery,
            UpdateEligibility.Installed installed) throws Failure {
        if (!facts.packageName.equals(expected.packageName) || !facts.packageName.equals(installed.packageName))
            throw new Failure("The update is for a different app.");
        if (facts.multipleSigners || facts.signers.size() != 1) throw new Failure("The update has an unexpected signing configuration.");
        if (!facts.signers.contains(expected.signerSha256) || !facts.signers.contains(installed.signerSha256))
            throw new Failure("The update is not signed with this app's certificate.");
        if (facts.versionCode != expected.versionCode) throw new Failure("The update's version code differs from its release.");
        if (facts.versionCode <= installed.versionCode) throw new Failure("The update's version code is not higher than the installed app.");
        if (!facts.sourceCommit.equals(expected.sourceCommit) || !facts.sourceVersion.equals(expected.sourceVersion))
            throw new Failure("The update's source identity differs from its release.");
        if (facts.recovery != expectRecovery) throw new Failure("The update is the wrong kind of build.");
        if (facts.protocol != expected.updaterProtocol) throw new Failure("The update does not carry a supported updater.");
    }

    static Facts read(Context context, File apk) throws Failure {
        if (Build.VERSION.SDK_INT < 28) throw new Failure("This Android version cannot inspect update signatures.");
        PackageInfo info = context.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(),
            PackageManager.GET_SIGNING_CERTIFICATES | PackageManager.GET_META_DATA);
        if (info == null || info.applicationInfo == null) throw new Failure("The downloaded file is not a valid app package.");
        Facts facts = new Facts();
        facts.packageName = info.packageName == null ? "" : info.packageName;
        facts.versionCode = info.getLongVersionCode();
        SigningInfo signing = info.signingInfo;
        if (signing == null) throw new Failure("The downloaded app is not signed.");
        facts.multipleSigners = signing.hasMultipleSigners();
        for (Signature signature : signing.getApkContentsSigners()) facts.signers.add(sha256(signature.toByteArray()));
        ApplicationInfo application = info.applicationInfo;
        Bundle meta = application.metaData;
        if (meta != null) {
            facts.sourceCommit = strip(meta.get(META_COMMIT)); facts.sourceVersion = strip(meta.get(META_VERSION));
            facts.recovery = "true".equals(strip(meta.get(META_RECOVERY)));
            try { facts.protocol = Integer.parseInt(strip(meta.get(META_PROTOCOL))); } catch (NumberFormatException ignored) { facts.protocol = 0; }
        }
        return facts;
    }

    /** The installed app's signing digest and code, or null when this Android version cannot report them. */
    static UpdateEligibility.Installed installed(Context context) {
        if (Build.VERSION.SDK_INT < 28) return null;
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
            SigningInfo signing = info.signingInfo;
            if (signing == null || signing.hasMultipleSigners() || signing.getApkContentsSigners().length != 1) return null;
            return new UpdateEligibility.Installed(context.getPackageName(), info.getLongVersionCode(),
                sha256(signing.getApkContentsSigners()[0].toByteArray()));
        } catch (PackageManager.NameNotFoundException error) { return null; }
    }

    private static String strip(Object value) {
        String text = value == null ? "" : String.valueOf(value);
        return text.startsWith(META_PREFIX) ? text.substring(META_PREFIX.length()) : text;
    }
}
