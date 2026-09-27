import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  Organization,
  GitHubAccountId,
  OrganizationId,
  OrganizationRepositoryError,
  OrganizationRepositoryLinkInput,
  OrganizationRepositoryListInput,
  OrganizationRepositoryLoadInput,
  OrganizationRepositoryPreviewInput,
  OrganizationRepositoryRecord,
  OrganizationRepositoryResolveInput,
  OrganizationRepositorySyncInput,
  type OrganizationRepositoryStatus,
  type OrganizationRepositoryRecord as RecordValue,
  type OrganizationRepositoryRecordView,
} from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import { validateOrganizationGraph, validateOrganizationWorkflow } from "./OrganizationStore.ts";
import {
  collectOrganizationRepositoryRecords,
  organizationRepositoryExclusions,
} from "./OrganizationRepositoryCollector.ts";
import {
  commitAndPush,
  readRepositoryIdentity,
  readRepositoryRecords,
  recordDigest,
  recordJson,
  writeRepositoryIdentity,
  writeRepositoryRecord,
} from "./OrganizationRepositoryGit.ts";
import { OrganizationRepositoryTransport } from "./OrganizationRepositoryTransport.ts";
import {
  DELETED_REMOTE_DIGEST,
  planOrganizationRepositoryMerge,
  type AcceptedRepositoryRecord,
} from "./OrganizationRepositoryMerge.ts";

export interface OrganizationRepositoryPrincipal {
  readonly subject: string;
  readonly interactive: boolean;
}
type LinkRow = {
  organization_id: string;
  repository: string;
  visibility: "private" | "public" | "internal";
  github_account_id: string | null;
  auto_sync_enabled: number;
  public_exposure_acknowledged: number;
  next_sync_at: string | null;
  failure_count: number;
  last_accepted_commit: string | null;
  last_sync_at: string | null;
  last_error: string | null;
};
type RecordRow = {
  record_key: string;
  remote_json: string;
  remote_digest: string;
  accepted_local_digest: string | null;
  accepted_remote_digest: string | null;
  state: "incoming" | "shared" | "conflict";
  resolution: "local" | "remote" | null;
};
const issue = (code: OrganizationRepositoryError["code"], message: string) =>
  new OrganizationRepositoryError({ code, message });
const invalid = (message: string) => issue("invalid", message);
const unavailable = () => issue("unavailable", "Organization repository sync is unavailable.");
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const validRepository = (repository: string) =>
  repositoryPattern.test(repository) &&
  !repository.split("/").some((part) => part === "." || part === ".." || part.endsWith(".git"));
const tryExternal = <A>(run: () => Promise<A>, message: string) =>
  Effect.tryPromise({
    try: run,
    catch: () => issue("unavailable", message),
  });
const decodeOrganizationId = Schema.decodeUnknownEffect(OrganizationId);
const decodeOrganization = Schema.decodeUnknownEffect(Organization);
const decodeRecord = Schema.decodeUnknownEffect(OrganizationRepositoryRecord);
const isRepositoryError = Schema.is(OrganizationRepositoryError);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const storeErrors = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.mapError((error) => (isRepositoryError(error) ? error : unavailable())));
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export interface OrganizationRepositoryStoreShape {
  readonly preview: (input: OrganizationRepositoryPreviewInput) => Effect.Effect<
    {
      organizationId: OrganizationId;
      counts: ReadonlyArray<{ kind: RecordValue["kind"]; count: number }>;
      totalRecords: number;
      excluded: ReadonlyArray<string>;
    },
    OrganizationRepositoryError
  >;
  readonly link: (
    input: OrganizationRepositoryLinkInput,
    principal: OrganizationRepositoryPrincipal,
  ) => Effect.Effect<OrganizationRepositoryStatus, OrganizationRepositoryError>;
  readonly load: (
    input: OrganizationRepositoryLoadInput,
    principal: OrganizationRepositoryPrincipal,
  ) => Effect.Effect<OrganizationRepositoryStatus, OrganizationRepositoryError>;
  readonly sync: (
    input: OrganizationRepositorySyncInput,
    principal: OrganizationRepositoryPrincipal,
  ) => Effect.Effect<OrganizationRepositoryStatus, OrganizationRepositoryError>;
  readonly syncBackground: (
    input: OrganizationRepositorySyncInput,
  ) => Effect.Effect<OrganizationRepositoryStatus, OrganizationRepositoryError>;
  readonly status: (
    input: OrganizationRepositorySyncInput,
  ) => Effect.Effect<OrganizationRepositoryStatus, OrganizationRepositoryError>;
  readonly listRecords: (input: OrganizationRepositoryListInput) => Effect.Effect<
    {
      records: ReadonlyArray<OrganizationRepositoryRecordView>;
      nextCursor: string | null;
    },
    OrganizationRepositoryError
  >;
  readonly resolveConflict: (
    input: OrganizationRepositoryResolveInput,
    principal: OrganizationRepositoryPrincipal,
  ) => Effect.Effect<OrganizationRepositoryStatus, OrganizationRepositoryError>;
}
export class OrganizationRepositoryStore extends Context.Service<
  OrganizationRepositoryStore,
  OrganizationRepositoryStoreShape
