// @effect-diagnostics nodeBuiltinImport:off - commissioning tests execute the workflow's admission script in isolation.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
interface BaselineStep {
  id?: string;
  name?: string;
  run?: string;
  if?: string;
}
interface BaselineWorkflow {
  on: { schedule?: unknown };
  jobs: { plan: { steps: BaselineStep[] }; baseline: { steps: BaselineStep[] } };
}
const yaml = NodeModule.createRequire(NodePath.join(root, "packages/shared/package.json"))(
  "yaml",
) as { parse(text: string): unknown };
const workflow = yaml.parse(
  NodeFS.readFileSync(NodePath.join(root, ".github/workflows/fork-baseline.yml"), "utf8"),
) as BaselineWorkflow;
const pin = workflow.jobs.plan.steps.find((step) => step.id === "pin")!.run!;
const commit = "a".repeat(40);
function admit(overrides: Record<string, string> = {}) {
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-baseline-pin-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(temporary, "gh"),
      `#!/bin/bash
case "$2" in
  */compare/*) printf '%s\\n' "$COMPARE" ;;
  */git/ref/tags/fork-baseline) [[ -n "$BASELINE_OWNER" ]] || exit 1; printf '%s\\n' "$BASELINE_OWNER" ;;
  */git/ref/*) printf '%s\\n' "$OWNER" ;;
  */releases/tags/*) exit "$EXISTS" ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o700 },
    );
    const output = NodePath.join(temporary, "output");
    const result = NodeChildProcess.spawnSync("bash", ["-c", pin], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${temporary}${NodePath.delimiter}${process.env.PATH}`,
        COMMIT: commit,
        CODE: "29853800",
        COMPARE: "behind",
        OWNER: commit,
        BASELINE_OWNER: "",
        EXISTS: "1",
        GITHUB_REPOSITORY: "unn-corp/t3code",
        GITHUB_OUTPUT: output,
        ...overrides,
      },
    });
    return {
      code: result.status,
      error: result.stderr,
      output: NodeFS.existsSync(output) ? NodeFS.readFileSync(output, "utf8") : "",
    };
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
}
describe("manual baseline admission", () => {
  it("cleans up only this run's unpublished draft after a failed roundtrip", () => {
    const publish = workflow.jobs.baseline.steps.find(
      (step) => step.name === "Publish complete manual baseline",
    )!.run!;
    for (const draft of [
      { draft: true, body: "<!-- t3-fork-baseline-run:777 -->", id: 123 },
      { draft: false, body: "<!-- t3-fork-baseline-run:777 -->", id: 123 },
      { draft: true, body: "<!-- t3-fork-baseline-run:888 -->", id: 123 },
    ]) {
      const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-baseline-cleanup-"));
      try {
        const deleted = NodePath.join(temporary, "deleted");
        NodeFS.writeFileSync(
          NodePath.join(temporary, "gh"),
          `#!/bin/bash
if [[ "$1" == api && "$2" == --method ]]; then printf '%s' "$5" > "$DELETED"; exit 0; fi
if [[ "$1" == api && "$2" == */immutable-releases ]]; then echo true; exit 0; fi
if [[ "$1" == api && "$2" == */releases/tags/* ]]; then printf '%s' "$DRAFT" | jq -r "$4"; exit $?; fi
if [[ "$1" == release && "$2" == create ]]; then exit 0; fi
if [[ "$1" == release && "$2" == download ]]; then exit 1; fi
exit 99
`,
          { mode: 0o700 },
        );
        const result = NodeChildProcess.spawnSync("bash", ["-c", publish], {
          cwd: temporary,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${temporary}${NodePath.delimiter}${process.env.PATH}`,
            DELETED: deleted,
            DRAFT: JSON.stringify(draft),
            GITHUB_REPOSITORY: "unn-corp/t3code",
            GITHUB_RUN_ID: "777",
            COMMIT: commit,
          },
        });
        expect(result.status).toBe(1);
        expect(NodeFS.existsSync(deleted)).toBe(draft.draft && draft.body.includes(":777"));
      } finally {
        NodeFS.rmSync(temporary, { recursive: true, force: true });
      }
    }
  });
  it("pins only an on-main commit with its reserved code", () => {
    expect(admit()).toEqual({
      code: 0,
      error: "",
      output: `skip=false\nversion=1.0.0\ncommit=${commit}\nnormal_code=29853800\n`,
    });
  });
  it("refuses a different code owner, off-main source, invalid code, and replacement baseline", () => {
    for (const override of [
      { OWNER: "b".repeat(40) },
      { COMPARE: "ahead" },
      { CODE: "29853678" },
      { CODE: "2147483647" },
      { EXISTS: "0" },
      { BASELINE_OWNER: "b".repeat(40) },
      { COMMIT: "main;exit 0" },
    ]) {
      const result = admit(override);
      expect(result.code).not.toBe(0);
      expect(result.output).toBe("");
    }
  });
  it("has no scheduler or normal feed and verifies a complete roundtrip before publication", () => {
    expect(workflow.on.schedule).toBeUndefined();
    const publish = workflow.jobs.baseline.steps.find(
      (step) => step.name === "Publish complete manual baseline",
    )!;
    expect(publish.if).toBe("${{ inputs.publish }}");
    const run = publish.run!;
    expect(run.indexOf("baseline-verify --input baseline-roundtrip")).toBeLessThan(
      run.indexOf("gh release edit fork-baseline --draft=false"),
    );
    expect(run).toContain("--draft --prerelease");
    expect(run).not.toContain("fork-release.json");
    expect(
      NodeChildProcess.spawnSync("bash", ["-n"], { input: run, encoding: "utf8" }).status,
    ).toBe(0);
  });
});
