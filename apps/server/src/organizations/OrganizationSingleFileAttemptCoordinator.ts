// @effect-diagnostics preferSchemaOverJson:off - Versioned syntax evidence is bounded JSON without source text.
import * as NodeCrypto from "node:crypto";
import { OrganizationWorkAttemptId } from "../../../../packages/contracts/src/organizationWork.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { buildOrganizationPatchArtifact } from "./OrganizationPatchArtifactBuilder.ts";
import { OrganizationPatchSourceReader } from "./OrganizationPatchSourceReader.ts";
import {
  allocateOrganizationScopedUnitName,
  prepareOrganizationScopedSandbox,
} from "./OrganizationScopedSandboxHost.ts";
import { decodeOrganizationSingleFileArtifact } from "./OrganizationSingleFileArtifact.ts";
import type { OrganizationSingleFileProposalResult } from "./OrganizationSingleFileProposalCoordinator.ts";
import { OrganizationWorkArtifactStore } from "./OrganizationWorkArtifactStore.ts";
import {
  OrganizationWorkLaunchPlanner,
  type OrganizationWorkLaunchPlan,
} from "./OrganizationWorkLaunchPlanner.ts";
import {
  OrganizationScopeTokenReleased,
  OrganizationWorkScopeError,
  OrganizationWorkScopeStore,
  OrganizationWorkScopeStopVerifier,
  type OrganizationWorkScopeIdentity,
} from "./OrganizationWorkScopeStore.ts";
import { OrganizationWorkStore, type OrganizationWorkPrincipal } from "./OrganizationWorkStore.ts";

