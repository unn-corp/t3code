package com.devotek.t3code.pwa;

import java.util.LinkedHashMap;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Briefly waits for cross-host presence, without replaying alerts consumed while viewed. */
final class PhoneAlertQueue {
    private record Alert(String environmentId, JSONObject thread, String kind, long expiresAt) { }
    private final LinkedHashMap<String, Alert> pending = new LinkedHashMap<>();
    void configure(Set<String> ids) { pending.values().removeIf(alert -> !ids.contains(alert.environmentId())); }
    void offer(String environmentId, JSONObject thread, String kind, long now) throws JSONException {
        pending.put(environmentId + ":" + thread.getString("id") + ":" + kind,
            new Alert(environmentId, thread, kind, now + 120_000));
        while (pending.size() > 128) pending.remove(pending.keySet().iterator().next());
    }
    void reconcile(String environmentId, JSONObject item) throws JSONException {
        switch (item.optString("kind")) {
            case "thread.updated": reconcileThread(environmentId, item.getJSONObject("thread")); break;
            case "thread.removed":
                pending.values().removeIf(alert -> environmentId.equals(alert.environmentId())
                    && item.optString("threadId").equals(alert.thread().optString("id"))); break;
            case "snapshot":
                if (item.has("resolvedRepositoryIdentityRoots")) break;
                JSONArray threads = item.getJSONObject("snapshot").getJSONArray("threads");
                Set<String> ids = new java.util.HashSet<>();
                for (int i = 0; i < threads.length(); i++) {
                    JSONObject thread = threads.getJSONObject(i);
                    ids.add(thread.getString("id")); reconcileThread(environmentId, thread);
                }
                pending.values().removeIf(alert -> environmentId.equals(alert.environmentId())
                    && !ids.contains(alert.thread().optString("id"))); break;
            default: break;
        }
    }
    private void reconcileThread(String environmentId, JSONObject current) {
        pending.values().removeIf(alert -> environmentId.equals(alert.environmentId())
            && current.optString("id").equals(alert.thread().optString("id")) && !relevant(alert, current));
    }
    private boolean relevant(Alert alert, JSONObject current) {
        JSONObject lineage = current.optJSONObject("lineage");
        if (!current.isNull("archivedAt") || !current.isNull("deletedAt")
                || (lineage != null && "subagent".equals(lineage.optString("relationshipToParent")))) return false;
        if (!current.optString("latestRunId").equals(alert.thread().optString("latestRunId"))) return false;
        String status = current.isNull("activityRunStatus") ? current.optString("status") : current.optString("activityRunStatus");
        switch (alert.kind()) {
            case "agent_completed": return ("completed".equals(status) || "idle".equals(status))
                && current.optString("latestRunCompletedAt").equals(alert.thread().optString("latestRunCompletedAt"));
            case "agent_failed": return "failed".equals(status);
            case "plan_ready": return current.optBoolean("hasActionableProposedPlan");
            case "input_required":
                JSONObject request = current.optJSONObject("pendingRuntimeRequest");
                JSONObject previous = alert.thread().optJSONObject("pendingRuntimeRequest");
                if (request != null) return !"auth_refresh".equals(request.optString("kind"))
                    && previous != null && request.optString("id").equals(previous.optString("id"));
                return previous == null && ("input".equals(status) || "approval".equals(status));
            default: return false;
        }
    }
    JSONArray take(long now, boolean suppressed, boolean ready) throws JSONException {
        pending.values().removeIf(alert -> now >= alert.expiresAt());
        JSONArray result = new JSONArray();
        if (suppressed) { pending.clear(); return result; }
        if (!ready) return result;
        for (Alert alert : pending.values()) result.put(new JSONObject().put("environmentId", alert.environmentId())
            .put("thread", alert.thread()).put("kind", alert.kind()));
        pending.clear(); return result;
    }
}