>()("t3/organizations/OrganizationRepositoryStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* ServerSettings.ServerSettingsService;
  const transport = yield* OrganizationRepositoryTransport;
  const syncLocks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (organizationId: string) => {
    let lock = syncLocks.get(organizationId);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      syncLocks.set(organizationId, lock);
    }
    return lock;
  };
  const requireHuman = (principal: OrganizationRepositoryPrincipal) => {
    if (!principal.interactive || !principal.subject.trim() || principal.subject.length > 256)
      return Effect.fail(issue("forbidden", "An authenticated interactive user is required."));
    return Effect.void;
  };
  const getLink = (organizationId: OrganizationId) => sql<LinkRow>`
    SELECT * FROM organization_repositories WHERE organization_id = ${organizationId}`;
  const accountEnvironment = Effect.fnUntraced(function* (
    accountId: OrganizationRepositoryLinkInput["githubAccountId"],
  ) {
    let selected: NodeJS.ProcessEnv = {};
    if (accountId) {
      const account = yield* settings
        .getGitHubAccountEnvironment(accountId)
        .pipe(
          Effect.mapError(() =>
            issue("unavailable", "The selected GitHub account is unavailable."),
          ),
        );
      if (!account.configured)
        return yield* issue("forbidden", "The selected GitHub account needs a token.");
      selected = account.environment ?? {};
    }
    return {
      ...process.env,
      ...selected,
      GIT_TERMINAL_PROMPT: "0",
      GH_PROMPT_DISABLED: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_LFS_SKIP_SMUDGE: "1",
    };
  });
  const checkedOrganization = Effect.fnUntraced(function* (organizationId: OrganizationId) {
    const row = (yield* sql<{ lifecycle: string }>`SELECT lifecycle FROM organizations
      WHERE organization_id = ${organizationId}`)[0];
    if (!row) return yield* issue("not_found", "Organization not found.");
    return row;
  });
  const status: OrganizationRepositoryStoreShape["status"] = (input) =>
    storeErrors(
      Effect.gen(function* () {
        const parsed = input;
        yield* checkedOrganization(parsed.organizationId);
        const link = (yield* getLink(parsed.organizationId))[0];
        if (!link)
          return {
            organizationId: parsed.organizationId,
            repository: null,
            visibility: null,
            autoSyncEnabled: false,
            publicExposureAcknowledged: false,
            lastAcceptedCommit: null,
            lastSyncAt: null,
            pendingCount: 0,
            incomingCount: 0,
            conflictCount: 0,
            lastError: null,
          };
        const rows = yield* sql<RecordRow>`SELECT * FROM organization_repository_records
      WHERE organization_id = ${parsed.organizationId}`;
        const local = yield* collectOrganizationRepositoryRecords(sql, parsed.organizationId).pipe(
          Effect.mapError(() => unavailable()),
        );
        const byKey = new Map(rows.map((row) => [row.record_key, row]));
        let pendingCount = 0;
        for (const [key, record] of local) {
          const row = byKey.get(key);
          if (row?.resolution === "remote" && row.accepted_local_digest === recordDigest(record))
            continue;
          if (!row || row.accepted_local_digest !== recordDigest(record)) pendingCount++;
        }
        return {
          organizationId: parsed.organizationId,
          repository: link.repository,
          visibility: link.visibility,
          autoSyncEnabled: link.auto_sync_enabled === 1,
          publicExposureAcknowledged: link.public_exposure_acknowledged === 1,
          lastAcceptedCommit: link.last_accepted_commit,
          lastSyncAt: link.last_sync_at,
          pendingCount,
          incomingCount: rows.filter((row) => row.state === "incoming").length,
          conflictCount: rows.filter((row) => row.state === "conflict").length,
          lastError: link.last_error,
        };
      }),
    );
  const preview: OrganizationRepositoryStoreShape["preview"] = (input) =>
    storeErrors(
      Effect.gen(function* () {
        const parsed = input;
        const records = yield* collectOrganizationRepositoryRecords(
          sql,
          parsed.organizationId,
        ).pipe(
          Effect.mapError(() =>
            invalid("Organization contains a record that cannot be shared safely."),
          ),
        );
        const counts = new Map<RecordValue["kind"], number>();
        for (const record of records.values())
          counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
        return {
          organizationId: parsed.organizationId,
          counts: [...counts].map(([kind, count]) => ({ kind, count })),
          totalRecords: records.size,
          excluded: organizationRepositoryExclusions,
        };
      }),
    );
  const syncInternal = (input: OrganizationRepositorySyncInput) =>
    lockFor(input.organizationId).withPermits(1)(
      storeErrors(
        Effect.gen(function* () {
          const parsed = input;
          const link = (yield* getLink(parsed.organizationId))[0];
          if (!link) return yield* issue("not_found", "Organization repository is not linked.");
          const env = yield* accountEnvironment(
            link.github_account_id ? GitHubAccountId.make(link.github_account_id) : undefined,
          );
          const actualVisibility = yield* tryExternal(
            () => transport.inspect(link.repository, NodeProcess.cwd(), env),
            "GitHub repository visibility could not be verified; sync was not pushed.",
          );
          if (actualVisibility !== link.visibility)
            yield* sql`UPDATE organization_repositories SET visibility = ${actualVisibility}
              WHERE organization_id = ${parsed.organizationId}`;
          if (actualVisibility === "public" && link.public_exposure_acknowledged !== 1) {
            yield* sql`UPDATE organization_repositories SET
              last_error = ${"Repository is public. A human must acknowledge public exposure before sync."}
              WHERE organization_id = ${parsed.organizationId}`;
            return yield* issue(
              "forbidden",
              "Repository is public. Linking it again with public acknowledgment is required before sync.",
            );
          }
          const local = yield* collectOrganizationRepositoryRecords(
            sql,
            parsed.organizationId,
          ).pipe(
            Effect.mapError(() =>
              invalid("Organization contains a record that cannot be shared safely."),
            ),
          );
          const rows = yield* sql<RecordRow>`SELECT * FROM organization_repository_records
      WHERE organization_id = ${parsed.organizationId}`;
          const accepted = new Map<string, AcceptedRepositoryRecord>(
            rows.map((row) => [
              row.record_key,
              {
                acceptedLocalDigest: row.accepted_local_digest,
                acceptedRemoteDigest: row.accepted_remote_digest,
                remoteDigest: row.remote_digest,
                state: row.state,
                resolution: row.resolution,
              },
            ]),
          );
          const exchange = yield* tryExternal(
            () =>
              transport.withClone(link.repository, env, async (directory, observedHead) => {
                const identity = await readRepositoryIdentity(directory);
                if (identity !== null && identity !== parsed.organizationId)
                  throw new Error("Repository belongs to another Organization.");
                const remote = await readRepositoryRecords(directory, parsed.organizationId);
                const plan = planOrganizationRepositoryMerge(local, remote, accepted);
                const visibilityAtPush = await transport.inspect(link.repository, directory, env);
                if (visibilityAtPush === "public" && link.public_exposure_acknowledged !== 1)
                  throw new Error("Repository became public before push.");
                await writeRepositoryIdentity(directory, parsed.organizationId);
                for (const [key, entry] of plan)
                  if (entry.writeLocal && entry.local) {
                    await writeRepositoryRecord(directory, entry.local);
                    remote.set(key, entry.local);
                  }
                const committed = await commitAndPush(
                  directory,
                  env,
                  `Share Organization ${parsed.organizationId}`,
                );
                return { remote, plan, commit: committed ?? observedHead };
              }),
            "GitHub sync failed. Local changes remain pending; retry after checking access or remote changes.",
          ).pipe(
            Effect.tapError(() =>
              Effect.gen(function* () {
                const delay = Math.min(3600, 30 * 2 ** Math.min(7, link.failure_count));
                const retryAt = DateTime.formatIso(
                  DateTime.add(yield* DateTime.now, { seconds: delay }),
                );
                yield* sql`UPDATE organization_repositories SET
          last_error = ${"GitHub sync failed; local changes remain pending."},
          failure_count = failure_count + 1, next_sync_at = ${retryAt}
          WHERE organization_id = ${parsed.organizationId}`.pipe(Effect.ignore);
              }),
            ),
          );
          const syncedAt = yield* now;
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                for (const [key, record] of exchange.remote) {
                  const item = exchange.plan.get(key);
                  if (!item) continue;
                  const digest = recordDigest(record);
                  const shared = item.writeLocal || item.state === "shared";
                  const previous = accepted.get(key);
                  const state = shared
                    ? "shared"
                    : item.state === "local-only"
                      ? "conflict"
                      : item.state;
                  yield* sql`INSERT INTO organization_repository_records
          (organization_id, record_key, remote_json, remote_digest, accepted_local_digest,
            accepted_remote_digest, state, resolution, updated_at)
          VALUES (${parsed.organizationId}, ${key}, ${recordJson(record)}, ${digest},
            ${shared ? digest : (previous?.acceptedLocalDigest ?? null)},
            ${shared ? digest : (previous?.acceptedRemoteDigest ?? null)}, ${state},
            ${shared ? null : (previous?.resolution ?? null)}, ${syncedAt})
          ON CONFLICT(organization_id, record_key) DO UPDATE SET
            remote_json = excluded.remote_json, remote_digest = excluded.remote_digest,
            accepted_local_digest = excluded.accepted_local_digest,
            accepted_remote_digest = excluded.accepted_remote_digest, state = excluded.state,
            resolution = excluded.resolution, updated_at = excluded.updated_at`;
                }
                for (const [key, item] of exchange.plan) {
                  if (item.remote !== null || item.writeLocal || item.state !== "conflict")
                    continue;
                  yield* sql`UPDATE organization_repository_records SET state = ${"conflict"},
                remote_digest = ${DELETED_REMOTE_DIGEST}, resolution = NULL,
                updated_at = ${syncedAt}
                WHERE organization_id = ${parsed.organizationId} AND record_key = ${key}`;
                }
                const nextSyncAt = DateTime.formatIso(
                  DateTime.add(yield* DateTime.now, { minutes: 2 }),
                );
                yield* sql`UPDATE organization_repositories SET last_accepted_commit = ${exchange.commit},
        last_sync_at = ${syncedAt}, last_error = NULL, failure_count = 0,
        next_sync_at = ${nextSyncAt}
        WHERE organization_id = ${parsed.organizationId}`;
              }),
            )
            .pipe(Effect.mapError(() => unavailable()));
          return yield* status(parsed);
        }),
      ),
    );
  const sync: OrganizationRepositoryStoreShape["sync"] = (input, principal) =>
    storeErrors(
      Effect.gen(function* () {
        yield* requireHuman(principal);
        return yield* syncInternal(input);
      }),
    );
  const syncBackground: OrganizationRepositoryStoreShape["syncBackground"] = (input) =>
    storeErrors(
      Effect.gen(function* () {
        const link = (yield* getLink(input.organizationId))[0];
        if (!link || link.auto_sync_enabled !== 1)
          return yield* issue("forbidden", "Automatic sync is disabled.");
        return yield* syncInternal(input);
      }),
    );
  const link: OrganizationRepositoryStoreShape["link"] = (input, principal) =>
    storeErrors(
      Effect.gen(function* () {
        yield* requireHuman(principal);
        const parsed = input;
        if (!validRepository(parsed.repository))
          return yield* invalid("Use a GitHub OWNER/REPO name.");
        if (parsed.create && parsed.visibility === "public" && !parsed.publicExposureAcknowledged)
          return yield* invalid("Acknowledge that portable Organization records will be public.");
        yield* checkedOrganization(parsed.organizationId);
        const existing = (yield* getLink(parsed.organizationId))[0];
        if (existing) {
          if (
            parsed.create ||
            parsed.repository !== existing.repository ||
            !parsed.publicExposureAcknowledged
          )
            return yield* issue("conflict", "Organization already has a repository.");
          const existingEnv = yield* accountEnvironment(
            existing.github_account_id
              ? GitHubAccountId.make(existing.github_account_id)
              : undefined,
          );
          const actual = yield* tryExternal(
            () => transport.inspect(existing.repository, NodeProcess.cwd(), existingEnv),
            "GitHub repository could not be verified.",
          );
          if (actual !== "public")
            return yield* invalid("Public acknowledgment is only needed for a public repository.");
          yield* sql`UPDATE organization_repositories SET public_exposure_acknowledged = 1,
            visibility = ${actual}, last_error = NULL, next_sync_at = ${yield* now}
            WHERE organization_id = ${parsed.organizationId}`;
          return yield* syncInternal({ organizationId: parsed.organizationId });
        }
        const env = yield* accountEnvironment(parsed.githubAccountId);
        if (parsed.create)
          yield* tryExternal(
            () => transport.create(parsed.repository, parsed.visibility, NodeProcess.cwd(), env),
            "GitHub repository creation failed.",
          );
        const visibility = yield* tryExternal(
          () => transport.inspect(parsed.repository, NodeProcess.cwd(), env),
          "GitHub repository could not be verified.",
        );
        if (visibility === "public" && !parsed.publicExposureAcknowledged)
          return yield* invalid("Acknowledge that portable Organization records will be public.");
        yield* tryExternal(
          () =>
            transport.withClone(parsed.repository, env, async (directory) => {
              const identity = await readRepositoryIdentity(directory);
              if (identity !== null && identity !== parsed.organizationId)
                throw new Error("Repository belongs to another Organization.");
              await readRepositoryRecords(directory, parsed.organizationId);
            }),
          "GitHub repository contents could not be validated.",
        );
        const linkedAt = yield* now;
        yield* sql`INSERT INTO organization_repositories
      (organization_id,repository,visibility,github_account_id,auto_sync_enabled,public_exposure_acknowledged,next_sync_at,linked_by,linked_at)
      VALUES (${parsed.organizationId},${parsed.repository},${visibility},
        ${parsed.githubAccountId ?? null},${parsed.autoSync === true ? 1 : 0},${parsed.publicExposureAcknowledged === true ? 1 : 0},${linkedAt},
        ${principal.subject},${linkedAt})`.pipe(
          Effect.mapError(() => issue("conflict", "Repository is already linked.")),
        );
        return yield* sync({ organizationId: parsed.organizationId }, principal);
      }),
    );
  const load: OrganizationRepositoryStoreShape["load"] = (input, principal) =>
    storeErrors(
      Effect.gen(function* () {
        yield* requireHuman(principal);
        const parsed = input;
        if (!validRepository(parsed.repository))
          return yield* invalid("Use a GitHub OWNER/REPO name.");
        const env = yield* accountEnvironment(parsed.githubAccountId);
        const visibility = yield* tryExternal(
          () => transport.inspect(parsed.repository, NodeProcess.cwd(), env),
          "GitHub repository could not be verified.",
        );
        if (visibility === "public" && !parsed.publicExposureAcknowledged)
          return yield* invalid(
            "Acknowledge that portable Organization records may be published publicly.",
          );
        const imported = yield* tryExternal(
          () =>
            transport.withClone(parsed.repository, env, async (directory, commit) => {
              const identity = await readRepositoryIdentity(directory);
              if (!identity)
                throw new Error("Repository does not contain an Organization identity.");
              return {
                organizationId: identity,
                records: await readRepositoryRecords(directory, identity),
                commit,
              };
            }),
          "GitHub repository contents could not be validated.",
        );
        const organizationId = yield* decodeOrganizationId(imported.organizationId).pipe(
          Effect.mapError(() => invalid("Repository Organization ID is invalid.")),
        );
        const configRecord = imported.records.get("configuration/current");
        if (!configRecord)
          return yield* invalid("Repository has no current Organization configuration.");
        const importedAt = yield* now;
        const c = configRecord.content;
        const draft = yield* decodeOrganization({
          id: organizationId,
          title: c.title,
          mission: c.mission,
          lifecycle: "draft",
          draftRevision: 1,
          publishedRevision: null,
          architectRoleId: c.architectRoleId,
          directorRoleId: c.directorRoleId,
          graph: c.graph,
          workflows: c.workflows,
          layout: c.layout,
          bindings: [],
          createdAt: importedAt,
          updatedAt: importedAt,
        }).pipe(Effect.mapError(() => invalid("Repository configuration is invalid.")));
        const problems = [
          ...validateOrganizationGraph(draft),
          ...draft.workflows.flatMap((workflow) =>
            validateOrganizationWorkflow(workflow, draft.graph.roles),
          ),
        ];
        if (problems.length)
          return yield* invalid(
            "Repository configuration has invalid role or workflow relationships.",
          );
        const existing = yield* sql<{
          organization_id: string;
        }>`SELECT organization_id FROM organizations
      WHERE organization_id = ${organizationId}`;
        if (existing.length)
          return yield* issue(
            "conflict",
            "Organization already exists locally. Link or sync it instead.",
          );
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO organizations (organization_id,title,mission,lifecycle,draft_revision,
        published_revision,architect_role_id,director_role_id,graph_json,workflows_json,layout_json,
        created_at,updated_at) VALUES (${organizationId},${draft.title},${draft.mission},${"draft"},
        ${1},${null},${draft.architectRoleId},${draft.directorRoleId},${encodeJson(draft.graph)},
        ${encodeJson(draft.workflows)},${encodeJson(draft.layout)},${importedAt},${importedAt})`;
              yield* sql`INSERT INTO organization_repositories
        (organization_id,repository,visibility,github_account_id,auto_sync_enabled,public_exposure_acknowledged,next_sync_at,
          last_accepted_commit,last_sync_at,linked_by,linked_at)
          VALUES (${organizationId},${parsed.repository},${visibility},
          ${parsed.githubAccountId ?? null},${parsed.autoSync === true ? 1 : 0},${parsed.publicExposureAcknowledged === true ? 1 : 0},${importedAt},
          ${imported.commit},${importedAt},${principal.subject},${importedAt})`;
              for (const [key, record] of imported.records) {
                const digest = recordDigest(record);
                yield* sql`INSERT INTO organization_repository_records
          (organization_id,record_key,remote_json,remote_digest,accepted_local_digest,
            accepted_remote_digest,state,updated_at)
          VALUES (${organizationId},${key},${recordJson(record)},${digest},${null},
            ${digest},${"incoming"},${importedAt})`;
              }
              yield* sql`INSERT INTO organization_audit
        (mutation_id,organization_id,actor,action,base_revision,applied_revision,payload_json,created_at)
        VALUES (${NodeCrypto.randomUUID()},${organizationId},${"user"},${"load-repository"},${0},${1},
          ${encodeJson({ repository: parsed.repository, actorSubject: principal.subject })},${importedAt})`;
              // The imported policy is a fresh local draft. Its transformed digest is the
              // local baseline, while the repository's original remains staged for review.
              const local = yield* collectOrganizationRepositoryRecords(sql, organizationId);
              for (const [key, record] of local)
                if (imported.records.has(key)) {
                  yield* sql`UPDATE organization_repository_records
                SET accepted_local_digest = ${recordDigest(record)}
                WHERE organization_id = ${organizationId} AND record_key = ${key}`;
                }
            }),
          )
          .pipe(
            Effect.mapError(() =>
              issue("conflict", "Repository could not be loaded into a local draft."),
            ),
          );
        return yield* status({ organizationId });
      }),
    );
  const listRecords: OrganizationRepositoryStoreShape["listRecords"] = (input) =>
    storeErrors(
      Effect.gen(function* () {
        const parsed = input;
        yield* checkedOrganization(parsed.organizationId);
        const limit = Math.min(100, Math.max(1, parsed.limit ?? 50));
        const rows = yield* sql<RecordRow>`SELECT * FROM organization_repository_records
      WHERE organization_id = ${parsed.organizationId}
        AND record_key > ${parsed.cursor ?? ""}
        AND (${parsed.kind ?? null} IS NULL OR record_key LIKE ${parsed.kind ? `${parsed.kind}/%` : "%"})
      ORDER BY record_key LIMIT ${limit + 1}`;
        const page = rows.slice(0, limit);
        const records = yield* Effect.forEach(page, (row) =>
          decodeRecord(decodeJson(row.remote_json)).pipe(
            Effect.mapError(() => unavailable()),
            Effect.map((record) => ({
              recordKey: row.record_key,
              record,
              state: row.state,
              remoteDigest: row.remote_digest,
            })),
          ),
        );
        return {
          records,
          nextCursor: rows.length > limit ? (page.at(-1)?.record_key ?? null) : null,
        };
      }),
    );
  const resolveConflict: OrganizationRepositoryStoreShape["resolveConflict"] = (input, principal) =>
    storeErrors(
      Effect.gen(function* () {
        yield* requireHuman(principal);
        const parsed = input;
        const row = (yield* sql<RecordRow>`SELECT * FROM organization_repository_records
      WHERE organization_id = ${parsed.organizationId} AND record_key = ${parsed.recordKey}`)[0];
        if (!row || row.state !== "conflict")
          return yield* issue("not_found", "Repository conflict was not found.");
        if (row.remote_digest !== parsed.expectedRemoteDigest)
          return yield* issue("conflict", "Remote record changed. Sync before resolving it.");
        const local = yield* collectOrganizationRepositoryRecords(sql, parsed.organizationId).pipe(
          Effect.mapError(() => unavailable()),
        );
        const localDigest = local.get(parsed.recordKey)
          ? recordDigest(local.get(parsed.recordKey)!)
          : null;
        if (parsed.choice === "local" && !localDigest)
          return yield* invalid("No local record exists for this conflict.");
        const changed = yield* sql<{
          record_key: string;
        }>`UPDATE organization_repository_records SET resolution = ${parsed.choice},
      state = ${parsed.choice === "remote" ? "incoming" : "conflict"},
      accepted_local_digest = ${parsed.choice === "remote" ? localDigest : row.accepted_local_digest},
      accepted_remote_digest = ${parsed.choice === "remote" ? row.remote_digest : row.accepted_remote_digest},
      updated_at = ${yield* now}
      WHERE organization_id = ${parsed.organizationId} AND record_key = ${parsed.recordKey}
        AND remote_digest = ${parsed.expectedRemoteDigest} AND state = ${"conflict"}
      RETURNING record_key`;
        if (changed.length !== 1)
          return yield* issue("conflict", "Repository conflict changed. Sync before resolving it.");
        return parsed.choice === "local"
          ? yield* sync({ organizationId: parsed.organizationId }, principal)
          : yield* status({ organizationId: parsed.organizationId });
      }),
    );
  return {
    preview,
    link,
    load,
    sync,
    syncBackground,
    status,
    listRecords,
    resolveConflict,
  } satisfies OrganizationRepositoryStoreShape;
});
export const OrganizationRepositoryStoreLive = Layer.effect(OrganizationRepositoryStore, make);
