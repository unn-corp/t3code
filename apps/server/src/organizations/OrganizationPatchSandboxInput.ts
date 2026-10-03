import * as NodeCrypto from "node:crypto";
import type { OrganizationSandboxInput } from "./OrganizationSandboxHost.ts";

const MAX_FILE_BYTES = 128 * 1024;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mjs$/;
const DIGEST = /^[a-f0-9]{64}$/;

/** This fixed program copies only the selected bytes into the sandbox tmpfs.
 * The model never chooses a command, executable, cwd, or host path. A zero test
 * exit is untrusted smoke evidence: replacement code can alter test assertions.
 */
const APPLICATOR = String.raw`
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
try {
  const { sourceName, testName } = JSON.parse(fs.readFileSync('/workspace/manifest.json', 'utf8'));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mjs$/.test(sourceName) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mjs$/.test(testName) ||
      sourceName === testName) throw new Error('invalid manifest');
  const source = fs.readFileSync('/workspace/replacement.txt');
  fs.writeFileSync('/workspace/tmp/' + sourceName, source, { flag: 'wx' });
  fs.copyFileSync('/workspace/test.txt', '/workspace/tmp/' + testName);
  const result = spawnSync('/usr/bin/node', ['--test', '/workspace/tmp/' + testName], {
    cwd: '/workspace/tmp', env: {}, shell: false, timeout: 10000, maxBuffer: 32768,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sourceDigest = crypto.createHash('sha256').update(source).digest('hex');
  const smokeExitZero = result.status === 0 && result.signal === null && !result.error;
  process.stdout.write(JSON.stringify({
    sourceDigest, smokeExitZero, exitCode: result.status,
    stdout: result.stdout?.toString('utf8').slice(0, 8192) ?? '',
    stderr: result.stderr?.toString('utf8').slice(0, 8192) ?? '',
  }) + '\n');
  process.exit(smokeExitZero ? 0 : 1);
} catch {
  process.stderr.write('Sandbox applicator failed\n');
  process.exit(125);
}
`;

export interface OrganizationPatchSandboxInput {
  readonly sourceName: string;
  readonly testName: string;
  readonly baseContent: string;
  readonly baseDigest: string;
  readonly replacementContent: string;
  readonly testContent: string;
}

export interface OrganizationPatchSandboxPayload {
  readonly baseDigest: string;
  readonly replacementDigest: string;
  readonly sandboxInput: OrganizationSandboxInput;
}

const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** A disconnected payload builder. Only a durable coordinator may start its sandbox. */
export function buildOrganizationPatchSandboxInput(
  input: OrganizationPatchSandboxInput,
): OrganizationPatchSandboxPayload {
  const sourceName = input.sourceName;
  const testName = input.testName;
  if (!SAFE_FILE.test(sourceName) || !SAFE_FILE.test(testName) || sourceName === testName)
    throw new TypeError("Patch source and test names must be distinct flat .mjs files");
  if (!DIGEST.test(input.baseDigest)) throw new TypeError("Base digest must be full SHA-256");
  const base = Buffer.from(input.baseContent, "utf8");
  const replacement = Buffer.from(input.replacementContent, "utf8");
  const test = Buffer.from(input.testContent, "utf8");
  if (
    [base, replacement, test].some(
      (bytes) => bytes.length === 0 || bytes.length > MAX_FILE_BYTES || bytes.includes(0),
    )
  )
    throw new TypeError("Patch files must be nonempty UTF-8 text within 128 KiB");
  if (hash(base) !== input.baseDigest) throw new TypeError("Base bytes do not match pinned digest");
  const manifest = JSON.stringify({ sourceName, testName });
  return {
    baseDigest: input.baseDigest,
    replacementDigest: hash(replacement),
    sandboxInput: {
      argv: ["/usr/bin/node", "/workspace/t3-work-applicator.mjs"],
      files: {
        "t3-work-applicator.mjs": APPLICATOR,
        "manifest.json": manifest,
        "replacement.txt": replacement,
        "test.txt": test,
      },
      runtimeMs: 15_000,
      maxOutputBytes: 20_000,
      workspaceBytes: 8 * 1024 * 1024,
    },
  };
}
