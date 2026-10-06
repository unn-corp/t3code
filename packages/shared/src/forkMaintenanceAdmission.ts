import type { ForkActivityBlocker } from "@t3tools/contracts";

export const AGENT_IDLE_WINDOW_MS = 5 * 60 * 1000;
export const PARTICIPANT_MAX_AGE_MS = 30_000;

export type MaintenanceParticipantKind =
  | "desktop"
  | "service"
  | "standalone"
  | "development"
  | "wsl";

/** A process this participant started (terminal, provider, background command). Survives its parent's exit until verified gone. */
export interface MaintenanceDescendant {
  readonly pid: number;
  readonly started: string;
  readonly label: string;
}

export interface MaintenanceParticipant {
  readonly id: string;
  readonly label: string;
  readonly kind: MaintenanceParticipantKind;
  /** Process whose identity proves liveness. A control-channel child shares its parent's owner. */
  readonly owner: { readonly pid: number; readonly started: string };
  /** Data homes this participant writes. Distinct from the participant itself. */
  readonly homes: ReadonlyArray<string>;
  /** Only desktop and background-service runtimes are binary update targets. */
  readonly updateTarget: boolean;
  /** Explicit control-channel parent (a Windows desktop for its WSL runtimes). Never inferred from addresses. */
  readonly parentId: string | null;
  readonly observedAt: number;
  readonly idleSince: number | null;
  readonly frozenFor: string | null;
  readonly trialFor: string | null;
  readonly descendants: ReadonlyArray<MaintenanceDescendant>;
  /** The owner exited but descendants still run, so the registration is kept as a blocking tombstone. */
  readonly orphaned: boolean;
  readonly blockers: ReadonlyArray<ForkActivityBlocker>;
}

/** Process ownership is verified separately; a stale heartbeat is never proof of exit. */
export function participantBlockers(
  participants: ReadonlyArray<MaintenanceParticipant>,
  now: number,
  transactionId?: string,
): ReadonlyArray<ForkActivityBlocker> {
  if (participants.length === 0) {
    return [
      {
        participantId: "coordinator",
        reason: "bootstrap",
        label: "Register fork runtimes before installation.",
      },
    ];
  }
  return participants.flatMap((participant) => {
    if (participant.orphaned) {
      return [
        {
          participantId: participant.id,
          reason: "commands" as const,
          label: `${participant.descendants.length === 1 ? "A process" : `${participant.descendants.length} processes`} started by ${participant.label} ${participant.descendants.length === 1 ? "is" : "are"} still running after it exited.`,
        },
      ];
    }
    const blocker = (
      reason: ForkActivityBlocker["reason"],
      label: string,
    ): ForkActivityBlocker => ({
      participantId: participant.id,
      reason,
      label,
    });
    // A runtime launched by the transaction itself is verified by receipts, not by idleness.
    if (transactionId !== undefined && participant.trialFor === transactionId) return [];
    if (participant.observedAt > now || now - participant.observedAt > PARTICIPANT_MAX_AGE_MS) {
      return [
        blocker("unknown-participant", `${participant.label} has not reported fresh activity.`),
      ];
    }
    if (participant.blockers.length > 0) return [...participant.blockers];
    if (participant.idleSince === null || now - participant.idleSince < AGENT_IDLE_WINDOW_MS) {
      return [blocker("idle-window", `${participant.label} must remain stopped for five minutes.`)];
    }
    if (transactionId !== undefined && participant.frozenFor !== transactionId) {
      return [
        blocker(
          "unknown-participant",
          `${participant.label} has not acknowledged the launch fence.`,
        ),
      ];
    }
    return [];
  });
}

export interface FilesystemCapacity {
  readonly filesystem: string;
  readonly requiredAdditionalBytes: number;
  readonly availableBytes: number;
}

export function capacityShortfalls(
  filesystems: ReadonlyArray<FilesystemCapacity>,
): ReadonlyArray<string> {
  return filesystems
    .filter((entry) => {
      if (
        ![entry.requiredAdditionalBytes, entry.availableBytes].every(
          (value) => Number.isFinite(value) && value >= 0,
        )
      )
        return true;
      const margin = Math.max(Math.ceil(entry.requiredAdditionalBytes * 0.1), 1024 ** 3);
      return entry.availableBytes < entry.requiredAdditionalBytes + margin;
    })
    .map((entry) => entry.filesystem);
}
