package com.devotek.t3code.pwa;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Everything the updater must remember across process death and package replacement. It is app-private
 * and persisted before any PackageInstaller call so the post-restart process can tell what was intended.
 * The format is shared with recovery builds, so fields may be added but never reinterpreted.
 */
final class UpdateState {
    static final int FORMAT = 1;
    /** Consecutive launches without the shell reporting healthy before native recovery opens first. */
    static final int UNHEALTHY_LIMIT = 3;

    /** The build the user wants to stay on. Set before a rollback installs and cleared only by resume. */
    static final class Pin {
        long versionCode; String version = "", commit = "", reason = "manual", artifactSha256 = "";
        JSONObject toJson() throws JSONException {
            return new JSONObject().put("versionCode", versionCode).put("version", version).put("commit", commit).put("reason", reason)
                .put("artifactSha256", artifactSha256);
        }
        static Pin from(JSONObject json) {
            Pin pin = new Pin();
            pin.versionCode = json.optLong("versionCode"); pin.version = json.optString("version"); pin.commit = json.optString("commit");
            pin.reason = json.optString("reason", "manual"); pin.artifactSha256 = json.optString("artifactSha256");
            return pin;
        }
    }

    /** Source identity of the running build, recorded privately and kept apart from the installation code. */
    static final class Identity {
        String version = "", commit = "", channel = "stable", artifactSha256 = "";
        long versionCode; int sequence;
        JSONObject toJson() throws JSONException {
            return new JSONObject().put("version", version).put("commit", commit).put("channel", channel)
                .put("artifactSha256", artifactSha256).put("versionCode", versionCode).put("sequence", sequence);
        }
        static Identity from(JSONObject json) {
            Identity identity = new Identity();
            identity.version = json.optString("version"); identity.commit = json.optString("commit");
            identity.channel = json.optString("channel", "stable"); identity.artifactSha256 = json.optString("artifactSha256");
            identity.versionCode = json.optLong("versionCode"); identity.sequence = json.optInt("sequence");
            return identity;
        }
    }

    /**
     * A person's request to install one exact verified artifact, kept until the install guard admits it.
     * It is independent of the automatic-installation policy, which a request never changes.
     */
    static final class Intent {
        /** "update" targets the staged normal build; "rollback" a cached recovery build. */
        String kind = "update", targetSha256 = "", transactionId = "";
        long requestedAt;
        JSONObject toJson() throws JSONException {
            return new JSONObject().put("kind", kind).put("targetSha256", targetSha256).put("transactionId", transactionId).put("requestedAt", requestedAt);
        }
        static Intent from(JSONObject json) {
            Intent intent = new Intent();
            intent.kind = json.optString("kind", "update"); intent.targetSha256 = json.optString("targetSha256");
            intent.transactionId = json.optString("transactionId"); intent.requestedAt = json.optLong("requestedAt");
            return intent;
        }
    }

    /** An installation that has been handed (or is about to be handed) to Android. */
    static final class Pending {
        String transactionId = "", kind = "update", tag = "", targetVersion = "", targetCommit = "", targetChannel = "stable";
        String targetSha256 = "", manifestSha256 = "", previousCommit = "", installerResult = "committing";
        int sessionId = -1;
        long targetVersionCode, previousVersionCode, startedAt;
        JSONObject toJson() throws JSONException {
            return new JSONObject().put("transactionId", transactionId).put("kind", kind).put("tag", tag)
                .put("targetVersion", targetVersion).put("targetCommit", targetCommit).put("targetChannel", targetChannel)
                .put("targetSha256", targetSha256).put("manifestSha256", manifestSha256).put("previousCommit", previousCommit)
                .put("installerResult", installerResult).put("targetVersionCode", targetVersionCode)
                .put("previousVersionCode", previousVersionCode).put("startedAt", startedAt).put("sessionId", sessionId);
        }
        static Pending from(JSONObject json) {
            Pending pending = new Pending();
            pending.transactionId = json.optString("transactionId"); pending.kind = json.optString("kind", "update");
            pending.tag = json.optString("tag"); pending.targetVersion = json.optString("targetVersion");
            pending.targetCommit = json.optString("targetCommit"); pending.targetChannel = json.optString("targetChannel", "stable");
            pending.targetSha256 = json.optString("targetSha256"); pending.manifestSha256 = json.optString("manifestSha256");
            pending.previousCommit = json.optString("previousCommit"); pending.installerResult = json.optString("installerResult", "committing");
            pending.targetVersionCode = json.optLong("targetVersionCode"); pending.previousVersionCode = json.optLong("previousVersionCode");
            pending.startedAt = json.optLong("startedAt"); pending.sessionId = json.optInt("sessionId", -1);
            return pending;
        }
    }

