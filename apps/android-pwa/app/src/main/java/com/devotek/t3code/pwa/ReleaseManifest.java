package com.devotek.t3code.pwa;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The fork release JSON, mirroring packages/contracts/src/forkRelease.ts exactly. Parsing is strict:
 * a missing field, wrong type, bad digest, or a package or repository other than ours is rejected
 * so a malformed release can never become an eligible update.
 */
final class ReleaseManifest {
    static final String REPOSITORY = "unn-corp/t3code";
    static final String PACKAGE = "com.devotek.t3code.pwa";
    /** Release asset that carries this JSON. Both the release workflow and this client use it. */
    static final String ASSET_NAME = BuildConfig.FORK_RELEASE_MANIFEST_ASSET;
    static final int UPDATER_PROTOCOL = 1;
    static final long MAX_BYTES = 256 * 1024;

    static final class Invalid extends Exception { Invalid(String message) { super(message); } }

    static final class Asset {
        final String name, sha256, kind, platform;
        final long bytes;
        Asset(String name, String sha256, long bytes, String kind, String platform) {
            this.name = name; this.sha256 = sha256; this.bytes = bytes; this.kind = kind; this.platform = platform;
        }
    }

    static final class Artifact {
        final String asset, sourceVersion, sourceCommit, packageName, signerSha256;
        final long versionCode;
        final int updaterProtocol;
        Artifact(String asset, long versionCode, String sourceVersion, String sourceCommit, String packageName,
                String signerSha256, int updaterProtocol) {
            this.asset = asset; this.versionCode = versionCode; this.sourceVersion = sourceVersion;
            this.sourceCommit = sourceCommit; this.packageName = packageName; this.signerSha256 = signerSha256;
            this.updaterProtocol = updaterProtocol;
        }
    }

    final String version, commit, channel, releasedAt;
    final List<Asset> assets;
    final Artifact normal, recovery;
    /** Complete optional source-matched recovery list, with `recovery` repeated first for legacy readers. */
    final List<Artifact> recoveries;
    final boolean build, install, update, recoveryCheck;

    private ReleaseManifest(String version, String commit, String channel, String releasedAt, List<Asset> assets,
            Artifact normal, Artifact recovery, List<Artifact> recoveries, boolean build, boolean install, boolean update, boolean recoveryCheck) {
        this.version = version; this.commit = commit; this.channel = channel; this.releasedAt = releasedAt;
        this.assets = Collections.unmodifiableList(assets); this.normal = normal; this.recovery = recovery;
        this.recoveries = Collections.unmodifiableList(recoveries);
        this.build = build; this.install = install; this.update = update; this.recoveryCheck = recoveryCheck;
    }

    Asset asset(String name) {
        for (Asset asset : assets) if (asset.name.equals(name)) return asset;
        return null;
    }
    List<Artifact> allRecoveries() {
        List<Artifact> all = new ArrayList<>();
        if (recoveries.isEmpty()) all.add(recovery);
        else all.addAll(recoveries); // The additive list is the complete set and begins with primary.
        return all;
    }
    Artifact recoveryForSource(String sourceVersion, String sourceCommit) {
        Artifact match = null;
        for (Artifact candidate : allRecoveries()) {
            if (!candidate.sourceVersion.equals(sourceVersion) || !candidate.sourceCommit.equals(sourceCommit)) continue;
            if (match != null) return null;
            match = candidate;
        }
        return match;
    }
    boolean hasRecoveryDigest(String digest) {
        if (digest == null) return false;
        for (Artifact candidate : allRecoveries()) {
            Asset candidateAsset = asset(candidate.asset);
            if (candidateAsset != null && digest.equals(candidateAsset.sha256)) return true;
        }
        return false;
    }
    boolean checksPassed() { return build && install && update && recoveryCheck; }

    static ReleaseManifest parse(String json) throws Invalid {
        try {
            JSONObject root = new JSONObject(json);
            if (integer(root, "format") != 1) throw new Invalid("Unsupported release format");
            if (!REPOSITORY.equals(string(root, "repository"))) throw new Invalid("Release belongs to another repository");
            String channel = string(root, "channel");
            if (!"stable".equals(channel) && !"nightly".equals(channel)) throw new Invalid("Unknown release channel");
            String releasedAt = string(root, "releasedAt");
            try { Iso8601.parse(releasedAt); } catch (IllegalArgumentException error) { throw new Invalid("Invalid release time"); }
            JSONArray rawAssets = array(root, "assets");
            List<Asset> assets = new ArrayList<>();
            java.util.Set<String> names = new java.util.HashSet<>();
            for (int i = 0; i < rawAssets.length(); i++) {
                JSONObject item = object(rawAssets, i);
                String name = string(item, "name");
                if (!name.matches("^[A-Za-z0-9][A-Za-z0-9._-]+$")) throw new Invalid("Invalid asset name");
                if (!names.add(name)) throw new Invalid("Duplicate release asset");
                String kind = string(item, "kind"), platform = string(item, "platform");
                if (!oneOf(kind, "desktop", "server", "android", "android-recovery", "recovery-helper", "feed", "blockmap")
                    || !oneOf(platform, "windows-x64", "linux-x64", "android", "shared")) throw new Invalid("Invalid asset kind");
                long bytes = number(item, "bytes");
                if (bytes <= 0) throw new Invalid("Invalid asset size");
                assets.add(new Asset(name, hex(item, "sha256", 64), bytes, kind, platform));
            }
            JSONObject android = object(root, "android");
            JSONObject checks = object(root, "checks");
            Artifact normal = artifact(object(android, "normal"));
            Artifact recovery = artifact(object(android, "recovery"));
            List<Artifact> recoveries = new ArrayList<>();
            if (android.has("recoveries")) {
                JSONArray rawRecoveries = array(android, "recoveries");
                for (int i = 0; i < rawRecoveries.length(); i++) recoveries.add(artifact(object(rawRecoveries, i)));
                validateRecoveries(normal, recovery, recoveries, assets);
            }
            return new ReleaseManifest(string(root, "version"), hex(root, "commit", 40), channel, releasedAt, assets,
                normal, recovery, recoveries,
                bool(checks, "build"), bool(checks, "install"), bool(checks, "update"), bool(checks, "recovery"));
        } catch (JSONException error) { throw new Invalid("Malformed release manifest"); }
    }

