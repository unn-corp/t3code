// @effect-diagnostics preferSchemaOverJson:off - Snapshots internal policy/model objects before asynchronous boundaries.
import * as NodeCrypto from "node:crypto";
import type { ModelSelection, OrganizationWorkId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  OrganizationPatchProposalInput,
  OrganizationPatchProposalOutput,
  type OrganizationPatchProposalOutput as PatchOutput,
} from "../../../../packages/contracts/src/organizationPatchProposal.ts";
import { generateOrganizationPatchProposal } from "../textGeneration/TextGeneration.ts";
import { buildOrganizationPatchArtifact } from "./OrganizationPatchArtifactBuilder.ts";
import {
  OrganizationPatchSourceReader,
  type OrganizationPatchSource,
} from "./OrganizationPatchSourceReader.ts";
import {
  OrganizationWorkLaunchPlanner,
  type OrganizationWorkLaunchPlan,
} from "./OrganizationWorkLaunchPlanner.ts";
import { OrganizationWorkStore } from "./OrganizationWorkStore.ts";

export class OrganizationSingleFileProposalCoordinatorError extends Schema.TaggedError<OrganizationSingleFileProposalCoordinatorError>()(
  "OrganizationSingleFileProposalCoordinatorError",
  {
    code: Schema.Literals(["invalid", "forbidden", "conflict", "unavailable"]),
    message: Schema.String,
  },
) {}
const failure = (code: OrganizationSingleFileProposalCoordinatorError["code"], message: string) =>
  new OrganizationSingleFileProposalCoordinatorError({ code, message });
const FLAT_MJS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mjs$/;
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const decodeGenerationInput = Schema.decodeUnknownEffect(OrganizationPatchProposalInput);
const decodeProposal = Schema.decodeUnknownEffect(OrganizationPatchProposalOutput);

export interface OrganizationSingleFileProposalPolicyTarget {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly workId: string;
  readonly findingId: string;
  readonly findingTitle: string;
  readonly findingSummary: string;
  readonly baseCommit: string;
}
export interface OrganizationSingleFileProposalSelection {
  readonly fileName: string;
  readonly taskText: string;
  readonly modelSelection: ModelSelection;
}
/** A server policy selects task and file from scoped saved evidence; clients cannot. */
export class OrganizationSingleFileProposalPolicy extends Context.Service<
  OrganizationSingleFileProposalPolicy,
  {
    readonly select: (
      target: OrganizationSingleFileProposalPolicyTarget,
    ) => Effect.Effect<
      OrganizationSingleFileProposalSelection,
      OrganizationSingleFileProposalCoordinatorError
    >;
  }
>()(
  "t3/organizations/OrganizationSingleFileProposalCoordinator/OrganizationSingleFileProposalPolicy",
) {}
export const OrganizationSingleFileProposalPolicyDisabled = Layer.succeed(
  OrganizationSingleFileProposalPolicy,
  { select: () => Effect.fail(failure("forbidden", "Single-file proposal policy is disabled.")) },
);

export interface OrganizationSingleFileProposalResult {
  readonly plan: OrganizationWorkLaunchPlan;
  readonly source: OrganizationPatchSource;
  readonly proposal: PatchOutput;
  readonly artifactBytes: Uint8Array;
  readonly artifactSha256: string;
}

type FindingRow = {
  finding_id: string;
  organization_id: string;
  project_id: string | null;
  title: string;
  summary: string;
  state: string;
};

const samePlan = (a: OrganizationWorkLaunchPlan, b: OrganizationWorkLaunchPlan): boolean =>
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
const sameSource = (a: OrganizationPatchSource, b: OrganizationPatchSource): boolean =>
  a.relativePath === b.relativePath &&
  a.baseCommit === b.baseCommit &&
  a.blobOid === b.blobOid &&
  a.baseMode === b.baseMode &&
  a.sha256 === b.sha256 &&
  a.byteLength === b.byteLength &&
  a.content === b.content;

