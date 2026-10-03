// @effect-diagnostics nodeBuiltinImport:off - Disposable bare Git fixtures verify the repository boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { OrganizationId, type OrganizationRepositoryRecord } from "@t3tools/contracts";
import {
  commitAndPush,
  decodeRepositoryRecord,
  MAX_RECORD_BYTES,
  readRepositoryIdentity,
  readRepositoryRecords,
  recordDigest,
  recordPath,
  withRepositoryClone,
  writeRepositoryIdentity,
  writeRepositoryRecord,
} from "./OrganizationRepositoryGit.ts";
import {
  DELETED_REMOTE_DIGEST,
  planOrganizationRepositoryMerge,
} from "./OrganizationRepositoryMerge.ts";
import {
  portableObservationAttributes,
  sanitizePortableContent,
} from "./OrganizationRepositoryCollector.ts";

const organizationId = OrganizationId.make("portable-org");
const record = (id: string, title: string): OrganizationRepositoryRecord => ({
  schemaVersion: 1,
  organizationId,
  kind: "memory",
  id,
  content: { title, provenance: { kind: "explicit-reference", reference: "issue:42" } },
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-repo-test-"));
  const bare = NodePath.join(root, "remote.git");
  NodeChildProcess.execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const bin = NodePath.join(root, "bin");
  await NodeFSP.mkdir(bin);
  const gh = NodePath.join(bin, "gh");
  await NodeFSP.writeFile(
    gh,
    `#!/bin/sh\nif [ "$1" = repo ] && [ "$2" = clone ]; then\n  exec git clone --no-checkout --depth=1 "file://$T3_TEST_BARE" "$4"\nfi\nexit 1\n`,
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    T3_TEST_BARE: bare,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: string[], directory = root) =>
    NodeChildProcess.execFileSync("git", args, { cwd: directory, env, encoding: "utf8" }).trim();
  return {
    root,
    bare,
    env,
    git,
    cleanup: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

it("round-trips portable records through a Git commit and detects concurrent remote pushes", async () => {
  const test = await fixture();
  try {
    const first = record("decision-1", "First decision");
    await withRepositoryClone(
      "owner/organization",
      test.env,
      async (directory, head) => {
        assert.equal(head, null);
        await writeRepositoryIdentity(directory, organizationId);
        await writeRepositoryRecord(directory, first);
        const commit = await commitAndPush(directory, test.env, "Share first decision");
        assert.match(commit ?? "", /^[a-f0-9]{40}$/);
      },
      false,
    );
    await withRepositoryClone(
      "owner/organization",
      test.env,
      async (directory, head) => {
        assert.match(head ?? "", /^[a-f0-9]{40}$/);
        assert.equal(await readRepositoryIdentity(directory), organizationId);
        const loaded = await readRepositoryRecords(directory, organizationId);
        assert.deepEqual(loaded.get("memory/decision-1"), first);

        const other = NodePath.join(test.root, "other");
        test.git(["clone", "-q", test.bare, other]);
        await writeRepositoryRecord(other, record("decision-1", "Remote update"));
        test.git(["add", "records"], other);
        test.git(
          [
            "-c",
            "user.name=Other",
            "-c",
            "user.email=other@example.invalid",
            "commit",
            "-q",
            "-m",
            "Concurrent update",
          ],
          other,
        );
        test.git(["push", "-q", "origin", "HEAD:refs/heads/main"], other);

        await writeRepositoryRecord(directory, record("decision-1", "Local update"));
        await NodeAssert.rejects(() => commitAndPush(directory, test.env, "Stale update"));
      },
      false,
    );
    await withRepositoryClone(
      "owner/organization",
      test.env,
      async (directory) => {
        const loaded = await readRepositoryRecords(directory, organizationId);
        assert.equal(loaded.get("memory/decision-1")?.content.title, "Remote update");
      },
      false,
    );
  } finally {
    await test.cleanup();
  }
});

it("refuses to guess an existing repository's default branch", async () => {
  const test = await fixture();
  try {
    await withRepositoryClone(
      "owner/organization",
      test.env,
      async (directory) => {
        await writeRepositoryIdentity(directory, organizationId);
        await writeRepositoryRecord(directory, record("decision-1", "First"));
        await commitAndPush(directory, test.env, "Initialize");
      },
      false,
    );
    await withRepositoryClone(
      "owner/organization",
      test.env,
      async (directory) => {
        test.git(["remote", "set-head", "origin", "-d"], directory);
        await writeRepositoryRecord(directory, record("decision-1", "Changed"));
        await NodeAssert.rejects(
          () => commitAndPush(directory, test.env, "Unknown default"),
          /default branch could not be determined/,
        );
      },
      false,
    );
  } finally {
    await test.cleanup();
  }
});

it("requires explicit resolution when both sides edit one accepted record", () => {
  const first = record("decision-1", "First decision");
  const local = record("decision-1", "Local update");
  const remote = record("decision-1", "Remote update");
  const accepted = new Map([
    [
      "memory/decision-1",
      {
        acceptedLocalDigest: recordDigest(first),
        acceptedRemoteDigest: recordDigest(first),
        remoteDigest: recordDigest(first),
        state: "shared" as const,
        resolution: null,
      },
    ],
  ]);
  const plan = planOrganizationRepositoryMerge(
    new Map([["memory/decision-1", local]]),
    new Map([["memory/decision-1", remote]]),
    accepted,
  );
  assert.equal(plan.get("memory/decision-1")?.state, "conflict");
  assert.equal(plan.get("memory/decision-1")?.writeLocal, false);

  const deleted = planOrganizationRepositoryMerge(
    new Map([["memory/decision-1", first]]),
    new Map(),
    accepted,
  );
  assert.equal(deleted.get("memory/decision-1")?.state, "conflict");
  const resolvedDeletion = planOrganizationRepositoryMerge(
    new Map([["memory/decision-1", first]]),
    new Map(),
    new Map([
      [
        "memory/decision-1",
        {
          ...accepted.get("memory/decision-1")!,
          remoteDigest: DELETED_REMOTE_DIGEST,
          resolution: "local" as const,
          state: "conflict" as const,
        },
      ],
    ]),
  );
  assert.equal(resolvedDeletion.get("memory/decision-1")?.writeLocal, true);

  // Loading a remote configuration into a new local draft records both transformed
  // local and original remote digests. A no-edit sync must not create a conflict.
  const loaded = planOrganizationRepositoryMerge(
    new Map([["memory/decision-1", local]]),
    new Map([["memory/decision-1", remote]]),
    new Map([
      [
        "memory/decision-1",
        {
          acceptedLocalDigest: recordDigest(local),
          acceptedRemoteDigest: recordDigest(remote),
          remoteDigest: recordDigest(remote),
          state: "incoming" as const,
          resolution: null,
        },
      ],
    ]),
  );
  assert.equal(loaded.get("memory/decision-1")?.state, "incoming");
  assert.equal(loaded.get("memory/decision-1")?.writeLocal, false);
});

it("rejects oversized, misplaced, and symlinked repository material", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-record-validate-"));
  try {
    assert.throws(() => decodeRepositoryRecord("x".repeat(MAX_RECORD_BYTES + 1), organizationId));
    const records = NodePath.join(root, "records", "memory");
    await NodeFSP.mkdir(records, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(records, "wrong.json"),
      JSON.stringify(record("decision-1", "A")),
    );
    await NodeAssert.rejects(() => readRepositoryRecords(root, organizationId));
    await NodeFSP.rm(NodePath.join(records, "wrong.json"));
    await NodeFSP.symlink("/etc/passwd", NodePath.join(root, "organization.json"));
    await NodeAssert.rejects(() => readRepositoryIdentity(root));
    await NodeFSP.rm(NodePath.join(root, "organization.json"));
    await NodeFSP.symlink("/etc/passwd", NodePath.join(records, "evil.json"));
    await NodeAssert.rejects(() => readRepositoryRecords(root, organizationId));
    assert.match(recordPath(record("decision-1", "A")), /^records\/memory\/[a-f0-9]+\.json$/);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("removes credential metadata and machine authority while retaining attributed evidence", () => {
  const attributes = portableObservationAttributes({
    correlationKey: "incident:42",
    channel: "ci",
    Cookie: "sessionid=abc123",
    sessionId: "abc123",
    Authorization: "Bearer private",
  });
  const content = sanitizePortableContent({
    attributes,
    title: "Observed issue",
    body: "Cookie: sessionid=abc123 in /home/alice/project/log.txt",
    binding: { access: "write", capabilities: ["write-files"] },
    provenance: { reference: "issue:42", note: "Reviewed" },
  }) as Record<string, unknown>;
  const text = JSON.stringify(content);
  assert.match(text, /incident:42/);
  assert.match(text, /issue:42/);
  assert.notMatch(text, /abc123|Bearer private|\/home\/alice|write-files|sessionId|Cookie/);
});
