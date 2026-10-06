// Diagnostic CLI preserves the release runner's actual child environment.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Load the same parent CLI before spawning validation, rather than running the validator directly.
import "./fork-release.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { CandidateRecord } from "./fork-release.ts";
import { runValidation } from "./fork-release-config.ts";
import { PACKAGE_VALIDATION } from "./fork-release-suites.ts";

const check = process.argv[2];
if (check !== "install" && check !== "update" && check !== "recovery")
  throw new Error("Package diagnostic requires install, update, or recovery.");
const candidate = process.env.FORK_RELEASE_CANDIDATE_DIR;
const predecessor = process.env.FORK_RELEASE_PREDECESSOR_DIR;
if (!candidate || !predecessor)
  throw new Error("Package diagnostic requires retained candidate and predecessor directories.");
const record = JSON.parse(
  NodeFS.readFileSync(`${NodePath.resolve(candidate)}.json`, "utf8"),
) as CandidateRecord;

// The returned result stays in memory. No check receipt is written or exported to release jobs.
const result = runValidation(
  { run: PACKAGE_VALIDATION.run, timeoutMinutes: PACKAGE_VALIDATION.timeoutMinutes[check] },
  {
    check,
    target: "android",
    version: record.version,
    commit: record.commit,
    channel: record.channel,
    candidateDir: candidate,
    candidateDigest: record.candidateDigest,
    predecessorDir: predecessor,
    predecessorDigest: "diagnostic-only",
    repoRoot: process.cwd(),
    runner: "diagnostic-only",
    runUrl: "",
    namespace: `fork-release-${process.env.GITHUB_RUN_ID ?? "local"}-${check}-android`,
  },
);
console.log(`Android package diagnostic ${check}: ${result.passed ? "passed" : "failed"}`);
process.exit(result.passed ? 0 : 1);
