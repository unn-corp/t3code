import { CheckIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { PROVIDER_DISPLAY_NAMES, type EnvironmentId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { updateProvidersInEnvironment } from "../environmentApi";
import { useLocalEnvironmentUpdateGroups } from "./ProviderUpdateLaunchNotification.environments";
import {
  collectProviderUpdateOutcomeSnapshots,
  firstRejectedProviderUpdateMessage,
  getProviderUpdateProgressToastView,
  getProviderUpdateSidebarPillView,
  type LocalEnvironmentUpdateGroup,
  type ProviderUpdateSidebarPillView,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

// If neither the dispatch result nor server state ever reports the update (e.g.
// the request never reached the backend), stop the spinner after this long so
// the row reverts to its Update button instead of spinning forever.
const PENDING_EXPIRY_MS = 20_000;

type RowStatusKind = "idle" | "loading" | "success" | "failed" | "unchanged";

interface RowStatus {
  readonly kind: RowStatusKind;
  readonly text: string;
}

function providerNamesFor(group: LocalEnvironmentUpdateGroup): string {
  return group.candidates
    .map((candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver)
    .join(", ");
}

/**
 * Resolve a row's display from every available signal, in priority order:
 * a transport rejection, then the dispatch's own result payload (reliable even
 * when a secondary backend's config does not re-sync), then live server state
 * (reliable even when the dispatch RPC is lost to a reconnect), then the
 * optimistic pending spinner, then the idle "ready to update" state.
 */
function resolveRowStatus(input: {
  readonly group: LocalEnvironmentUpdateGroup;
  readonly error: string | undefined;
  readonly result: ProviderUpdateToastView | undefined;
  readonly pill: ProviderUpdateSidebarPillView | null;
  readonly isPending: boolean;
}): RowStatus {
  if (input.error) {
    return { kind: "failed", text: input.error };
  }
  if (input.result) {
    switch (input.result.phase) {
      case "succeeded":
        return { kind: "success", text: "Updated" };
      case "failed":
        return { kind: "failed", text: input.result.description };
      case "unchanged":
        return { kind: "unchanged", text: input.result.description };
      default:
        return { kind: "loading", text: "Updating…" };
    }
  }
  if (input.pill) {
    switch (input.pill.tone) {
      case "success":
        return { kind: "success", text: "Updated" };
      case "error":
        return { kind: "failed", text: input.pill.description };
      case "warning":
        return { kind: "unchanged", text: input.pill.description };
      default:
        return { kind: "loading", text: "Updating…" };
    }
  }
  if (input.isPending) {
    return { kind: "loading", text: "Updating…" };
  }
  return { kind: "idle", text: providerNamesFor(input.group) };
}

function rowToneClass(kind: RowStatusKind): string {
  switch (kind) {
    case "failed":
      return "text-destructive";
    case "unchanged":
      return "text-warning";
    case "success":
      return "text-success";
    default:
      return "text-muted-foreground";
  }
}

function EnvironmentUpdateRow({
  group,
  status,
  onUpdate,
}: {
  readonly group: LocalEnvironmentUpdateGroup;
  readonly status: RowStatus;
  readonly onUpdate: () => void;
}) {
  let trailing: ReactNode;
  switch (status.kind) {
    case "loading":
      trailing = <Spinner className="size-4 text-muted-foreground" />;
      break;
    case "success":
      trailing = <CheckIcon aria-hidden="true" className="size-4 text-success" />;
      break;
    case "failed":
    case "unchanged":
      trailing = (
        <Button size="xs" variant="outline" onClick={onUpdate}>
          Retry
        </Button>
      );
      break;
    default:
      trailing = (
        <Button size="xs" onClick={onUpdate}>
          Update
        </Button>
      );
      break;
  }

  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">{group.label}</span>
        <span className={cn("truncate text-xs", rowToneClass(status.kind))}>{status.text}</span>
      </div>
      <div className="shrink-0">{trailing}</div>
    </div>
  );
}

/**
 * The launch popover's body when WSL is present: one row per local environment
 * (Windows + WSL), each with its own "update all" trigger that targets only
 * that environment's backend.
 */
export function ProviderUpdateEnvironmentRows() {
  const { groups } = useLocalEnvironmentUpdateGroups();
  const groupByEnvironment = useMemo(
    () => new Map(groups.map((group) => [group.environmentId, group] as const)),
    [groups],
  );

  // Only surface results that land after this popover opened.
  const visibleAfterIsoRef = useRef<string>(new Date().toISOString());

  const [pendingEnvironments, setPendingEnvironments] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(),
  );
  const [errorByEnvironment, setErrorByEnvironment] = useState<ReadonlyMap<EnvironmentId, string>>(
    () => new Map(),
  );
  const [resultByEnvironment, setResultByEnvironment] = useState<
    ReadonlyMap<EnvironmentId, ProviderUpdateToastView>
  >(() => new Map());

  const clearPending = useCallback((environmentId: EnvironmentId) => {
    setPendingEnvironments((previous) => {
      if (!previous.has(environmentId)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(environmentId);
      return next;
    });
  }, []);

  const handleUpdate = useCallback(
    async (environmentId: EnvironmentId) => {
      const group = groupByEnvironment.get(environmentId);
      if (!group || group.candidates.length === 0) {
        return;
      }
      const providerCount = group.candidates.length;
      const targets = group.candidates.map((candidate) => ({
        driver: candidate.driver,
        instanceId: candidate.instanceId,
      }));

      setPendingEnvironments((previous) => new Set(previous).add(environmentId));
      setErrorByEnvironment((previous) => {
        if (!previous.has(environmentId)) {
          return previous;
        }
        const next = new Map(previous);
        next.delete(environmentId);
        return next;
      });
      setResultByEnvironment((previous) => {
        if (!previous.has(environmentId)) {
          return previous;
        }
        const next = new Map(previous);
        next.delete(environmentId);
        return next;
      });

      const expiry = setTimeout(() => clearPending(environmentId), PENDING_EXPIRY_MS);
      try {
        const results = await Promise.allSettled(
          updateProvidersInEnvironment(environmentId, targets),
        );
        if (results.length === 0) {
          setErrorByEnvironment((previous) =>
            new Map(previous).set(
              environmentId,
              "This environment isn’t connected — try again once it reconnects.",
            ),
          );
          return;
        }
        const rejectedMessage = firstRejectedProviderUpdateMessage(results);
        if (rejectedMessage) {
          setErrorByEnvironment((previous) =>
            new Map(previous).set(environmentId, rejectedMessage),
          );
          return;
        }
        const view = getProviderUpdateProgressToastView({
          providers: collectProviderUpdateOutcomeSnapshots(results),
          providerCount,
        });
        setResultByEnvironment((previous) => new Map(previous).set(environmentId, view));
      } catch (error) {
        setErrorByEnvironment((previous) =>
          new Map(previous).set(
            environmentId,
            error instanceof Error ? error.message : "Provider update failed.",
          ),
        );
      } finally {
        clearTimeout(expiry);
        clearPending(environmentId);
      }
    },
    [clearPending, groupByEnvironment],
  );

  const rows = groups
    .map((group) => ({
      group,
      status: resolveRowStatus({
        group,
        error: errorByEnvironment.get(group.environmentId),
        result: resultByEnvironment.get(group.environmentId),
        pill: getProviderUpdateSidebarPillView(group.providers, {
          visibleAfterIso: visibleAfterIsoRef.current,
        }),
        isPending: pendingEnvironments.has(group.environmentId),
      }),
    }))
    .filter(({ group, status }) => group.candidates.length > 0 || status.kind !== "idle");

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="mt-0.5 flex flex-col gap-1">
      {rows.map(({ group, status }) => (
        <EnvironmentUpdateRow
          key={group.environmentId}
          group={group}
          status={status}
          onUpdate={() => handleUpdate(group.environmentId)}
        />
      ))}
    </div>
  );
}
