package com.devotek.t3code.pwa;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class ThreadAlertStateTest {
    private JSONObject thread(String status) throws Exception {
        return new JSONObject().put("id", "thread").put("latestRunId", "run")
            .put("status", status).put("activityRunStatus", JSONObject.NULL)
            .put("latestRunCompletedAt", "completed".equals(status) ? "2026-10-05T10:00:00Z" : JSONObject.NULL)
            .put("archivedAt", JSONObject.NULL).put("deletedAt", JSONObject.NULL)
            .put("hasActionableProposedPlan", false).put("lineage", new JSONObject().put("relationshipToParent", "root"));
    }
    @Test public void openingWithOldCompletedThreadsDoesNotAlert() throws Exception {
        assertNull(new ThreadAlertState("{}").update(thread("completed")));
    }
    @Test public void completionIsDeliveredOnceAndSurvivesReconnect() throws Exception {
        ThreadAlertState state = new ThreadAlertState("{}");
        state.update(thread("running"));
        assertEquals("agent_completed", state.update(thread("completed")));
        assertNull(new ThreadAlertState(state.save()).update(thread("completed")));
    }
    @Test public void catchesCompletionDuringADisconnection() throws Exception {
        ThreadAlertState state = new ThreadAlertState("{}"); state.update(thread("running"));
        assertEquals("agent_completed", new ThreadAlertState(state.save()).update(thread("completed")));
    }
    @Test public void newRunsCanFinishWithoutReturningToRunningInTheSnapshot() throws Exception {
        ThreadAlertState state = new ThreadAlertState("{}"); state.update(thread("completed"));
        assertEquals("agent_completed", state.update(thread("completed").put("latestRunId", "run-2")));
    }
    @Test public void inputAndApprovalAreDeliveredAndDeduplicatedByRequest() throws Exception {
        ThreadAlertState state = new ThreadAlertState("{}"); state.update(thread("running"));
        JSONObject input = thread("waiting").put("pendingRuntimeRequest", new JSONObject().put("id", "a").put("kind", "user_input"));
        assertEquals("input_required", state.update(input)); assertNull(state.update(input));
        input.getJSONObject("pendingRuntimeRequest").put("id", "b").put("kind", "command_approval");
        assertEquals("input_required", state.update(input));
    }
    @Test public void authRefreshIsNotPresentedAsApproval() throws Exception {
        ThreadAlertState state = new ThreadAlertState("{}"); state.update(thread("running"));
        assertNull(state.update(thread("waiting").put("pendingRuntimeRequest", new JSONObject().put("id", "a").put("kind", "auth_refresh"))));
    }
    @Test public void existingUnansweredRequestAlertsOnceWithoutReplayingHistory() throws Exception {
        ThreadAlertState state = new ThreadAlertState("{}");
        JSONObject input = thread("waiting").put("pendingRuntimeRequest", new JSONObject().put("id", "a").put("kind", "user_input"));
        assertEquals("input_required", state.update(input));
        assertNull(new ThreadAlertState(state.save()).update(input));
        assertNull(new ThreadAlertState("{}").update(thread("failed")));
    }
    @Test public void failedRunsAlertButCancelledRunsDoNot() throws Exception {
        ThreadAlertState state = new ThreadAlertState("{}"); state.update(thread("running"));
        assertEquals("agent_failed", state.update(thread("failed"))); assertNull(state.update(thread("failed")));
        assertNull(state.update(thread("cancelled")));
    }
    @Test public void planReadyIsDeliveredOnlyOnItsTransition() throws Exception {
        ThreadAlertState state = new ThreadAlertState("{}"); state.update(thread("running"));
        assertEquals("plan_ready", state.update(thread("waiting").put("hasActionableProposedPlan", true)));
        assertNull(state.update(thread("waiting").put("hasActionableProposedPlan", true)));
    }
    @Test public void archivedDeletedAndSubagentThreadsStayQuiet() throws Exception {
        for (String field : new String[]{"archivedAt", "deletedAt", "lineage"}) {
            ThreadAlertState state = new ThreadAlertState("{}"); state.update(thread("running"));
            JSONObject completed = thread("completed");
            completed.put(field, "lineage".equals(field) ? new JSONObject().put("relationshipToParent", "subagent") : "2026-10-05");
            assertNull(state.update(completed));
        }
    }
    @Test public void backgroundSubagentsHoldCompletionButDevServersDoNot() throws Exception {
        ThreadAlertState state = new ThreadAlertState("{}"); state.update(thread("running"));
        JSONObject completed = thread("completed").put("pendingBackgroundTasks", new JSONArray().put(new JSONObject().put("kind", "subagent")));
        assertNull(state.update(completed));
        completed.put("pendingBackgroundTasks", new JSONArray().put(new JSONObject().put("kind", "command")));
        assertEquals("agent_completed", state.update(completed));
    }
    @Test public void activityRunCanStillBeWorkingAfterLatestCheckpointFinishes() throws Exception {
        ThreadAlertState state = new ThreadAlertState("{}"); state.update(thread("running"));
        assertNull(state.update(thread("completed").put("activityRunStatus", "running")));
        assertEquals("agent_completed", state.update(thread("completed")));
    }
    @Test public void removedThreadsAndCorruptCacheArePrimedAgain() throws Exception {
        ThreadAlertState state = new ThreadAlertState("{}"); state.update(thread("running"));
        state.retain(new JSONArray()); assertNull(state.update(thread("completed")));
        assertNull(new ThreadAlertState("not json").update(thread("completed")));
    }
    @Test public void repositoryMetadataRefreshCannotEraseCompletionWatermarks() throws Exception {
        ThreadAlertState state = new ThreadAlertState("{}");
        JSONObject snapshot = new JSONObject().put("kind", "snapshot").put("snapshot", new JSONObject().put("threads", new JSONArray().put(thread("running"))));
        assertEquals(0, state.consume(snapshot).length());
        JSONObject enrichment = new JSONObject().put("kind", "snapshot").put("resolvedRepositoryIdentityRoots", new JSONArray().put("/fixture"))
            .put("snapshot", new JSONObject().put("threads", new JSONArray()));
        assertEquals(0, state.consume(enrichment).length());
        JSONObject completed = new JSONObject().put("kind", "thread.updated").put("thread", thread("completed"));
        assertEquals("agent_completed", state.consume(completed).getJSONObject(0).getString("kind"));
        state.consume(enrichment);
        assertEquals(0, new ThreadAlertState(state.save()).consume(completed).length());
    }
}
