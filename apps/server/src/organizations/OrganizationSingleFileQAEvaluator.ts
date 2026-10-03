// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - This disconnected OS boundary validates a fixed JSON probe protocol.
import * as NodeCrypto from "node:crypto";
import {
  decodeOrganizationSingleFileArtifact,
  type OrganizationSingleFileArtifact,
} from "./OrganizationSingleFileArtifact.ts";
import {
  prepareOrganizationScopedSandbox,
  type PreparedOrganizationScopedSandbox,
} from "./OrganizationScopedSandboxHost.ts";
import type { OrganizationGitResultProof } from "./OrganizationGitResultProof.ts";
import type { OrganizationSandboxResult } from "./OrganizationSandboxHost.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const FLAT_MODULE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mjs$/;
const MAX_CASE_BYTES = 4 * 1024;
const MAX_PLAN_BYTES = 24 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const PROTOCOL = /^T3QA1\t([0-7])\t([A-Za-z0-9+/]+={0,2})$/;

/** The plan must be selected by trusted server policy, independently of worker output. */
export interface OrganizationSingleFileQAPlan {
  readonly version: 1;
  readonly exportName: string;
  readonly cases: readonly {
    readonly input: unknown;
    readonly expected: unknown;
  }[];
}

export interface OrganizationSingleFileQAEvaluationInput {
  readonly reviewedArtifactBytes: Uint8Array;
  readonly reviewedArtifactSha256: string;
  readonly plan: OrganizationSingleFileQAPlan;
  /** A prior Git proof supplied by a trusted caller; this evaluator checks its identity only. */
  readonly provenCandidate?: OrganizationGitResultProof;
}

export type OrganizationSingleFileQAReason =
  | "passed"
  | "wrong_result"
  | "invalid_output"
  | "process_failed"
  | "timed_out"
  | "output_limit";

export interface OrganizationSingleFileQAEvaluation {
  readonly accepted: boolean;
  readonly reason: OrganizationSingleFileQAReason;
  readonly reviewedArtifactSha256: string;
  readonly planVersion: 1;
  readonly planSha256: string;
  readonly sandboxIdentity: {
    readonly unitName: string;
    readonly invocationId: string;
    readonly controlGroup: string;
    readonly pidNamespace: number;
  };
  /** Server-produced evidence, suitable for a later trusted QA receipt capture. */
  readonly evidenceBytes: Uint8Array;
}

export class OrganizationSingleFileQAEvaluatorError extends Error {
  override readonly name = "OrganizationSingleFileQAEvaluatorError";
}

const sha256 = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const invalid = (message: string): never => {
  throw new OrganizationSingleFileQAEvaluatorError(message);
};

/** Canonical JSON comparison rejects non-JSON, non-finite numbers and cyclic values. */
function canonicalJson(value: unknown): string {
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > 16) return invalid("QA JSON depth exceeds its limit.");
    if (current === null || typeof current === "string" || typeof current === "boolean")
      return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return invalid("QA JSON contains a non-finite number.");
      return current;
    }
    if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));
    if (typeof current !== "object") return invalid("QA values must be JSON.");
    if (
      Object.getPrototypeOf(current) !== Object.prototype &&
      Object.getPrototypeOf(current) !== null
    )
      return invalid("QA values must be plain JSON objects.");
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(current).sort()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        return invalid("QA JSON contains a reserved key.");
      sorted[key] = visit((current as Record<string, unknown>)[key], depth + 1);
    }
    return sorted;
  };
  try {
    return JSON.stringify(visit(value, 0));
  } catch {
    return invalid("QA values are not finite JSON.");
  }
}