/** Read-only, disconnected proposal bridge. Never claims an attempt or writes Git objects. */
export const proposeOrganizationSingleFileArtifact = (workId: OrganizationWorkId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workStore = yield* OrganizationWorkStore;
    const planner = yield* OrganizationWorkLaunchPlanner;
    const sourceReader = yield* OrganizationPatchSourceReader;
    const policy = yield* OrganizationSingleFileProposalPolicy;
    const before = yield* planner.plan(workId);
    const detail = yield* workStore.getWork(workId);
    const work = detail.work;
    if (work.status !== "pending" && work.status !== "retrying")
      return yield* failure("conflict", "Work is not ready for a read-only proposal.");
    const finding = (yield* sql<FindingRow>`SELECT f.finding_id, f.organization_id, f.project_id,
        f.title, f.summary, f.state FROM organization_intake_findings f
        JOIN organization_intake_sources s ON s.source_id = f.source_id
          AND s.organization_id = f.organization_id AND s.project_id = ${work.projectId}
          AND s.enabled = 1
        WHERE f.finding_id = ${work.findingId} AND f.organization_id = ${work.organizationId}`)[0];
    if (!finding || finding.state !== "tentative" || finding.project_id !== work.projectId)
      return yield* failure("forbidden", "Finding is not current scoped Project evidence.");
    const target: OrganizationSingleFileProposalPolicyTarget = {
      organizationId: work.organizationId,
      projectId: work.projectId,
      bindingId: work.bindingId,
      workId: work.id,
      findingId: work.findingId,
      findingTitle: finding.title,
      findingSummary: finding.summary,
      baseCommit: before.baseCommit,
    };
    const selected = yield* policy.select(target);
    let selection: OrganizationSingleFileProposalSelection;
    try {
      const serialized = JSON.stringify(selected);
      if (Buffer.byteLength(serialized, "utf8") > 8_192)
        return yield* failure("invalid", "Policy selection exceeds its limit.");
      selection = JSON.parse(serialized);
    } catch {
      return yield* failure("invalid", "Policy selection is not plain JSON.");
    }
    if (
      !selection ||
      typeof selection.fileName !== "string" ||
      !FLAT_MJS.test(selection.fileName) ||
      typeof selection.taskText !== "string" ||
      !selection.taskText.trim() ||
      Buffer.byteLength(selection.taskText, "utf8") > 4_000
    )
      return yield* failure("invalid", "Policy must select one flat .mjs file and bounded task.");
    const source = yield* sourceReader.read(before, selection.fileName);
    const generationInput = yield* decodeGenerationInput({
      modelSelection: selection.modelSelection,
      taskText: selection.taskText,
      fileName: selection.fileName,
      currentContent: source.content,
      baseDigest: source.sha256,
    }).pipe(Effect.mapError(() => failure("invalid", "Patch generation input is invalid.")));
    const rawProposal = yield* generateOrganizationPatchProposal(generationInput);
    let proposalSnapshot: unknown;
    try {
      const serialized = JSON.stringify(rawProposal);
      if (Buffer.byteLength(serialized, "utf8") > 70_000)
        return yield* failure("invalid", "Patch proposal exceeds its limit.");
      proposalSnapshot = JSON.parse(serialized);
    } catch {
      return yield* failure("invalid", "Patch proposal is not plain JSON.");
    }
    const proposal = yield* decodeProposal(proposalSnapshot).pipe(
      Effect.mapError(() => failure("invalid", "Patch proposal has invalid fields.")),
    );
    let artifactBytes: Uint8Array;
    try {
      artifactBytes = buildOrganizationPatchArtifact(source, proposal);
    } catch {
      return yield* failure("conflict", "Patch proposal does not match pinned source.");
    }
    const after = yield* planner.plan(workId);
    if (!samePlan(before, after))
      return yield* failure(
        "conflict",
        "Work or current Project authority changed during proposal.",
      );
    const sourceAfter = yield* sourceReader.read(after, selection.fileName);
    if (!sameSource(source, sourceAfter))
      return yield* failure("conflict", "Pinned source changed during proposal generation.");
    const findingAfter = (yield* sql<FindingRow>`SELECT f.finding_id, f.organization_id,
        f.project_id, f.title, f.summary, f.state FROM organization_intake_findings f
        JOIN organization_intake_sources s ON s.source_id = f.source_id
          AND s.organization_id = f.organization_id AND s.project_id = ${work.projectId}
          AND s.enabled = 1
        WHERE f.finding_id = ${work.findingId} AND f.organization_id = ${work.organizationId}`)[0];
    if (
      !findingAfter ||
      findingAfter.state !== finding.state ||
      findingAfter.project_id !== finding.project_id ||
      findingAfter.title !== finding.title ||
      findingAfter.summary !== finding.summary
    )
      return yield* failure("conflict", "Scoped finding changed during proposal.");
    return {
      plan: after,
      source,
      proposal,
      artifactBytes: Uint8Array.from(artifactBytes),
      artifactSha256: sha256(artifactBytes),
    } satisfies OrganizationSingleFileProposalResult;
  });
