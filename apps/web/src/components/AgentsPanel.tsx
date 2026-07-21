import { memo, useEffect, useRef, useState } from "react";
import type { ThreadAgentSnapshot } from "@t3tools/contracts";
import {
  deriveAgentPanelState,
  formatAgentTokenCount,
  isTerminalAgentStatus,
  type AgentPanelGroup,
  type AgentPanelPhase,
} from "@t3tools/client-runtime/state/thread-agents";
import { BotIcon, BracesIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { formatDuration } from "../session-logic";

interface AgentsPanelProps {
  agents: ReadonlyArray<ThreadAgentSnapshot>;
  onOpenScript?: (scriptPath: string) => void;
  mode?: "sheet" | "sidebar" | "embedded";
}

const STATUS_DOT_CLASS: Record<ThreadAgentSnapshot["status"], string> = {
  pending: "bg-muted-foreground/40",
  running: "bg-sky-500 animate-status-pulse",
  waiting: "bg-warning animate-status-pulse",
  idle: "bg-sky-500/50",
  completed: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/60",
};

const STATUS_LABEL: Record<ThreadAgentSnapshot["status"], string> = {
  pending: "Queued",
  running: "Running",
  waiting: "Waiting",
  idle: "Idle · resumable",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

function AgentStatusDot({ status }: { status: ThreadAgentSnapshot["status"] }) {
  return (
    <span
      className={cn("size-1.75 shrink-0 rounded-full", STATUS_DOT_CLASS[status])}
      role="img"
      aria-label={STATUS_LABEL[status]}
    />
  );
}

/**
 * Self-ticking elapsed label (WorkingTimer pattern): writes its own text node
 * so per-second updates never cause React commits. Frozen once `endedAt` is
 * set or the agent settles.
 */
function AgentElapsed({ agent }: { agent: ThreadAgentSnapshot }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const settled = isTerminalAgentStatus(agent.status) || agent.status === "idle";
  const startMs = Date.parse(agent.firstStartedAt);
  const endMs = agent.endedAt
    ? Date.parse(agent.endedAt)
    : settled
      ? Date.parse(agent.lastActivityAt)
      : null;
  const initialText = formatDuration((endMs ?? Date.now()) - startMs);

  useEffect(() => {
    if (endMs !== null) return;
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = formatDuration(Date.now() - startMs);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startMs, endMs]);

  return (
    <span ref={textRef} className="font-mono text-[11px] tabular-nums text-muted-foreground">
      {initialText}
    </span>
  );
}

function AgentCard({ agent }: { agent: ThreadAgentSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const settled = isTerminalAgentStatus(agent.status);
  const activity =
    agent.status === "waiting"
      ? "Waiting on approval"
      : (agent.currentActivity ??
        (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
        agent.resultSummary ??
        agent.errorMessage);
  const hasFeed = agent.recentActivity.length > 0;

  return (
    <button
      type="button"
      onClick={() => hasFeed && setExpanded((value) => !value)}
      className={cn(
        "w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-left",
        hasFeed && "cursor-pointer hover:border-border",
        settled && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <AgentStatusDot status={agent.status} />
        <span className="min-w-0 truncate text-[12.5px] font-semibold">{agent.name}</span>
        {agent.agentType ? (
          <Badge variant="secondary" size="sm" className="min-w-0 max-w-28 shrink-1 truncate">
            {agent.agentType}
          </Badge>
        ) : null}
        {agent.model ? (
          <Badge variant="outline" size="sm" className="shrink-0 text-muted-foreground">
            {agent.model}
          </Badge>
        ) : null}
        <span className="ml-auto shrink-0">
          <AgentElapsed agent={agent} />
        </span>
        {agent.status === "completed" ? (
          <CheckIcon className="size-3 shrink-0 text-success" />
        ) : null}
      </div>
      {activity ? (
        <div
          className={cn(
            "mt-1 truncate text-[11.5px]",
            agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {activity}
        </div>
      ) : null}
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        {agent.usage ? (
          <span className="font-mono tabular-nums text-foreground">
            {formatAgentTokenCount(agent.usage.totalTokens)}{" "}
            <span className="text-muted-foreground">tok</span>
            {agent.status === "running" ? <span className="text-sky-500"> ↑</span> : null}
          </span>
        ) : null}
        {agent.usage?.toolUses ? (
          <>
            <span className="text-border">·</span>
            <span>{agent.usage.toolUses} tools</span>
          </>
        ) : null}
        {agent.activationCount > 1 ? (
          <>
            <span className="text-border">·</span>
            <span>run {agent.activationCount}</span>
          </>
        ) : null}
        {hasFeed ? (
          <span className="ml-auto text-muted-foreground/70">
            {expanded ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronRightIcon className="size-3" />
            )}
          </span>
        ) : null}
      </div>
      {expanded && hasFeed ? (
        <div className="mt-2 space-y-0.5 border-t border-border/60 pt-2">
          {agent.recentActivity.toReversed().map((entry) => (
            <div key={`${entry.at}-${entry.summary}`} className="flex gap-2 text-[11px]">
              <span className="shrink-0 font-mono tabular-nums text-muted-foreground/60">
                {entry.at.slice(11, 19)}
              </span>
              <span className="truncate text-muted-foreground">{entry.summary}</span>
            </div>
          ))}
        </div>
      ) : null}
    </button>
  );
}

function PhaseHeader({ phase }: { phase: AgentPanelPhase }) {
  const runningCount = phase.agents.filter((agent) => agent.status === "running").length;
  const doneCount = phase.agents.filter((agent) => isTerminalAgentStatus(agent.status)).length;
  return (
    <div className="flex items-center gap-2 px-1 pt-2 pb-1 text-[10px] text-muted-foreground">
      <span
        className={cn(
          "font-bold tracking-wider uppercase",
          phase.status === "done" && "text-success-foreground",
          phase.status === "running" && "text-sky-500",
          phase.status === "pending" && "opacity-50",
        )}
      >
        {phase.status === "done" ? "✓ " : ""}
        {phase.title}
      </span>
      {phase.status === "running" ? (
        <span>
          {runningCount} running{doneCount > 0 ? ` · ${doneCount} done` : ""}
        </span>
      ) : phase.status === "pending" ? (
        <span>pending</span>
      ) : null}
      <span className="h-px flex-1 bg-border/60" />
    </div>
  );
}

function AgentGroup({
  group,
  onOpenScript,
}: {
  group: AgentPanelGroup;
  onOpenScript?: ((scriptPath: string) => void) | undefined;
}) {
  const scriptPath = group.workflow?.scriptPath;
  return (
    <div>
      <div className="flex items-center gap-2 px-1 pb-1 text-[10.5px] font-bold tracking-wider text-muted-foreground uppercase">
        {group.workflow ? (
          <>
            <span className="truncate">Workflow · {group.workflow.name}</span>
            {scriptPath && onOpenScript ? (
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenScript(scriptPath);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.stopPropagation();
                    onOpenScript(scriptPath);
                  }
                }}
                className="inline-flex cursor-pointer items-center gap-1 font-mono text-[10px] font-medium tracking-normal text-primary normal-case hover:underline"
              >
                <BracesIcon className="size-3" /> script
              </span>
            ) : null}
          </>
        ) : (
          <span>Direct spawns</span>
        )}
        <span className="h-px flex-1 bg-border/60" />
      </div>
      {group.phases.map((phase) => (
        <div key={phase.index}>
          <PhaseHeader phase={phase} />
          <div className="space-y-1.5">
            {phase.agents.map((agent) => (
              <AgentCard key={agent.agentId} agent={agent} />
            ))}
          </div>
        </div>
      ))}
      {group.rest.length > 0 ? (
        <div className={cn("space-y-1.5", group.phases.length > 0 && "pt-2")}>
          {group.rest.map((agent) => (
            <AgentCard key={agent.agentId} agent={agent} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const AgentsPanel = memo(function AgentsPanel({ agents, onOpenScript, mode }: AgentsPanelProps) {
  const state = deriveAgentPanelState(agents);

  if (agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <BotIcon className="size-8 text-muted-foreground/40" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="text-xs text-muted-foreground">
          When this thread spawns subagents or runs a workflow, they show up here with live status
          and token usage.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", mode === "embedded" && "bg-transparent")}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {state.groups.map((group, index) => (
            <AgentGroup
              key={group.workflow?.agentId ?? `direct-${index}`}
              group={group}
              onOpenScript={onOpenScript}
            />
          ))}
        </div>
      </ScrollArea>
      <div className="flex items-center gap-3 border-t border-border/60 px-3.5 py-2 text-[11px] text-muted-foreground">
        {state.runningCount > 0 ? (
          <span className="flex items-center gap-1.5">
            <span className="size-1.75 rounded-full bg-sky-500 animate-status-pulse" />
            {state.runningCount} running
          </span>
        ) : null}
        {state.waitingCount > 0 ? <span>{state.waitingCount} waiting</span> : null}
        {state.settledCount > 0 ? <span>{state.settledCount} settled</span> : null}
        <span className="ml-auto font-mono tabular-nums">
          Σ {formatAgentTokenCount(state.totalTokens)} tok
        </span>
      </div>
    </div>
  );
});

export default AgentsPanel;
