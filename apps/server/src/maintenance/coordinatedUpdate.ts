import type { ForkUpdateStatus } from "@t3tools/contracts";
import { callOperator, discoverOperatorTarget, type OperatorResult } from "./operatorClient.ts";

/** CLI updates use the running home's controller; no independent installer or legacy fallback. */
export async function requestCoordinatedCliUpdate(
  input: {
    readonly baseDir: string;
    readonly channel?: ForkUpdateStatus["policy"]["channel"] | undefined;
    readonly requestedVersion?: string | undefined;
    readonly allowDowngrade?: boolean | undefined;
  },
  ports = { discover: discoverOperatorTarget, call: callOperator },
): Promise<ForkUpdateStatus> {
  if (input.allowDowngrade)
    throw new Error(
      "Reverting requires a recorded option: run `t3 maintenance status`, then `t3 maintenance recover`. No update was requested.",
    );
  const target = await ports.discover(input.baseDir).catch((cause: unknown) => {
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)} Start an updater-equipped runtime or follow the manual stopped-work bootstrap procedure. No legacy installer was run.`,
    );
  });
  const accepted = (result: OperatorResult): ForkUpdateStatus => {
    if (!result.ok)
      throw new Error(
        [result.reason, ...(result.blockers ?? []).map((blocker) => blocker.label)].join(" "),
      );
    return result.status;
  };
  let status = accepted(await ports.call(target, "status", {}));
  if (input.channel !== undefined)
    status = accepted(await ports.call(target, "policy", { channel: input.channel }));
  if (input.requestedVersion === status.currentBuild.version || status.policy.pinnedBuild !== null)
    return status;
  status = accepted(await ports.call(target, "action", { action: "check" }));
  if (
    input.requestedVersion !== undefined &&
    input.requestedVersion !== status.targetBuild?.version
  )
    throw new Error(
      `The requested build ${input.requestedVersion} is not the verified staged target. Review \`t3 maintenance status\`; no other build was installed.`,
    );
  if (status.targetBuild === null || !["staged", "waiting"].includes(status.phase)) return status;
  return accepted(
    await ports.call(target, "action", {
      action: "install",
      targetArtifactSha256: status.targetBuild.artifactSha256,
    }),
  );
}
