// @effect-diagnostics nodeBuiltinImport:off processEnv:off globalFetch:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type {
  ForkMaintenanceActionInput,
  ForkRecoveryRequest,
  ForkUpdatePolicyPatch,
  ForkUpdateStatus,
} from "@t3tools/contracts";
import { isProcessAlive } from "../serverRuntimeState.ts";
import { OPERATOR_ROUTE_PREFIX, OPERATOR_TOKEN_HEADER, readOperatorToken } from "./operatorAuth.ts";

export interface OperatorTarget {
  readonly origin: string;
  readonly token: string;
}
export type OperatorResult =
  | { readonly ok: true; readonly status: ForkUpdateStatus }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly blockers?: ReadonlyArray<{ readonly label: string }>;
    };

/** The running server for a T3 home, found the way `t3 pair` does: its runtime state file and a live PID. */
export async function discoverOperatorTarget(baseDir: string): Promise<OperatorTarget> {
  const token = await readOperatorToken(baseDir);
  if (token === null)
    throw new Error(
      "No running T3 Code server with device maintenance was found for this home (no operator credential).",
    );
  for (const variant of ["userdata", "dev"]) {
    try {
      const state = JSON.parse(
        await NodeFSP.readFile(NodePath.join(baseDir, variant, "server-runtime.json"), "utf8"),
      ) as { pid?: unknown; origin?: unknown };
      if (
        typeof state.pid === "number" &&
        typeof state.origin === "string" &&
        isProcessAlive(state.pid)
      )
        return { origin: state.origin, token };
    } catch {
      // try the next variant
    }
  }
  throw new Error("The T3 Code server for this home is not running.");
}

/** One call to the one controller. Never throws for a refusal: the reason is the controller's own. */
export async function callOperator(
  target: OperatorTarget,
  operation: "status" | "policy" | "action" | "recover",
  body:
    | ForkUpdatePolicyPatch
    | ForkMaintenanceActionInput
    | ForkRecoveryRequest
    | Record<string, never>,
  fetchImpl: typeof fetch = fetch,
): Promise<OperatorResult> {
  const response = await fetchImpl(`${target.origin}${OPERATOR_ROUTE_PREFIX}${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json", [OPERATOR_TOKEN_HEADER]: target.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { reason?: string; blockers?: ReadonlyArray<{ label: string }> };
  } & Partial<ForkUpdateStatus>;
  if (!response.ok)
    return {
      ok: false,
      reason: payload.error?.reason ?? `The server answered ${response.status}.`,
      ...(payload.error?.blockers === undefined ? {} : { blockers: payload.error.blockers }),
    };
  return { ok: true, status: payload as ForkUpdateStatus };
}

export function describeStatus(status: ForkUpdateStatus): ReadonlyArray<string> {
  const lines = [
    `Build ${status.currentBuild.version} (${status.currentBuild.channel}); channel ${status.policy.channel}; automatic installation ${status.policy.automaticInstallation ? "on" : "off"}${status.policy.pinnedBuild === null ? "" : "; pinned"}`,
    `State: ${status.phase}${status.targetBuild === null ? "" : `; target ${status.targetBuild.version} (${status.targetBuild.artifactSha256})`}`,
  ];
  if (status.affectedHomes !== undefined && status.affectedHomes.length > 0)
    lines.push(`Replaces: ${status.affectedHomes.map((home) => home.label).join(", ")}`);
  if (status.countdown !== null && status.countdown !== undefined)
    lines.push(
      `Installing automatically in ${Math.max(0, Math.ceil((status.countdown.installsAt - Date.now()) / 1000))}s (cancel with \`t3 maintenance cancel-countdown\`)`,
    );
  for (const blocker of status.blockers) lines.push(`Waiting: ${blocker.label}`);
  if (status.lastError !== null && status.lastError !== undefined)
    lines.push(`Last error: ${status.lastError}`);
  if (status.automationReviewRequired)
    lines.push(
      "Restored schedules and queues are held. Review them, then run `t3 maintenance acknowledge-review`.",
    );
  for (const option of status.recoveryOptions)
    lines.push(
      `Recovery: ${option.id} -> ${option.build.version}, homes ${option.homes.map((home) => `${home.label}@${home.restoreTimestamp}`).join(", ")}`,
    );
  return lines;
}
