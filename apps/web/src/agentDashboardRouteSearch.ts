import type { AgentDashboardAutomationRun, AgentDashboardFinding } from "@t3tools/contracts";

import type { DashboardFindingStatus } from "./agentDashboardPages";

export type AgentFindingsStatusFilter =
  | "pipeline"
  | "ready-to-act"
  | "needs-qualification"
  | "policy-review"
  | "resolved"
  | "all"
  | DashboardFindingStatus;

export interface AgentFindingsSearch {
  readonly project?: string;
  readonly severity?: "all" | AgentDashboardFinding["severity"];
  readonly status?: AgentFindingsStatusFilter;
  readonly findingId?: string;
}

export type AgentRunsStatusFilter = "all" | AgentDashboardAutomationRun["status"];

export interface AgentRunsSearch {
  readonly project?: string;
  readonly status?: AgentRunsStatusFilter;
  readonly runId?: string;
  readonly focus?: "coverage" | "runs";
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
}

export function parseAgentFindingsStatus(value: unknown): AgentFindingsStatusFilter | undefined {
  switch (value) {
    case "pipeline":
    case "ready-to-act":
    case "needs-qualification":
    case "policy-review":
    case "resolved":
    case "all":
    case "open":
    case "in-progress":
    case "snoozed":
    case "done":
    case "archived":
      return value;
    default:
      return undefined;
  }
}

function parseFindingSeverity(
  value: unknown,
): "all" | AgentDashboardFinding["severity"] | undefined {
  switch (value) {
    case "all":
    case "critical":
    case "high":
    case "medium":
    case "low":
    case "info":
      return value;
    default:
      return undefined;
  }
}

export function parseAgentFindingsSearch(raw: Record<string, unknown>): AgentFindingsSearch {
  const project = boundedString(raw.project);
  const severity = parseFindingSeverity(raw.severity);
  const status = parseAgentFindingsStatus(raw.status);
  const findingId = boundedString(raw.findingId);
  return {
    ...(project ? { project } : {}),
    ...(severity ? { severity } : {}),
    ...(status ? { status } : {}),
    ...(findingId ? { findingId } : {}),
  };
}

export function parseAgentRunsStatus(value: unknown): AgentRunsStatusFilter | undefined {
  switch (value) {
    case "all":
    case "queued":
    case "running":
    case "ingesting":
    case "succeeded":
    case "partial":
    case "failed":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

export function parseAgentRunsSearch(raw: Record<string, unknown>): AgentRunsSearch {
  const project = boundedString(raw.project);
  const status = parseAgentRunsStatus(raw.status);
  const runId = boundedString(raw.runId);
  const focus = raw.focus === "coverage" || raw.focus === "runs" ? raw.focus : undefined;
  return {
    ...(project ? { project } : {}),
    ...(status ? { status } : {}),
    ...(runId ? { runId } : {}),
    ...(focus ? { focus } : {}),
  };
}
