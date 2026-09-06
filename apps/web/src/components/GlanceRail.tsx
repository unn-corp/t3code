import { Link, useLocation } from "@tanstack/react-router";
import {
  ActivityIcon,
  GaugeIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LayoutDashboardIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PlusIcon,
  Settings2Icon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { cn } from "../lib/utils";
import { useActiveProjectTarget } from "../hooks/useActiveProjectTarget";
import { useThreadShells } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { vcsEnvironment } from "../state/vcs";
import { T3Wordmark } from "./T3Wordmark";
import { readPullRequestListPreferences } from "./pullRequest/pullRequestListPreferences";
import {
  resolveGlanceRailGitPosition,
  summarizeGlanceRail,
  type GlanceRailGitPosition,
} from "./glanceRailStats";

type GlanceRailPath = "/" | "/agent-dashboard" | "/usage" | "/settings";

interface GlanceRailNavItem {
  readonly label: string;
  readonly to: GlanceRailPath;
  readonly icon: LucideIcon;
}

const NAV_ITEMS = [
  { label: "Workspace", to: "/", icon: MessageSquareIcon },
  { label: "Agent Dashboard", to: "/agent-dashboard", icon: LayoutDashboardIcon },
  { label: "Usage", to: "/usage", icon: GaugeIcon },
] as const satisfies ReadonlyArray<GlanceRailNavItem>;

type StatScope = "all" | "project";

function navItemIsActive(pathname: string, to: GlanceRailPath): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}

function GlanceStat({
  icon: Icon,
  label,
  tone,
  value,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly tone: string;
  readonly value: number;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-sidebar-border/70 bg-sidebar-control-surface/55 px-2.5 py-2">
      <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", tone)} />
      <span className="min-w-0 flex-1 truncate text-xs text-sidebar-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-sidebar-foreground">{value}</span>
    </div>
  );
}

const GIT_POSITION_TONE = {
  synced: "text-success-foreground",
  ahead: "text-info-foreground",
  behind: "text-warning-foreground",
  diverged: "text-warning-foreground",
  "not-repository": "text-sidebar-muted-foreground",
} as const satisfies Record<GlanceRailGitPosition["state"], string>;

function GitPositionCard({
  branch,
  hasChanges,
  label,
  projectName,
  state,
}: {
  readonly branch: string | null;
  readonly hasChanges: boolean;
  readonly label: string;
  readonly projectName: string | null;
  readonly state: GlanceRailGitPosition["state"] | "loading" | "unavailable";
}) {
  const tone =
    state === "loading" || state === "unavailable"
      ? "text-sidebar-muted-foreground"
      : GIT_POSITION_TONE[state];

  return (
    <section aria-labelledby="glance-rail-git" className="mt-4">
      <div className="rounded-xl border border-sidebar-border bg-sidebar-control-surface/55 p-3">
        <div className="flex items-center gap-2">
          <GitBranchIcon aria-hidden="true" className={cn("size-4 shrink-0", tone)} />
          <h2 className="min-w-0 flex-1 truncate text-xs font-medium" id="glance-rail-git">
            Main
          </h2>
          <span className={cn("shrink-0 text-xs font-semibold tabular-nums", tone)}>{label}</span>
        </div>
        <p className="mt-2 truncate font-mono text-[11px] text-sidebar-muted-foreground">
          {projectName ?? "No active project"}
          {branch ? ` · ${branch}` : ""}
          {hasChanges ? " · Local changes" : ""}
        </p>
      </div>
    </section>
  );
}

