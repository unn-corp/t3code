// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - release tooling spawns validation commands synchronously.
// Runs the package-level validation command and records its receipt. The command itself is
// defined in code (PACKAGE_VALIDATION in fork-release-suites.ts); a receipt for any other command
// is ignored when checks are evaluated, so this cannot be reconfigured into a pass.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import {
  type CheckReceipt,
  type ValidationCheck,
  type ValidationTarget,
} from "./fork-release-assets.ts";
import type { ForkChannel } from "./fork-release-policy.ts";

export interface ConfiguredCommand {
  /** argv without a shell, run from the repository root. */
  readonly run: ReadonlyArray<string>;
  readonly timeoutMinutes: number;
}

export const runCommand = (
  command: ConfiguredCommand,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): { readonly exitCode: number } => {
  const [program, ...args] = command.run;
  const result = NodeChildProcess.spawnSync(program!, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    timeout: command.timeoutMinutes * 60_000,
    shell: false,
  });
  // A spawn failure or a timeout has no exit status; both must read as failure.
  return { exitCode: result.status ?? -1 };
};

export interface ValidationContext {
  readonly check: ValidationCheck;
  readonly target: ValidationTarget;
  readonly version: string;
  readonly commit: string;
  readonly channel: ForkChannel;
  readonly candidateDir: string;
  readonly candidateDigest: string;
  readonly predecessorDir: string | null;
  readonly predecessorDigest: string | null;
  readonly repoRoot: string;
  readonly runner: string;
  readonly runUrl: string;
  readonly namespace: string;
}

/**
 * Runs one validation and returns its receipt. A null command, or an update/recovery check without
 * a predecessor, yields a failing receipt rather than a skipped one.
 */
export const runValidation = (
  command: ConfiguredCommand | null,
  context: ValidationContext,
): CheckReceipt => {
  const startedAt = new Date().toISOString();
  let exitCode = -1;
  const needsPredecessor = context.check !== "install";
  if (command === null) {
    console.error(
      `No ${context.check} validation is available for ${context.target}; failing closed.`,
    );
  } else if (
    needsPredecessor &&
    (context.predecessorDir === null || context.predecessorDigest === null)
  ) {
    console.error(`The ${context.check} validation needs a predecessor release; failing closed.`);
  } else {
    exitCode = runCommand(command, context.repoRoot, {
      FORK_RELEASE_CHECK: context.check,
      FORK_RELEASE_TARGET: context.target,
      FORK_RELEASE_VERSION: context.version,
      FORK_RELEASE_COMMIT: context.commit,
      FORK_RELEASE_CHANNEL: context.channel,
      FORK_RELEASE_CANDIDATE_DIR: NodePath.resolve(context.candidateDir),
      FORK_RELEASE_PREDECESSOR_DIR: context.predecessorDir
        ? NodePath.resolve(context.predecessorDir)
        : "",
      T3CODE_MAINTENANCE_NAMESPACE: context.namespace,
    }).exitCode;
  }
  return {
    format: 1,
    check: context.check,
    target: context.target,
    version: context.version,
    commit: context.commit,
    channel: context.channel,
    candidateDigest: context.candidateDigest,
    predecessorDigest: context.predecessorDigest,
    command: command ? [...command.run] : null,
    exitCode,
    passed: exitCode === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    runner: context.runner,
    runUrl: context.runUrl,
  };
};
