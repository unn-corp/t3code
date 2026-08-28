import { describe, expect, it } from "@effect/vitest";

import { parseAgentFindingsSearch, parseAgentRunsSearch } from "./agentDashboardRouteSearch";

describe("agent dashboard route search", () => {
  it("keeps valid finding context and drops unsupported values", () => {
    expect(
      parseAgentFindingsSearch({
        project: " project-1 ",
        severity: "critical",
        status: "all",
        findingId: "finding-1",
      }),
    ).toEqual({
      project: "project-1",
      severity: "critical",
      status: "all",
      findingId: "finding-1",
    });
    expect(parseAgentFindingsSearch({ severity: "urgent", status: "waiting" })).toEqual({});
  });

  it("keeps valid run and coverage destinations", () => {
    expect(
      parseAgentRunsSearch({
        project: "project-2",
        status: "failed",
        runId: "run-1",
        focus: "runs",
      }),
    ).toEqual({
      project: "project-2",
      status: "failed",
      runId: "run-1",
      focus: "runs",
    });
    expect(parseAgentRunsSearch({ status: "broken", focus: "metrics" })).toEqual({});
  });
});