export function GlanceRail() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [statScope, setStatScope] = useState<StatScope>("all");
  const activeProjectTarget = useActiveProjectTarget();
  const threads = useThreadShells();
  const effectiveStatScope =
    statScope === "project" && activeProjectTarget !== null ? "project" : "all";
  const filteredThreads =
    effectiveStatScope === "project" && activeProjectTarget !== null
      ? threads.filter(
          (thread) =>
            thread.environmentId === activeProjectTarget.environmentId &&
            thread.projectId === activeProjectTarget.projectId,
        )
      : threads;
  const stats = summarizeGlanceRail(filteredThreads);
  const gitStatusQuery = useEnvironmentQuery(
    activeProjectTarget === null
      ? null
      : vcsEnvironment.status({
          environmentId: activeProjectTarget.environmentId,
          input: { cwd: activeProjectTarget.cwd },
        }),
  );
  const gitPosition = gitStatusQuery.data
    ? resolveGlanceRailGitPosition(gitStatusQuery.data)
    : null;
  const gitPositionState =
    gitPosition?.state ?? (gitStatusQuery.isPending ? "loading" : "unavailable");
  const gitPositionLabel =
    gitPosition?.label ??
    (activeProjectTarget === null
      ? "Open a thread"
      : gitStatusQuery.isPending
        ? "Checking"
        : "Unavailable");

  return (
    <aside
      aria-label="Quick glance"
      className="group/glance pointer-coarse:hidden fixed right-0 top-1/2 z-40 hidden h-24 w-3 -translate-y-1/2 md:block"
      data-app-sidebar=""
      data-glance-rail=""
    >
      <div className="absolute right-0 top-1/2 w-56 translate-x-[calc(100%-0.25rem)] -translate-y-1/2 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-focus-within/glance:translate-x-0 group-hover/glance:translate-x-0 motion-reduce:transition-none">
        <div className="surface-grain max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-l-xl border-y border-l border-sidebar-border bg-sidebar p-3 text-sidebar-foreground shadow-xl/10">
          <div className="opacity-0 transition-opacity duration-150 group-focus-within/glance:opacity-100 group-hover/glance:opacity-100 motion-reduce:transition-none">
            <div className="flex items-center gap-2.5 border-b border-sidebar-border/70 pb-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs/5">
                <T3Wordmark aria-hidden="true" className="w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold">Quick glance</h2>
                <p className="truncate text-xs text-sidebar-muted-foreground">Live workspace</p>
              </div>
              <Link
                aria-label="Open settings"
                className={cn(
                  "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2",
                  pathname.startsWith("/settings") &&
                    "bg-sidebar-row-selected text-sidebar-foreground",
                )}
                to="/settings"
              >
                <Settings2Icon aria-hidden="true" className="size-4" />
              </Link>
            </div>

            <nav aria-label="Quick navigation" className="mt-3 space-y-1">
              {NAV_ITEMS.map(({ icon: Icon, label, to }) => {
                const isActive = navItemIsActive(pathname, to);
                return (
                  <Link
                    key={to}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex min-h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2",
                      isActive && "bg-sidebar-row-selected font-medium",
                    )}
                    to={to}
                  >
                    <Icon
                      aria-hidden="true"
                      className="size-4 shrink-0 text-sidebar-muted-foreground"
                    />
                    <span className="truncate">{label}</span>
                  </Link>
                );
              })}
            </nav>

            <GitPositionCard
              branch={gitStatusQuery.data?.refName ?? null}
              hasChanges={gitStatusQuery.data?.hasWorkingTreeChanges === true}
              label={gitPositionLabel}
              projectName={activeProjectTarget?.projectName ?? null}
              state={gitPositionState}
            />

            <section aria-labelledby="glance-rail-stats" className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <h2
                  className="text-xs font-medium text-sidebar-muted-foreground"
                  id="glance-rail-stats"
                >
                  Stats
                </h2>
                <div
                  aria-label="Stats scope"
                  className="flex rounded-md bg-sidebar-control-surface p-0.5"
                  role="group"
                >
                  <button
                    aria-pressed={effectiveStatScope === "all"}
                    className={cn(
                      "min-h-7 cursor-pointer rounded-sm px-2 text-xs text-sidebar-muted-foreground outline-hidden ring-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2",
                      effectiveStatScope === "all" &&
                        "bg-sidebar-row-selected text-sidebar-foreground shadow-xs/5",
                    )}
                    onClick={() => setStatScope("all")}
                    type="button"
                  >
                    All
                  </button>
                  <button
                    aria-pressed={effectiveStatScope === "project"}
                    className={cn(
                      "min-h-7 cursor-pointer rounded-sm px-2 text-xs text-sidebar-muted-foreground outline-hidden ring-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
                      effectiveStatScope === "project" &&
                        "bg-sidebar-row-selected text-sidebar-foreground shadow-xs/5",
                    )}
                    disabled={activeProjectTarget === null}
                    onClick={() => setStatScope("project")}
                    type="button"
                  >
                    Current
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <GlanceStat
                  icon={ActivityIcon}
                  label="Running"
                  tone="text-info-foreground"
                  value={stats.running}
                />
                <GlanceStat
                  icon={TriangleAlertIcon}
                  label="Needs you"
                  tone={
                    stats.needsAttention > 0
                      ? "text-warning-foreground"
                      : "text-sidebar-muted-foreground"
                  }
                  value={stats.needsAttention}
                />
                <GlanceStat
                  icon={MessagesSquareIcon}
                  label="Threads"
                  tone="text-sidebar-muted-foreground"
                  value={stats.threads}
                />
              </div>
            </section>

            <section aria-labelledby="glance-rail-actions" className="mt-4">
              <h2
                className="mb-2 px-1 text-xs font-medium text-sidebar-muted-foreground"
                id="glance-rail-actions"
              >
                Actions
              </h2>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  className="flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-sidebar-border bg-sidebar-control-surface/55 px-2 text-xs font-medium outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2"
                  onClick={() => openCommandPalette({ open: "new-thread-in" })}
                  type="button"
                >
                  <PlusIcon aria-hidden="true" className="size-3.5" />
                  New thread
                </button>
                <Link
                  className="flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-sidebar-border bg-sidebar-control-surface/55 px-2 text-xs font-medium outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2"
                  search={readPullRequestListPreferences()}
                  to="/pull-requests"
                >
                  <GitPullRequestIcon aria-hidden="true" className="size-3.5" />
                  Pull requests
                </Link>
              </div>
            </section>
          </div>
        </div>

        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-24 w-1 -translate-y-1/2 rounded-l-full bg-primary/75 shadow-[0_0_12px_color-mix(in_srgb,var(--primary)_35%,transparent)] transition-opacity duration-150 group-focus-within/glance:opacity-0 group-hover/glance:opacity-0 motion-reduce:transition-none"
        />
      </div>
    </aside>
  );
}