export class OrganizationSingleFileAttemptError extends Schema.TaggedError<OrganizationSingleFileAttemptError>()(
  "OrganizationSingleFileAttemptError",
  {
    code: Schema.Literals(["invalid", "forbidden", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationSingleFileAttemptError["code"], message: string) =>
  new OrganizationSingleFileAttemptError({ code, message });
const digest = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const FLAT_MJS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mjs$/;

export interface OrganizationSingleFileAttemptSelection {
  readonly attemptId: OrganizationWorkAttemptId;
  readonly workerSubject: string;
}
export interface OrganizationSingleFileAttemptTarget {
  readonly workId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly artifactSha256: string;
}
/** A reviewed, server-owned worker policy must select the worker. Live is deny-all. */
export class OrganizationSingleFileAttemptPolicy extends Context.Service<
  OrganizationSingleFileAttemptPolicy,
  {
    readonly select: (
      target: OrganizationSingleFileAttemptTarget,
    ) => Effect.Effect<OrganizationSingleFileAttemptSelection, OrganizationSingleFileAttemptError>;
  }
>()(
  "t3/organizations/OrganizationSingleFileAttemptCoordinator/OrganizationSingleFileAttemptPolicy",
) {}
export const OrganizationSingleFileAttemptPolicyDisabled = Layer.succeed(
  OrganizationSingleFileAttemptPolicy,
  { select: () => Effect.fail(failure("forbidden", "Single-file worker policy is disabled.")) },
);

/** An injected host owns both the real scoped handle and its exact OS stop check. */
export interface OrganizationSingleFileAttemptHostShape {
  readonly reserve: (attemptId: string, unitName: string) => Promise<void>;
  readonly prepare: (
    input: Parameters<typeof prepareOrganizationScopedSandbox>[0] & { readonly attemptId: string },
  ) => ReturnType<typeof prepareOrganizationScopedSandbox>;
  readonly verifyStopped: (
    identity: OrganizationWorkScopeIdentity,
  ) => Effect.Effect<void, OrganizationSingleFileAttemptError>;
}
export class OrganizationSingleFileAttemptHost extends Context.Service<
  OrganizationSingleFileAttemptHost,
  OrganizationSingleFileAttemptHostShape
>()(
  "t3/organizations/OrganizationSingleFileAttemptCoordinator/OrganizationSingleFileAttemptHost",
) {}
/** The standalone default denies both preparation and persisted stop verification. */
export const OrganizationSingleFileAttemptHostDisabled = Layer.succeed(
  OrganizationSingleFileAttemptHost,
  {
    reserve: () => Promise.reject(failure("unavailable", "Scoped attempt host is disabled.")),
    prepare: () => Promise.reject(failure("unavailable", "Scoped attempt host is disabled.")),
    verifyStopped: () => Effect.fail(failure("unavailable", "OS stop verifier is disabled.")),
  },
);
/** A reviewed host can be supplied to ScopeStore without accepting a caller receipt. */
export const OrganizationSingleFileAttemptScopeVerifierFromHost = Layer.effect(
  OrganizationWorkScopeStopVerifier,
  Effect.gen(function* () {
    const host = yield* OrganizationSingleFileAttemptHost;
    return {
      verifyStopped: (identity: OrganizationWorkScopeIdentity) =>
        host.verifyStopped(identity).pipe(
          Effect.mapError(
            (error) =>
              new OrganizationWorkScopeError({
                code: error.code === "unavailable" ? "unavailable" : "conflict",
                message: error.message,
              }),
          ),
        ),
    };
  }),
);

export interface OrganizationSingleFileAttemptResult {
  readonly status: "submitted" | "canceled";
  readonly attemptId: OrganizationWorkAttemptId;
  readonly artifactDigest: string | null;
  readonly artifactRef: string | null;
  /** Syntax-check evidence only. This does not certify behavior or independent QA. */
  readonly syntaxEvidenceBytes: Uint8Array;
}

const samePlan = (a: OrganizationWorkLaunchPlan, b: OrganizationWorkLaunchPlan) =>
  a.workId === b.workId &&
  a.organizationId === b.organizationId &&
  a.projectId === b.projectId &&
  a.bindingId === b.bindingId &&
  a.bindingVersion === b.bindingVersion &&
  a.scope === b.scope &&
  a.publishedRevision === b.publishedRevision &&
  a.workflowId === b.workflowId &&
  a.workflowVersion === b.workflowVersion &&
  a.baseCommit === b.baseCommit &&
  a.projectRoot === b.projectRoot &&
  a.nextAttemptNumber === b.nextAttemptNumber;

function snapshot(raw: OrganizationSingleFileProposalResult): OrganizationSingleFileProposalResult {
  if (!raw || typeof raw !== "object" || !(raw.artifactBytes instanceof Uint8Array))
    throw failure("invalid", "Canonical proposal result is missing.");
  const bytes = Uint8Array.from(raw.artifactBytes);
  if (bytes.byteLength > 128 * 1024 || digest(bytes) !== raw.artifactSha256)
    throw failure("invalid", "Canonical proposal digest does not match its bytes.");
  const artifact = decodeOrganizationSingleFileArtifact(bytes);
  if (!FLAT_MJS.test(artifact.relativePath))
    throw failure("invalid", "Syntax check requires one flat .mjs file.");
  const json = JSON.stringify({ plan: raw.plan, source: raw.source, proposal: raw.proposal });
  if (Buffer.byteLength(json, "utf8") > 140_000)
    throw failure("invalid", "Canonical proposal metadata exceeds its limit.");
  const fields = JSON.parse(json) as Pick<
    OrganizationSingleFileProposalResult,
    "plan" | "source" | "proposal"
  >;
  if (
    fields.plan.baseCommit !== artifact.baseCommit ||
    fields.source.relativePath !== artifact.relativePath ||
    fields.source.baseCommit !== artifact.baseCommit ||
    fields.source.blobOid !== artifact.baseBlobOid ||
    fields.source.baseMode !== artifact.baseMode ||
    fields.source.sha256 !== artifact.baseSha256 ||
    fields.proposal.fileName !== artifact.relativePath ||
    fields.proposal.baseDigest !== artifact.baseSha256 ||
    !Buffer.from(fields.proposal.replacementContent, "utf8").equals(
      Buffer.from(artifact.replacementBytes),
    )
  )
    throw failure("invalid", "Proposal result does not match canonical artifact fields.");
  return { ...fields, artifactBytes: bytes, artifactSha256: digest(bytes) };
}

/** Disconnected worker bridge. All mutation authorities and the OS stop verifier remain injected. */
export const runOrganizationSingleFileAttempt = (raw: OrganizationSingleFileProposalResult) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const proposal = yield* Effect.try({
        try: () => snapshot(raw),
        catch: () => failure("invalid", "Canonical proposal result is invalid."),
      });
      const planner = yield* OrganizationWorkLaunchPlanner;
      const reader = yield* OrganizationPatchSourceReader;
      const policy = yield* OrganizationSingleFileAttemptPolicy;
      const host = yield* OrganizationSingleFileAttemptHost;
      const workStore = yield* OrganizationWorkStore;
      const scopeStore = yield* OrganizationWorkScopeStore;
      const artifactStore = yield* OrganizationWorkArtifactStore;

      const current = yield* planner.plan(proposal.plan.workId);
      if (!samePlan(current, proposal.plan))
        return yield* failure("conflict", "Work plan or Project authority changed after proposal.");
      const source = yield* reader.read(current, proposal.source.relativePath);
      if (
        source.relativePath !== proposal.source.relativePath ||
        source.baseCommit !== proposal.source.baseCommit ||
        source.blobOid !== proposal.source.blobOid ||
        source.baseMode !== proposal.source.baseMode ||
        source.sha256 !== proposal.source.sha256 ||
        source.byteLength !== proposal.source.byteLength ||
        source.content !== proposal.source.content
      )
        return yield* failure("conflict", "Pinned source changed after proposal.");
      const rebuilt = yield* Effect.try({
        try: () => buildOrganizationPatchArtifact(source, proposal.proposal),
        catch: () => failure("invalid", "Proposal cannot be rebuilt from current source."),
      });
      if (!Buffer.from(rebuilt).equals(Buffer.from(proposal.artifactBytes)))
        return yield* failure("conflict", "Canonical artifact changed after proposal.");
      const selected = yield* policy.select({
        workId: current.workId,
        organizationId: current.organizationId,
        projectId: current.projectId,
        bindingId: current.bindingId,
        artifactSha256: proposal.artifactSha256,
      });
      const attemptId = selected.attemptId;
      const principal: OrganizationWorkPrincipal = { subject: selected.workerSubject };
      if (
        typeof attemptId !== "string" ||
        !attemptId.trim() ||
        attemptId.length > 160 ||
        typeof principal.subject !== "string" ||
        !principal.subject.trim() ||
        principal.subject.length > 160
      )
        return yield* failure("invalid", "Worker policy returned invalid identity.");

      const artifact = decodeOrganizationSingleFileArtifact(proposal.artifactBytes);
      // Reserve durable capacity before creating even a trusted gated scope.
      // If preparation rejects without returning an identity, no OS stop can be
      // proven here: leave this running attempt and permit for recovery.
      yield* workStore.claimAttempt(
        {
          workId: current.workId,
          attemptId,
          leaseSeconds: 120,
          // A fresh invocation must never treat an earlier claim's idempotent
          // transition replay as ownership of that attempt or its live scope.
          transitionId: `org-attempt-claim:${NodeCrypto.randomUUID()}`,
        },
        principal,
      );
      const reservedUnitName = allocateOrganizationScopedUnitName();
      yield* scopeStore.markPreparing(attemptId, reservedUnitName);
      yield* Effect.tryPromise({
        try: () => host.reserve(attemptId, reservedUnitName),
        catch: () =>
          failure(
            "unavailable",
            `Scoped reservation failed; attempt ${attemptId} retains its resource permit for recovery.`,
          ),
      });
      // A replay may inspect the marker but must never cause a second OS launch.
      yield* scopeStore.markLaunchRequested(attemptId, reservedUnitName, { requireFresh: true });
      const handle = yield* Effect.tryPromise({
        try: () =>
          host.prepare({
            attemptId,
            reservedUnitName,
            argv: ["/usr/bin/node", "--check", "/workspace/replacement.mjs"],
            files: { "replacement.mjs": artifact.replacementBytes },
            runtimeMs: 10_000,
            maxOutputBytes: 16_384,
            workspaceBytes: 4 * 1024 * 1024,
          }),
        catch: () =>
          failure(
            "unavailable",
            `Scoped preparation failed; attempt ${attemptId} retains its resource permit for recovery.`,
          ),
      });
      let attached = false;
      let verifiedStopped = false;
      const identity = {
        unitName: handle.unitName,
        invocationId: handle.invocationId,
        controlGroup: handle.controlGroup,
        sandboxPid: handle.sandboxPid,
        pidNamespace: handle.pidNamespace,
      };
      const syntaxEvidence = (result: {
        exitCode: number | null;
        signal: string | null;
        timedOut: boolean;
        outputLimitExceeded: boolean;
      }) =>
        Buffer.from(
          JSON.stringify({
            version: 1,
            kind: "node-check-syntax-only",
            artifactSha256: proposal.artifactSha256,
            unitName: identity.unitName,
            invocationId: identity.invocationId,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            outputLimitExceeded: result.outputLimitExceeded,
          }),
          "utf8",
        );
      const stopHost = () =>
        Effect.tryPromise({
          try: () => handle.stop(),
          catch: () => failure("unavailable", "Scoped host stop could not be verified."),
        });
      const main = Effect.gen(function* () {
        if (identity.unitName !== reservedUnitName)
          return yield* failure("conflict", "Host returned a different unit from the reservation.");
        yield* scopeStore.attachPrepared({ attemptId, identity });
        attached = true;
        yield* scopeStore.requestStart(attemptId);
        yield* scopeStore.startWithFence(
          attemptId,
          async (): Promise<typeof OrganizationScopeTokenReleased> => {
            await handle.start();
            return OrganizationScopeTokenReleased;
          },
        );
        yield* scopeStore.recordStarted(attemptId);
        const outcome = yield* Effect.tryPromise({
          try: () => handle.wait(),
          catch: () => failure("unavailable", "Scoped syntax-check exit could not be verified."),
        });
        yield* scopeStore.requestStop(attemptId);
        yield* scopeStore.recordStopped(attemptId);
        verifiedStopped = true;
        const evidence = syntaxEvidence(outcome);
        if (
          outcome.exitCode !== 0 ||
          outcome.signal !== null ||
          outcome.timedOut ||
          outcome.outputLimitExceeded
        ) {
          yield* workStore.cancelWork(
            { workId: current.workId, transitionId: `${attemptId}:syntax-failed` },
            principal,
          );
          return {
            status: "canceled" as const,
            attemptId,
            artifactDigest: null,
            artifactRef: null,
            syntaxEvidenceBytes: evidence,
          };
        }
        const receipt = yield* artifactStore.capture({
          attemptId,
          workId: current.workId,
          projectId: current.projectId,
          baseCodeRevision: current.baseCommit,
          scopeUnitName: identity.unitName,
          scopeInvocationId: identity.invocationId,
          patchBytes: proposal.artifactBytes,
          evidenceBytes: evidence,
          outcome: {
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            timedOut: outcome.timedOut,
            outputLimitExceeded: outcome.outputLimitExceeded,
            resourceLimitExceeded: false,
          },
        });
        yield* workStore.submitAttempt(
          {
            workId: current.workId,
            attemptId,
            transitionId: `${attemptId}:submit`,
            artifactDigest: receipt.artifactDigest,
            artifactRef: receipt.artifactRef,
          },
          principal,
        );
        return {
          status: "submitted" as const,
          attemptId,
          artifactDigest: receipt.artifactDigest,
          artifactRef: receipt.artifactRef,
          syntaxEvidenceBytes: evidence,
        };
      });
      const outcome = yield* Effect.exit(restore(main));
      if (Exit.isSuccess(outcome))
        return outcome.value satisfies OrganizationSingleFileAttemptResult;
      // Cleanup is ordered: fence future start, verify exact OS stop, then and only
      // then release the permit by canceling. Any uncertain stop stays open.
      if (attached) {
        const stop = yield* Effect.exit(scopeStore.requestStop(attemptId));
        const hostStop = yield* Effect.exit(stopHost());
        if (Exit.isSuccess(stop) && Exit.isSuccess(hostStop)) {
          const recorded = yield* Effect.exit(scopeStore.recordStopped(attemptId));
          verifiedStopped = verifiedStopped || Exit.isSuccess(recorded);
        }
      } else {
        const discarded = yield* Effect.exit(
          Effect.tryPromise({
            try: () => handle.discard(),
            catch: () => failure("unavailable", "Prepared host discard could not be verified."),
          }),
        );
        verifiedStopped = Exit.isSuccess(discarded);
      }
      if (verifiedStopped) {
        const saved = yield* Effect.exit(artifactStore.get(attemptId));
        const detail = yield* Effect.exit(workStore.getWork(current.workId));
        if (Exit.isSuccess(saved) && Exit.isSuccess(detail)) {
          const receipt = saved.value;
          const state = detail.value;
          const attempt = state.attempts.find((item) => item.id === attemptId);
          if (receipt) {
            // A capture/submit may have committed before returning an error. Never
            // cancel that receipt or convert uncertain persistence into success.
            if (
              receipt.workId === current.workId &&
              receipt.projectId === current.projectId &&
              receipt.baseCodeRevision === current.baseCommit &&
              receipt.scopeUnitName === identity.unitName &&
              receipt.scopeInvocationId === identity.invocationId &&
              Buffer.from(receipt.patchBytes).equals(Buffer.from(proposal.artifactBytes))
            ) {
              const intact = yield* Effect.exit(
                artifactStore.verifySubmitted({
                  workId: current.workId,
                  attemptId,
                  projectId: current.projectId,
                  baseCodeRevision: current.baseCommit,
                  scopeUnitName: identity.unitName,
                  scopeInvocationId: identity.invocationId,
                  artifactDigest: receipt.artifactDigest,
                  artifactRef: receipt.artifactRef,
                }),
              );
              if (
                Exit.isSuccess(intact) &&
                attempt?.status === "submitted" &&
                state.work.status === "blocked"
              )
                return {
                  status: "submitted" as const,
                  attemptId,
                  artifactDigest: receipt.artifactDigest,
                  artifactRef: receipt.artifactRef,
                  syntaxEvidenceBytes: receipt.evidenceBytes,
                };
              if (
                Exit.isSuccess(intact) &&
                attempt?.status === "running" &&
                state.work.status === "running"
              ) {
                const submitted = yield* Effect.exit(
                  workStore.submitAttempt(
                    {
                      workId: current.workId,
                      attemptId,
                      transitionId: `${attemptId}:submit`,
                      artifactDigest: receipt.artifactDigest,
                      artifactRef: receipt.artifactRef,
                    },
                    principal,
                  ),
                );
                if (Exit.isSuccess(submitted))
                  return {
                    status: "submitted" as const,
                    attemptId,
                    artifactDigest: receipt.artifactDigest,
                    artifactRef: receipt.artifactRef,
                    syntaxEvidenceBytes: receipt.evidenceBytes,
                  };
              }
            }
          } else if (attempt?.status === "running" && state.work.status === "running") {
            yield* Effect.exit(
              workStore.cancelWork(
                { workId: current.workId, transitionId: `${attemptId}:cleanup` },
                principal,
              ),
            );
          }
        }
      }
      return yield* Effect.failCause(outcome.cause);
    }),
  );