    /** A downloaded normal APK whose digest, size, package, signer, and identity have been verified. */
    static final class Target {
        String tag = "", version = "", commit = "", channel = "stable", sha256 = "", file = "", manifestSha256 = "", recoverySha256 = "";
        long versionCode, bytes, verifiedAt;
        JSONObject toJson() throws JSONException {
            return new JSONObject().put("tag", tag).put("version", version).put("commit", commit).put("channel", channel)
                .put("sha256", sha256).put("file", file).put("manifestSha256", manifestSha256).put("recoverySha256", recoverySha256)
                .put("versionCode", versionCode).put("bytes", bytes).put("verifiedAt", verifiedAt);
        }
        static Target from(JSONObject json) {
            Target target = new Target();
            target.tag = json.optString("tag"); target.version = json.optString("version"); target.commit = json.optString("commit");
            target.channel = json.optString("channel", "stable"); target.sha256 = json.optString("sha256"); target.file = json.optString("file");
            target.manifestSha256 = json.optString("manifestSha256"); target.recoverySha256 = json.optString("recoverySha256");
            target.versionCode = json.optLong("versionCode"); target.bytes = json.optLong("bytes"); target.verifiedAt = json.optLong("verifiedAt");
            return target;
        }
    }

    /** A verified updater-equipped build kept so a bad update can be replaced without uninstalling. */
    static final class Recovery {
        String sha256 = "", version = "", commit = "", channel = "stable", file = "";
        long versionCode, bytes, cachedAt;
        JSONObject toJson() throws JSONException {
            return new JSONObject().put("sha256", sha256).put("version", version).put("commit", commit).put("channel", channel)
                .put("file", file).put("versionCode", versionCode).put("bytes", bytes).put("cachedAt", cachedAt);
        }
        static Recovery from(JSONObject json) {
            Recovery recovery = new Recovery();
            recovery.sha256 = json.optString("sha256"); recovery.version = json.optString("version"); recovery.commit = json.optString("commit");
            recovery.channel = json.optString("channel", "stable"); recovery.file = json.optString("file");
            recovery.versionCode = json.optLong("versionCode"); recovery.bytes = json.optLong("bytes"); recovery.cachedAt = json.optLong("cachedAt");
            return recovery;
        }
    }

    static final class Outcome {
        String transactionId = "", kind = "update", result = "completed", message = "";
        long at;
        JSONObject toJson() throws JSONException {
            return new JSONObject().put("transactionId", transactionId).put("kind", kind).put("result", result).put("message", message).put("at", at);
        }
        static Outcome from(JSONObject json) {
            Outcome outcome = new Outcome();
            outcome.transactionId = json.optString("transactionId"); outcome.kind = json.optString("kind", "update");
            outcome.result = json.optString("result", "completed"); outcome.message = json.optString("message"); outcome.at = json.optLong("at");
            return outcome;
        }
    }

    /** Null until first launch decides the default from install history. */
    String channel;
    boolean automatic = true;
    Pin pin;
    Identity identity;
    Pending pending;
    Intent intent;
    Target target;
    List<Recovery> recovery = new ArrayList<>();
    Outcome lastOutcome;
    /** Epoch millis the app left the foreground; 0 while foreground or unknown. */
    long backgroundSince;
    /** External Android dialogs can outlive this process. Only a result or a verified reboot ends them. */
    List<String> nativeOperations = new ArrayList<>();
    int nativeOperationsBoot = -1;
    int unhealthyLaunches;
    boolean forceRecovery;
    long lastCheckedAt, deferUntil;
    String lastError;
    String failedArtifactSha256 = "";
    /** The state file was unreadable; automatic installation stays off until the user reviews. */
    boolean recoveredFromCorruption;
    int corruptionBoot = -1;
    /**
     * Set once the bundled shell has reported itself healthy through the bridge. From then on only that
     * signal counts, so a shell that renders blank but loads cannot be mistaken for a working build.
     */
    boolean shellReportsHealth;