    private static Artifact artifact(JSONObject item) throws Invalid, JSONException {
        long code = number(item, "versionCode");
        if (code <= 0 || code > Integer.MAX_VALUE) throw new Invalid("Invalid version code");
        if (!PACKAGE.equals(string(item, "packageName"))) throw new Invalid("Release targets another package");
        int protocol = integer(item, "updaterProtocol");
        if (protocol != UPDATER_PROTOCOL) throw new Invalid("Unsupported updater protocol");
        return new Artifact(string(item, "asset"), code, string(item, "sourceVersion"), hex(item, "sourceCommit", 40),
            PACKAGE, hex(item, "signerSha256", 64), protocol);
    }
    private static void validateRecoveries(Artifact normal, Artifact primary, List<Artifact> recoveries, List<Asset> assets)
            throws Invalid {
        if (recoveries.isEmpty() || !sameArtifact(primary, recoveries.get(0)))
            throw new Invalid("Recovery list must begin with its primary recovery artifact");
        java.util.Set<String> identities = new java.util.HashSet<>();
        java.util.Set<Long> codes = new java.util.HashSet<>();
        java.util.Set<String> names = new java.util.HashSet<>();
        identities.add(sourceKey(primary));
        codes.add(primary.versionCode);
        names.add(primary.asset);
        for (int index = 1; index < recoveries.size(); index++) {
            Artifact recovery = recoveries.get(index);
            if (recovery.versionCode <= normal.versionCode || recovery.sourceCommit.equals(normal.sourceCommit)
                    && recovery.sourceVersion.equals(normal.sourceVersion)) throw new Invalid("Invalid recovery source");
            if (!identities.add(sourceKey(recovery))) throw new Invalid("Duplicate recovery source identity");
            if (!codes.add(recovery.versionCode)) throw new Invalid("Duplicate recovery version code");
            if (!names.add(recovery.asset)) throw new Invalid("Duplicate recovery asset");
            if (!primary.signerSha256.equals(recovery.signerSha256)) throw new Invalid("Recovery signer mismatch");
            Asset asset = null;
            for (Asset candidate : assets) if (candidate.name.equals(recovery.asset)) asset = candidate;
            if (asset == null || !"android-recovery".equals(asset.kind) || !"android".equals(asset.platform))
                throw new Invalid("Invalid recovery asset");
        }
    }
    private static String sourceKey(Artifact artifact) { return artifact.sourceVersion + "\n" + artifact.sourceCommit; }
    private static boolean sameArtifact(Artifact left, Artifact right) {
        return left.asset.equals(right.asset) && left.versionCode == right.versionCode
            && left.sourceVersion.equals(right.sourceVersion) && left.sourceCommit.equals(right.sourceCommit)
            && left.packageName.equals(right.packageName) && left.signerSha256.equals(right.signerSha256)
            && left.updaterProtocol == right.updaterProtocol;
    }
    private static boolean oneOf(String value, String... options) {
        for (String option : options) if (option.equals(value)) return true;
        return false;
    }
    // org.json coerces numbers to strings and strings to numbers; the contract does not.
    private static String string(JSONObject object, String key) throws Invalid, JSONException {
        Object value = object.get(key);
        if (!(value instanceof String text) || text.isEmpty() || text.length() > 512) throw new Invalid("Invalid " + key);
        return text;
    }
    private static String hex(JSONObject object, String key, int length) throws Invalid, JSONException {
        String text = string(object, key);
        if (!text.matches("^[a-f0-9]{" + length + "}$")) throw new Invalid("Invalid " + key);
        return text;
    }
    private static long number(JSONObject object, String key) throws Invalid, JSONException {
        Object value = object.get(key);
        if (!(value instanceof Integer) && !(value instanceof Long)) throw new Invalid("Invalid " + key);
        return ((Number) value).longValue();
    }
    private static int integer(JSONObject object, String key) throws Invalid, JSONException {
        long value = number(object, key);
        if (value > Integer.MAX_VALUE || value < Integer.MIN_VALUE) throw new Invalid("Invalid " + key);
        return (int) value;
    }
    private static boolean bool(JSONObject object, String key) throws Invalid, JSONException {
        Object value = object.get(key);
        if (!(value instanceof Boolean flag)) throw new Invalid("Invalid " + key);
        return flag;
    }
    private static JSONObject object(JSONObject object, String key) throws Invalid, JSONException {
        Object value = object.get(key);
        if (!(value instanceof JSONObject nested)) throw new Invalid("Invalid " + key);
        return nested;
    }
    private static JSONObject object(JSONArray array, int index) throws Invalid, JSONException {
        Object value = array.get(index);
        if (!(value instanceof JSONObject nested)) throw new Invalid("Invalid asset");
        return nested;
    }
    private static JSONArray array(JSONObject object, String key) throws Invalid, JSONException {
        Object value = object.get(key);
        if (!(value instanceof JSONArray nested) || nested.length() > 64) throw new Invalid("Invalid " + key);
        return nested;
    }
}
