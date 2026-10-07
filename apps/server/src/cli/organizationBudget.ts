// @effect-diagnostics nodeBuiltinImport:off - The local OS account identifies the CLI administrator in the audit row.
import * as NodeOS from "node:os";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag } from "effect/cli";

import { deriveServerPaths } from "../config.ts";
import {
  OrganizationProviderBudgetConfiguration,
  OrganizationProviderBudgetConfigurationAuthority,
  OrganizationProviderBudgetConfigurationWithAuthority,
  type OrganizationProviderBudgetConfigurationRecord,
  type OrganizationProviderBudgetLimits,
} from "../organizations/OrganizationProviderBudgetConfiguration.ts";

const globalScope = { kind: "global" } as const;

export class OrganizationBudgetStateError extends Schema.TaggedError<OrganizationBudgetStateError>()(
  "OrganizationBudgetStateError",
  { message: Schema.String },
) {}

const baseDirFlag = Flag.String("base-dir").pipe(
  Flag.withDescription("Absolute Arcwright Code data directory containing userdata/state.sqlite."),
);

/** This authority exists only in a local CLI process and only for the shared ceiling. */
const localActorId = `host-admin-cli:${NodeOS.userInfo().username}`;
const localGlobalAuthority = Layer.succeed(OrganizationProviderBudgetConfigurationAuthority, {
  authenticatedHumanId: localActorId,
  projectOrganizationId: null,
  permitsRead: (scope: { readonly kind: string }) => scope.kind === "global",
  permitsGlobalUpdate: (update: { readonly scope: { readonly kind: string } }) =>
    update.scope.kind === "global",
  permitsScopedUpdate: () => false,
});

const withExistingState = <A, E>(
  baseDir: string,
  readonly: boolean,
  action: Effect.Effect<A, E, OrganizationProviderBudgetConfiguration | SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    if (!path.isAbsolute(baseDir) || baseDir.trim().length === 0) {
      return yield* new OrganizationBudgetStateError({
        message:
          "--base-dir must be an absolute path to an existing Arcwright Code data directory.",
      });
    }
    const { dbPath } = yield* deriveServerPaths(path.resolve(baseDir), undefined, {
      baseDirIsExplicit: true,
    });
    if (!(yield* fs.exists(dbPath))) {
      return yield* new OrganizationBudgetStateError({
        message: `No initialized Arcwright Code database exists at ${dbPath}. Start Arcwright Code with this --base-dir first.`,
      });
    }

    const persistence = NodeSqliteClient.layer({ filename: dbPath, readonly });
    const configuration = OrganizationProviderBudgetConfigurationWithAuthority.pipe(
      Layer.provide(localGlobalAuthority),
    );
    return yield* action.pipe(Effect.provide(configuration.pipe(Layer.provideMerge(persistence))));
  });

export const readGlobalOrganizationBudget = (baseDir: string) =>
  withExistingState(
    baseDir,
    true,
    Effect.gen(function* () {
      const configuration = yield* OrganizationProviderBudgetConfiguration;
      const current = yield* configuration.get(globalScope);
      if (current === null) {
        return yield* new OrganizationBudgetStateError({
          message: "The initialized database has no global Organization provider ceiling.",
        });
      }
      return current;
    }),
  );

export const updateGlobalOrganizationBudget = (input: {
  readonly baseDir: string;
  readonly expectedRevision: string;
  readonly limits: OrganizationProviderBudgetLimits;
}) =>
  withExistingState(
    input.baseDir,
    false,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 5000`;
      const configuration = yield* OrganizationProviderBudgetConfiguration;
      return yield* configuration.update({
        scope: globalScope,
        expectedRevision: input.expectedRevision,
        limits: input.limits,
      });
    }),
  );

const format = (record: OrganizationProviderBudgetConfigurationRecord) =>
  JSON.stringify({
    maxConcurrent: record.maxConcurrent,
    maxDailyCalls: record.maxDailyCalls,
    maxDailyEstimatedTokens: record.maxDailyEstimatedTokens,
    revision: record.revision,
  });

const show = Command.make("show", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Read the shared Organization provider ceiling from local state."),
  Command.withHandler(({ baseDir }) =>
    readGlobalOrganizationBudget(baseDir).pipe(
      Effect.flatMap((record) => Console.log(format(record))),
    ),
  ),
);

const set = Command.make("set", {
  baseDir: baseDirFlag,
  expectedRevision: Flag.String("expected-revision").pipe(
    Flag.withDescription("Revision returned by show; required for a concurrent-safe update."),
  ),
  maxConcurrent: Flag.Int("max-concurrent"),
  maxDailyCalls: Flag.Int("max-daily-calls"),
  maxDailyEstimatedTokens: Flag.Int("max-daily-estimated-tokens"),
}).pipe(
  Command.withDescription("Set the shared Organization provider ceiling in local state."),
  Command.withHandler((flags) =>
    updateGlobalOrganizationBudget({
      baseDir: flags.baseDir,
      expectedRevision: flags.expectedRevision,
      limits: {
        maxConcurrent: flags.maxConcurrent,
        maxDailyCalls: flags.maxDailyCalls,
        maxDailyEstimatedTokens: flags.maxDailyEstimatedTokens,
      },
    }).pipe(Effect.flatMap((record) => Console.log(format(record)))),
  ),
);

export const organizationBudgetCommand = Command.make("organization-budget").pipe(
  Command.withDescription("Manage the host-local shared Organization provider ceiling."),
  Command.withSubcommands([show, set]),
);
