// @effect-diagnostics nodeBuiltinImport:off - Local bare Git fixture never uses GitHub or user data.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { OrganizationId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { OrganizationStore, OrganizationStoreLive } from "./OrganizationStore.ts";
import {
  OrganizationRepositoryStore,
  OrganizationRepositoryStoreLive,
} from "./OrganizationRepositoryStore.ts";
import { OrganizationRepositoryTransport } from "./OrganizationRepositoryTransport.ts";
import {
  OrganizationRepositorySyncCoordinator,
  OrganizationRepositorySyncCoordinatorLive,
} from "./OrganizationRepositorySyncLoop.ts";
import {
  readRepositoryRecords,
  withRepositoryClone,
  writeRepositoryRecord,
} from "./OrganizationRepositoryGit.ts";

const organizationId = OrganizationId.make("shared-knowledge-fixture");
const human = { subject: "fixture-human", interactive: true } as const;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "loads a shared draft, keeps history staged, and resolves a concurrent memory edit",
  () => {
    const originalPath = process.env.PATH;
    return Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-org-store-test-"))),
      (root) =>
        Effect.gen(function* () {
          const bare = NodePath.join(root, "remote.git");
          NodeChildProcess.execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
          const bin = NodePath.join(root, "bin");
          yield* Effect.promise(() => NodeFSP.mkdir(bin));
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(bin, "gh"),
              `#!/bin/sh\nif [ "$1" = repo ] && [ "$2" = clone ]; then\n  exec git clone --no-checkout --depth=1 "file://$T3_TEST_BARE" "$4"\nfi\nexit 1\n`,
              { mode: 0o700 },
            ),
          );
          process.env.PATH = `${bin}:${originalPath ?? "/usr/bin:/bin"}`;
          process.env.T3_TEST_BARE = bare;
          let remoteVisibility: "private" | "public" = "private";
          const transport = {
            create: async () => undefined,
            inspect: async () => remoteVisibility,
            withClone: <A>(
              repository: string,
              env: NodeJS.ProcessEnv,
              fn: (directory: string, head: string | null) => Promise<A>,
            ) => withRepositoryClone(repository, env, fn, false),
          };
          const runDb = <A, E>(
            effect: Effect.Effect<
              A,
              E,
              OrganizationStore | OrganizationRepositoryStore | SqlClient.SqlClient
            >,
          ) =>
            effect.pipe(
              Effect.provide(
                Layer.mergeAll(OrganizationStoreLive, OrganizationRepositoryStoreLive).pipe(
                  Layer.provideMerge(ServerSettings.layerTest()),
                  Layer.provideMerge(NodeSqliteClient.layerMemory()),
                  Layer.provideMerge(Layer.succeed(OrganizationRepositoryTransport, transport)),
                ),
              ),
            );
          const first = yield* runDb(
            Effect.gen(function* () {
              yield* runMigrations();
              const organizations = yield* OrganizationStore;
              const repositories = yield* OrganizationRepositoryStore;
              yield* organizations.create({
                organizationId,
                mutationId: "create-shared-org",
                title: "Shared organization",
                mission: "Investigate safely",
                actor: "user",
              });
              remoteVisibility = "public";
              const unacknowledgedLink = yield* Effect.exit(
                repositories.link(
                  {
                    organizationId,
                    repository: "owner/knowledge",
                    create: false,
                    visibility: "private",
                    autoSync: false,
                  },
                  human,
                ),
              );
              assert.equal(unacknowledgedLink._tag, "Failure");
              remoteVisibility = "private";
              const linked = yield* repositories.link(
                {
                  organizationId,
                  repository: "owner/knowledge",
                  create: false,
                  visibility: "private",
                  autoSync: false,
                },
                human,
              );
              assert.equal(linked.conflictCount, 0);
              const sql = yield* SqlClient.SqlClient;
              const timestamp = "2026-09-27T00:00:00.000Z";
              yield* sql`INSERT INTO organization_memory_records
        (record_id,organization_id,project_id,version,status,superseded_by_id,content_json,
          created_by,created_at,updated_at) VALUES (${"shared-memory"},${organizationId},${null},
          ${1},${"active"},${null},${encodeJson({
            kind: "decision",
            title: "Shared decision",
            body: "Use a bounded review.",
            provenance: { kind: "explicit-reference", reference: "issue:42", note: "Approved" },
            reviewedAt: null,
            staleAt: null,
            retainUntil: null,
          })},${human.subject},${timestamp},${timestamp})`;
              yield* sql`UPDATE organization_repositories SET auto_sync_enabled = 1,
                next_sync_at = ${"0001-01-01T00:00:00.000Z"}
                WHERE organization_id = ${organizationId}`;
              const scheduled = yield* sql<{
                auto_sync_enabled: number;
                next_sync_at: string;
              }>`SELECT auto_sync_enabled,next_sync_at FROM organization_repositories WHERE organization_id = ${organizationId}`;
              assert.equal(scheduled[0]?.auto_sync_enabled, 1);
              const due = yield* Effect.gen(function* () {
                const coordinator = yield* OrganizationRepositorySyncCoordinator;
                return yield* coordinator.runOnce();
              }).pipe(Effect.provide(OrganizationRepositorySyncCoordinatorLive));
              assert.equal(due, 1);
              const synced = yield* repositories.status({ organizationId });
              assert.equal(synced.conflictCount, 0);
              assert.equal(synced.pendingCount, 0);
              const other = NodePath.join(root, "other");
              NodeChildProcess.execFileSync("git", ["clone", "-q", bare, other]);
              NodeChildProcess.execFileSync("git", [
                "-C",
                other,
                "rm",
                "-r",
                "-q",
                "records/memory",
              ]);
              NodeChildProcess.execFileSync("git", [
                "-C",
                other,
                "-c",
                "user.name=Other",
                "-c",
                "user.email=other@example.invalid",
                "commit",
                "-q",
                "-m",
                "Delete memory",
              ]);
              NodeChildProcess.execFileSync("git", [
                "-C",
                other,
                "push",
                "-q",
                "origin",
                "HEAD:refs/heads/main",
              ]);
              const deleted = yield* repositories.sync({ organizationId }, human);
              assert.equal(deleted.conflictCount, 1);
              const row = (yield* repositories.listRecords({ organizationId, kind: "memory" }))
                .records[0]!;
              assert.equal(row.remoteDigest, "0".repeat(64));
              const restored = yield* repositories.resolveConflict(
                {
                  organizationId,
                  recordKey: row.recordKey,
                  choice: "local",
                  expectedRemoteDigest: row.remoteDigest,
                },
                human,
              );
              assert.equal(restored.conflictCount, 0);
              remoteVisibility = "public";
              const drift = yield* Effect.exit(repositories.sync({ organizationId }, human));
              assert.equal(drift._tag, "Failure");
              const paused = yield* repositories.status({ organizationId });
              assert.equal(paused.visibility, "public");
              assert.equal(paused.publicExposureAcknowledged, false);
              const resumed = yield* repositories.link(
                {
                  organizationId,
                  repository: "owner/knowledge",
                  create: false,
                  visibility: "public",
                  publicExposureAcknowledged: true,
                  autoSync: true,
                },
                human,
              );
              assert.equal(resumed.publicExposureAcknowledged, true);
              remoteVisibility = "private";
              return synced;
            }),
          );
          assert.match(first.lastAcceptedCommit ?? "", /^[a-f0-9]{40}$/);
          const second = yield* runDb(
            Effect.gen(function* () {
              yield* runMigrations();
              const repositories = yield* OrganizationRepositoryStore;
              remoteVisibility = "public";
              const unacknowledgedLoad = yield* Effect.exit(
                repositories.load(
                  {
                    repository: "owner/knowledge",
                    autoSync: true,
                  },
                  human,
                ),
              );
              assert.equal(unacknowledgedLoad._tag, "Failure");
              remoteVisibility = "private";
              const loaded = yield* repositories.load(
                { repository: "owner/knowledge", autoSync: false },
                human,
              );
              assert.equal(loaded.organizationId, organizationId);
              assert.equal(loaded.conflictCount, 0);
              const incoming = yield* repositories.listRecords({ organizationId, kind: "memory" });
              assert.equal(
                (incoming.records[0]?.record.content.content as { title?: string })?.title,
                "Shared decision",
              );
              assert.equal(incoming.records[0]?.state, "incoming");
              const unchanged = yield* repositories.sync({ organizationId }, human);
              assert.equal(unchanged.conflictCount, 0);
              const sql = yield* SqlClient.SqlClient;
              const timestamp = "2026-09-27T00:00:00.000Z";
              yield* sql`INSERT INTO organization_memory_records
        (record_id,organization_id,project_id,version,status,superseded_by_id,content_json,
          created_by,created_at,updated_at) VALUES (${"shared-memory"},${organizationId},${null},
          ${1},${"active"},${null},${encodeJson({
            kind: "decision",
            title: "Local correction",
            body: "Use two reviewers.",
            provenance: { kind: "explicit-reference", reference: "issue:42", note: "Local edit" },
            reviewedAt: null,
            staleAt: null,
            retainUntil: null,
          })},${human.subject},${timestamp},${timestamp})`;
              const conflict = yield* repositories.sync({ organizationId }, human);
              assert.equal(conflict.conflictCount, 1);
              const row = (yield* repositories.listRecords({ organizationId, kind: "memory" }))
                .records[0]!;
              const resolved = yield* repositories.resolveConflict(
                {
                  organizationId,
                  recordKey: row.recordKey,
                  choice: "local",
                  expectedRemoteDigest: row.remoteDigest,
                },
                human,
              );
              assert.equal(resolved.conflictCount, 0);
              yield* Effect.promise(async () => {
                const other = NodePath.join(root, "remote-follow-up");
                NodeChildProcess.execFileSync("git", ["clone", "-q", bare, other]);
                const remote = (await readRepositoryRecords(other, organizationId)).get(
                  "memory/shared-memory",
                )!;
                const content = remote.content.content as Record<string, unknown>;
                await writeRepositoryRecord(other, {
                  ...remote,
                  content: {
                    ...remote.content,
                    content: { ...content, title: "Remote follow-up" },
                  },
                });
                NodeChildProcess.execFileSync("git", ["-C", other, "add", "records"]);
                NodeChildProcess.execFileSync("git", [
                  "-C",
                  other,
                  "-c",
                  "user.name=Other",
                  "-c",
                  "user.email=other@example.invalid",
                  "commit",
                  "-q",
                  "-m",
                  "Follow-up",
                ]);
                NodeChildProcess.execFileSync("git", [
                  "-C",
                  other,
                  "push",
                  "-q",
                  "origin",
                  "HEAD:refs/heads/main",
                ]);
              });
              const pulled = yield* repositories.sync({ organizationId }, human);
              assert.equal(pulled.conflictCount, 0);
              const followUp = (yield* repositories.listRecords({ organizationId, kind: "memory" }))
                .records[0]!;
              assert.equal(followUp.state, "incoming");
              assert.equal(
                (followUp.record.content.content as { title?: string }).title,
                "Remote follow-up",
              );
              return pulled;
            }),
          );
          assert.match(second.lastAcceptedCommit ?? "", /^[a-f0-9]{40}$/);
        }),
      (root) =>
        Effect.promise(async () => {
          if (originalPath === undefined) delete process.env.PATH;
          else process.env.PATH = originalPath;
          delete process.env.T3_TEST_BARE;
          await NodeFSP.rm(root, { recursive: true, force: true });
        }),
    );
  },
);
