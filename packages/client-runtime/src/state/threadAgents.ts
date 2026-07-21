/**
 * Derivation helpers for the thread agent roster.
 *
 * The server ships the full per-thread roster latest-wins in the payload of
 * `agent.snapshot` activities (see `@t3tools/contracts` ThreadAgentsActivityPayload).
 * Mirrors the `context-window.updated` pattern: scan activities newest-first,
 * decode tolerantly, ignore rows that fail to decode.
 */
import {
  THREAD_AGENT_TERMINAL_STATUSES,
  THREAD_AGENTS_ACTIVITY_KIND,
  ThreadAgentsActivityPayload,
  type OrchestrationThreadActivity,
  type ThreadAgentSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodePayload = Schema.decodeUnknownOption(ThreadAgentsActivityPayload);

export function deriveLatestAgentSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<ThreadAgentSnapshot> {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== THREAD_AGENTS_ACTIVITY_KIND) {
      continue;
    }
    const decoded = decodePayload(activity.payload);
    if (decoded._tag === "Some") {
      return decoded.value.agents;
    }
  }
  return [];
}

export function isTerminalAgentStatus(status: ThreadAgentSnapshot["status"]): boolean {
  return THREAD_AGENT_TERMINAL_STATUSES.has(status);
}

export interface AgentPanelGroup {
  /** The workflow snapshot this group belongs to, or null for direct spawns. */
  readonly workflow: ThreadAgentSnapshot | null;
  /** Phase sections in declared order; agents without a phase land in `rest`. */
  readonly phases: ReadonlyArray<AgentPanelPhase>;
  readonly rest: ReadonlyArray<ThreadAgentSnapshot>;
}

export interface AgentPanelPhase {
  readonly index: number;
  readonly title: string;
  readonly status: "pending" | "running" | "done";
  readonly agents: ReadonlyArray<ThreadAgentSnapshot>;
}

export interface AgentPanelState {
  readonly groups: ReadonlyArray<AgentPanelGroup>;
  readonly runningCount: number;
  readonly waitingCount: number;
  readonly settledCount: number;
  readonly totalTokens: number;
}

function phaseStatus(agents: ReadonlyArray<ThreadAgentSnapshot>): "pending" | "running" | "done" {
  if (agents.length === 0) return "pending";
  if (agents.every((agent) => isTerminalAgentStatus(agent.status))) return "done";
  return "running";
}

export function deriveAgentPanelState(agents: ReadonlyArray<ThreadAgentSnapshot>): AgentPanelState {
  const workflows = agents.filter((agent) => agent.kind === "workflow");
  const byParent = new Map<string, ThreadAgentSnapshot[]>();
  const direct: ThreadAgentSnapshot[] = [];
  for (const agent of agents) {
    if (agent.kind === "workflow") continue;
    if (agent.parentAgentId) {
      const list = byParent.get(agent.parentAgentId) ?? [];
      list.push(agent);
      byParent.set(agent.parentAgentId, list);
    } else {
      direct.push(agent);
    }
  }

  const groups: AgentPanelGroup[] = [];
  for (const workflow of workflows) {
    const members = byParent.get(workflow.agentId) ?? [];
    byParent.delete(workflow.agentId);
    const declaredPhases = workflow.phases ?? [];
    const phases: AgentPanelPhase[] = declaredPhases.map((phase) => {
      const phaseAgents = members.filter((agent) => agent.phaseIndex === phase.index);
      return {
        index: phase.index,
        title: phase.title,
        status: phaseStatus(phaseAgents),
        agents: phaseAgents,
      };
    });
    const inDeclaredPhase = new Set(
      phases.flatMap((phase) => phase.agents.map((agent) => agent.agentId)),
    );
    groups.push({
      workflow,
      phases,
      rest: members.filter((agent) => !inDeclaredPhase.has(agent.agentId)),
    });
  }
  // Orphaned parent groups (parent never materialized) fold into direct spawns.
  for (const list of byParent.values()) {
    direct.push(...list);
  }
  if (direct.length > 0) {
    groups.push({ workflow: null, phases: [], rest: direct });
  }

  let runningCount = 0;
  let waitingCount = 0;
  let settledCount = 0;
  let totalTokens = 0;
  for (const agent of agents) {
    if (agent.status === "running" || agent.status === "pending") runningCount += 1;
    else if (agent.status === "waiting") waitingCount += 1;
    else if (isTerminalAgentStatus(agent.status)) settledCount += 1;
    totalTokens += agent.usage?.totalTokens ?? 0;
  }

  return { groups, runningCount, waitingCount, settledCount, totalTokens };
}

export function formatAgentTokenCount(totalTokens: number): string {
  if (totalTokens >= 1_000_000) {
    return `${(totalTokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (totalTokens >= 1_000) {
    return `${(totalTokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${totalTokens}`;
}
