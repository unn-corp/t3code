package com.devotek.t3code.pwa;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Minimal durable watermarks, so reconnecting cannot replay old work as new alerts. */
final class ThreadAlertState {
    private JSONObject states;
    ThreadAlertState(String saved) {
        try { states = new JSONObject(saved); }
        catch (JSONException ignored) { states = new JSONObject(); }
    }
    String save() { return states.toString(); }
    void remove(String id) { states.remove(id); }
    JSONArray consume(JSONObject item) throws JSONException {
        JSONArray alerts = new JSONArray();
        switch (item.optString("kind")) {
            case "snapshot": {
                // Repository enrichment deliberately carries an empty thread array;
                // only the unmarked authoritative snapshot can prune watermarks.
                if (item.has("resolvedRepositoryIdentityRoots")) return alerts;
                JSONArray threads = item.getJSONObject("snapshot").getJSONArray("threads");
                for (int i = 0; i < threads.length(); i++) collect(threads.getJSONObject(i), alerts);
                retain(threads); break;
            }
            case "thread.updated": collect(item.getJSONObject("thread"), alerts); break;
            case "thread.removed": remove(item.getString("threadId")); break;
            default: break;
        }
        return alerts;
    }
    private void collect(JSONObject thread, JSONArray alerts) throws JSONException {
        String kind = update(thread);
        if (kind != null) alerts.put(new JSONObject().put("kind", kind).put("thread", thread));
    }
    void retain(JSONArray threads) {
        java.util.Set<String> ids = new java.util.HashSet<>();
        for (int i = 0; i < threads.length(); i++) {
            JSONObject thread = threads.optJSONObject(i);
            if (thread != null) ids.add(thread.optString("id"));
        }
        java.util.List<String> removed = new java.util.ArrayList<>();
        states.keys().forEachRemaining(id -> { if (!ids.contains(id)) removed.add(id); });
        for (String id : removed) states.remove(id);
    }
    String update(JSONObject thread) throws JSONException {
        String id = thread.getString("id");
        JSONObject previous = states.optJSONObject(id);
        JSONObject pending = thread.optJSONObject("pendingRuntimeRequest");
        String status = thread.isNull("activityRunStatus") ? thread.optString("status") : thread.optString("activityRunStatus");
        if (pending != null && !"auth_refresh".equals(pending.optString("kind"))) {
            status = "user_input".equals(pending.optString("kind")) ? "input" : "approval";
        }
        String attention = "";
        if ("input".equals(status) || "approval".equals(status) || "failed".equals(status)) {
            attention = thread.optString("latestRunId") + ":" + status
                + (pending == null ? "" : ":" + pending.optString("id"));
        }
        String completed = previous == null ? "" : previous.optString("completed");
        boolean holdsCompletion = false;
        JSONArray background = thread.optJSONArray("pendingBackgroundTasks");
        if (background != null) for (int i = 0; i < background.length(); i++) {
            JSONObject task = background.optJSONObject(i);
            if (task != null && !"command".equals(task.optString("kind"))) holdsCompletion = true;
        }
        if (("completed".equals(status) || "idle".equals(status)) && !holdsCompletion
                && !thread.isNull("latestRunId") && !thread.isNull("latestRunCompletedAt")) {
            completed = thread.optString("latestRunId") + ":" + thread.optString("latestRunCompletedAt");
        }
        boolean plan = thread.optBoolean("hasActionableProposedPlan");
        states.put(id, new JSONObject().put("attention", attention).put("completed", completed).put("plan", plan));
        JSONObject lineage = thread.optJSONObject("lineage");
        if (!thread.isNull("archivedAt") || !thread.isNull("deletedAt")
                || (lineage != null && "subagent".equals(lineage.optString("relationshipToParent")))) return null;
        // Existing history stays quiet, but an outstanding request still needs an answer.
        if (previous == null) return "input".equals(status) || "approval".equals(status) ? "input_required" : null;
        if (!attention.isEmpty() && !attention.equals(previous.optString("attention"))) {
            return "failed".equals(status) ? "agent_failed" : "input_required";
        }
        if (!completed.isEmpty() && !completed.equals(previous.optString("completed"))) return "agent_completed";
        if (plan && !previous.optBoolean("plan")) return "plan_ready";
        return null;
    }
}