    boolean recoveryRequired() { return forceRecovery || unhealthyLaunches >= UNHEALTHY_LIMIT; }
    Recovery recovery(String sha256) {
        for (Recovery entry : recovery) if (entry.sha256.equals(sha256)) return entry;
        return null;
    }

    JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject().put("format", FORMAT).put("automatic", automatic)
            .put("backgroundSince", backgroundSince).put("unhealthyLaunches", unhealthyLaunches).put("forceRecovery", forceRecovery)
            .put("lastCheckedAt", lastCheckedAt).put("deferUntil", deferUntil).put("recoveredFromCorruption", recoveredFromCorruption).put("corruptionBoot", corruptionBoot)
            .put("failedArtifactSha256", failedArtifactSha256).put("shellReportsHealth", shellReportsHealth)
            .put("nativeOperations", new JSONArray(nativeOperations)).put("nativeOperationsBoot", nativeOperationsBoot);
        if (channel != null) json.put("channel", channel);
        if (pin != null) json.put("pin", pin.toJson());
        if (identity != null) json.put("identity", identity.toJson());
        if (pending != null) json.put("pending", pending.toJson());
        if (intent != null) json.put("intent", intent.toJson());
        if (target != null) json.put("target", target.toJson());
        if (lastOutcome != null) json.put("lastOutcome", lastOutcome.toJson());
        if (lastError != null) json.put("lastError", lastError);
        JSONArray entries = new JSONArray();
        for (Recovery entry : recovery) entries.put(entry.toJson());
        return json.put("recovery", entries);
    }

    static UpdateState from(JSONObject json) {
        UpdateState state = new UpdateState();
        state.channel = json.has("channel") ? json.optString("channel") : null;
        state.automatic = json.optBoolean("automatic", true);
        state.pin = json.optJSONObject("pin") == null ? null : Pin.from(json.optJSONObject("pin"));
        state.identity = json.optJSONObject("identity") == null ? null : Identity.from(json.optJSONObject("identity"));
        state.pending = json.optJSONObject("pending") == null ? null : Pending.from(json.optJSONObject("pending"));
        state.intent = json.optJSONObject("intent") == null ? null : Intent.from(json.optJSONObject("intent"));
        state.target = json.optJSONObject("target") == null ? null : Target.from(json.optJSONObject("target"));
        state.lastOutcome = json.optJSONObject("lastOutcome") == null ? null : Outcome.from(json.optJSONObject("lastOutcome"));
        state.backgroundSince = json.optLong("backgroundSince"); state.unhealthyLaunches = json.optInt("unhealthyLaunches");
        state.forceRecovery = json.optBoolean("forceRecovery"); state.lastCheckedAt = json.optLong("lastCheckedAt");
        state.deferUntil = json.optLong("deferUntil"); state.recoveredFromCorruption = json.optBoolean("recoveredFromCorruption"); state.corruptionBoot = json.optInt("corruptionBoot", -1);
        state.shellReportsHealth = json.optBoolean("shellReportsHealth");
        state.failedArtifactSha256 = json.optString("failedArtifactSha256", "");
        state.nativeOperationsBoot = json.optInt("nativeOperationsBoot", -1);
        JSONArray holds = json.optJSONArray("nativeOperations");
        for (int i = 0; holds != null && i < holds.length(); i++) state.nativeOperations.add(holds.optString(i));
        state.lastError = json.has("lastError") ? json.optString("lastError") : null;
        JSONArray entries = json.optJSONArray("recovery");
        for (int i = 0; entries != null && i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry != null) state.recovery.add(Recovery.from(entry));
        }
        return state;
    }

    UpdateState copy() {
        try { return from(toJson()); } catch (JSONException error) { throw new IllegalStateException(error); }
    }
}