const PROBE = String.raw`
import fs from 'node:fs';
try {
  const plan = JSON.parse(fs.readFileSync('/workspace/qa-inputs.json', 'utf8'));
  const module = await import('file:///workspace/replacement.mjs');
  const fn = module[plan.exportName];
  if (typeof fn !== 'function') throw new Error('Missing named export');
  for (let index = 0; index < plan.inputs.length; index++) {
    const value = await fn(plan.inputs[index]);
    const json = JSON.stringify(value);
    if (typeof json !== 'string') throw new Error('Non-JSON result');
    process.stdout.write('T3QA1\t' + index + '\t' + Buffer.from(json, 'utf8').toString('base64') + '\n');
  }
} catch {
  process.stderr.write('QA probe failed\n');
  process.exitCode = 125;
}
`;

function checkOutput(
  result: OrganizationSandboxResult,
  expected: readonly string[],
): { reason: OrganizationSingleFileQAReason; observedDigests: readonly string[] } {
  if (result.timedOut) return { reason: "timed_out", observedDigests: [] };
  if (result.outputLimitExceeded) return { reason: "output_limit", observedDigests: [] };
  if (result.exitCode !== 0 || result.signal !== null || result.stderr !== "")
    return { reason: "process_failed", observedDigests: [] };
  if (!result.stdout.endsWith("\n")) return { reason: "invalid_output", observedDigests: [] };
  const lines = result.stdout.slice(0, -1).split("\n");
  if (lines.length !== expected.length) return { reason: "invalid_output", observedDigests: [] };
  const observedDigests: string[] = [];
  let wrong = false;
  for (const [index, line] of lines.entries()) {
    const match = PROTOCOL.exec(line);
    if (!match || Number(match[1]) !== index || !match[2])
      return { reason: "invalid_output", observedDigests: [] };
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > MAX_CASE_BYTES || bytes.toString("base64") !== match[2])
      return { reason: "invalid_output", observedDigests: [] };
    let observed: unknown;
    try {
      observed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const normalized = canonicalJson(observed);
      if (Buffer.byteLength(normalized, "utf8") > MAX_CASE_BYTES)
        return { reason: "invalid_output", observedDigests: [] };
      observedDigests.push(sha256(Buffer.from(normalized)));
      if (normalized !== expected[index]) wrong = true;
    } catch {
      return { reason: "invalid_output", observedDigests: [] };
    }
  }
  return { reason: wrong ? "wrong_result" : "passed", observedDigests };
}

function validatedInput(input: OrganizationSingleFileQAEvaluationInput): {
  artifact: OrganizationSingleFileArtifact;
  artifactSha256: string;
  planSha256: string;
  expected: readonly string[];
  probeInputs: string;
  candidateCommit: string | null;
} {
  if (
    !(input.reviewedArtifactBytes instanceof Uint8Array) ||
    !SHA256.test(input.reviewedArtifactSha256)
  )
    return invalid("Reviewed artifact identity is invalid.");
  const artifactBytes = Uint8Array.from(input.reviewedArtifactBytes);
  if (sha256(artifactBytes) !== input.reviewedArtifactSha256)
    return invalid("Reviewed artifact SHA-256 does not match exact bytes.");
  let artifact: OrganizationSingleFileArtifact;
  try {
    artifact = decodeOrganizationSingleFileArtifact(artifactBytes);
  } catch {
    return invalid("Reviewed artifact is not canonical.");
  }
  if (!FLAT_MODULE.test(artifact.relativePath))
    return invalid("QA supports one flat .mjs artifact only.");
  const plan = input.plan;
  if (
    !plan ||
    typeof plan !== "object" ||
    plan.version !== 1 ||
    typeof plan.exportName !== "string" ||
    !EXPORT_NAME.test(plan.exportName) ||
    !Array.isArray(plan.cases) ||
    plan.cases.length < 1 ||
    plan.cases.length > 8 ||
    plan.cases.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        !Object.hasOwn(item, "input") ||
        !Object.hasOwn(item, "expected"),
    )
  )
    return invalid("QA plan version, export or case count is invalid.");
  const expected = plan.cases.map((item) => canonicalJson(item.expected));
  const inputs = plan.cases.map((item) => canonicalJson(item.input));
  for (const item of [...expected, ...inputs])
    if (Buffer.byteLength(item, "utf8") > MAX_CASE_BYTES)
      return invalid("QA case exceeds its byte limit.");
  const fullPlan = JSON.stringify({
    version: 1,
    exportName: plan.exportName,
    cases: inputs.map((item, index) => ({
      input: JSON.parse(item),
      expected: JSON.parse(expected[index]!),
    })),
  });
  if (Buffer.byteLength(fullPlan, "utf8") > MAX_PLAN_BYTES)
    return invalid("QA plan exceeds its byte limit.");
  const proof = input.provenCandidate;
  if (
    proof &&
    (proof.reviewedArtifactDigest !== input.reviewedArtifactSha256 ||
      proof.baseCommit !== artifact.baseCommit ||
      proof.relativePath !== artifact.relativePath ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(proof.resultCommit))
  )
    return invalid("Candidate proof identity does not match reviewed artifact.");
  return {
    artifact,
    artifactSha256: input.reviewedArtifactSha256,
    planSha256: sha256(Buffer.from(fullPlan)),
    expected,
    probeInputs: JSON.stringify({
      exportName: plan.exportName,
      inputs: inputs.map((item) => JSON.parse(item)),
    }),
    candidateCommit: proof?.resultCommit ?? null,
  };
}

