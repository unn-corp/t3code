package com.devotek.t3code.pwa;

import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class PhoneAlertQueueTest {
    private JSONObject thread(String status) throws Exception {
        return new JSONObject().put("id", "thread").put("latestRunId", "run")
            .put("status", status).put("activityRunStatus", JSONObject.NULL)
            .put("latestRunCompletedAt", "2026-10-07T00:00:00Z")
            .put("archivedAt", JSONObject.NULL).put("deletedAt", JSONObject.NULL);
    }
    @Test public void waitsForAllHostsThenDeliversOnlyOnce() throws Exception {
        PhoneAlertQueue queue = new PhoneAlertQueue();
        queue.offer("host", thread("completed"), "agent_completed", 0);
        assertEquals(0, queue.take(1, false, false).length());
        assertEquals(1, queue.take(2, false, true).length());
        assertEquals(0, queue.take(3, false, true).length());
    }
    @Test public void viewedEventsAreConsumedAndNeverReplayAfterMinimizing() throws Exception {
        PhoneAlertQueue queue = new PhoneAlertQueue();
        queue.offer("host", thread("completed"), "agent_completed", 0);
        assertEquals(0, queue.take(1, true, false).length());
        assertEquals(0, queue.take(2, false, true).length());
    }
    @Test public void expiresAndRemovesDisconnectedRegistrations() throws Exception {
        PhoneAlertQueue queue = new PhoneAlertQueue();
        queue.offer("host", thread("failed"), "agent_failed", 0);
        assertEquals(0, queue.take(120_000, false, true).length());
        queue.offer("removed", thread("failed"), "agent_failed", 120_000);
        queue.configure(Set.of("host"));
        assertEquals(0, queue.take(120_001, false, true).length());
    }
    @Test public void waitingCompletionDoesNotAlertAfterNewRunStarts() throws Exception {
        PhoneAlertQueue queue = new PhoneAlertQueue();
        queue.offer("host", thread("completed"), "agent_completed", 0);
        queue.reconcile("host", new JSONObject().put("kind", "thread.updated")
            .put("thread", thread("running").put("latestRunId", "next")));
        assertEquals(0, queue.take(1, false, true).length());
    }
    @Test public void waitingCompletionDoesNotAlertWhenDelegatedWorkAppears() throws Exception {
        PhoneAlertQueue queue = new PhoneAlertQueue();
        queue.offer("host", thread("completed"), "agent_completed", 0);
        queue.reconcile("host", new JSONObject().put("kind", "thread.updated")
            .put("thread", thread("completed").put("pendingBackgroundTasks", new JSONArray()
                .put(new JSONObject().put("kind", "delegated_task")))));
        assertEquals(0, queue.take(1, false, true).length());
    }
    @Test public void waitingCompletionDoesNotAlertWhenInputIsRequested() throws Exception {
        PhoneAlertQueue queue = new PhoneAlertQueue();
        queue.offer("host", thread("completed"), "agent_completed", 0);
        queue.reconcile("host", new JSONObject().put("kind", "thread.updated")
            .put("thread", thread("completed").put("pendingRuntimeRequest", new JSONObject()
                .put("id", "request").put("kind", "user_input"))));
        assertEquals(0, queue.take(1, false, true).length());
    }
    @Test public void answeredApprovalAndArchivedThreadDoNotAlertLater() throws Exception {
        PhoneAlertQueue queue = new PhoneAlertQueue();
        queue.offer("host", thread("waiting").put("pendingRuntimeRequest", new JSONObject().put("id", "request").put("kind", "command_approval")), "input_required", 0);
        queue.reconcile("host", new JSONObject().put("kind", "thread.updated").put("thread", thread("running")));
        assertEquals(0, queue.take(1, false, true).length());
        queue.offer("host", thread("completed"), "agent_completed", 2);
        queue.reconcile("host", new JSONObject().put("kind", "thread.updated").put("thread", thread("completed").put("archivedAt", "now")));
        assertEquals(0, queue.take(3, false, true).length());
    }
    @Test public void snapshotPruningSkipsEnrichmentAndRespectsHostBoundary() throws Exception {
        PhoneAlertQueue queue = new PhoneAlertQueue();
        queue.offer("a", thread("completed"), "agent_completed", 0);
        queue.offer("b", thread("completed"), "agent_completed", 0);
        JSONObject snapshot = new JSONObject().put("kind", "snapshot").put("snapshot", new JSONObject().put("threads", new JSONArray()));
        queue.reconcile("a", new JSONObject(snapshot.toString()).put("resolvedRepositoryIdentityRoots", new JSONArray()));
        queue.reconcile("a", snapshot);
        JSONArray alerts = queue.take(1, false, true);
        assertEquals(1, alerts.length()); assertEquals("b", alerts.getJSONObject(0).getString("environmentId"));
    }
}