/** Disconnected evaluator: no receipt capture, work transition, or live authority. */
export async function evaluateOrganizationSingleFileQA(
  input: OrganizationSingleFileQAEvaluationInput,
  prepare: typeof prepareOrganizationScopedSandbox = prepareOrganizationScopedSandbox,
): Promise<OrganizationSingleFileQAEvaluation> {
  const checked = validatedInput(input);
  let handle: PreparedOrganizationScopedSandbox;
  try {
    handle = await prepare({
      argv: ["/usr/bin/node", "/workspace/qa-probe.mjs"],
      files: {
        "qa-probe.mjs": PROBE,
        "qa-inputs.json": checked.probeInputs,
        "replacement.mjs": checked.artifact.replacementBytes,
      },
      runtimeMs: 10_000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      workspaceBytes: 8 * 1024 * 1024,
    });
  } catch {
    return invalid("Scoped QA sandbox could not be prepared.");
  }
  let result: OrganizationSandboxResult;
  try {
    await handle.start();
    result = await handle.wait(); // wait resolves only after exact unit and namespace stop verification.
  } catch {
    try {
      await handle.stop();
    } catch {
      /* Preserve the failed stop fence. */
    }
    return invalid("Scoped QA sandbox could not be verified stopped.");
  }
  const checkedOutput = checkOutput(result, checked.expected);
  const identity = {
    unitName: handle.unitName,
    invocationId: handle.invocationId,
    controlGroup: handle.controlGroup,
    pidNamespace: handle.pidNamespace,
  };
  const evidenceBytes = Buffer.from(
    JSON.stringify({
      version: 1,
      reviewedArtifactSha256: checked.artifactSha256,
      baseCommit: checked.artifact.baseCommit,
      relativePath: checked.artifact.relativePath,
      replacementSha256: checked.artifact.replacementSha256,
      candidateResultCommit: checked.candidateCommit,
      planVersion: 1,
      planSha256: checked.planSha256,
      caseCount: checked.expected.length,
      observedDigests: checkedOutput.observedDigests,
      accepted: checkedOutput.reason === "passed",
      reason: checkedOutput.reason,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      outputLimitExceeded: result.outputLimitExceeded,
      sandboxIdentity: identity,
    }),
    "utf8",
  );
  return {
    accepted: checkedOutput.reason === "passed",
    reason: checkedOutput.reason,
    reviewedArtifactSha256: checked.artifactSha256,
    planVersion: 1,
    planSha256: checked.planSha256,
    sandboxIdentity: identity,
    evidenceBytes,
  };
}
