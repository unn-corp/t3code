import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { OrganizationId } from "@t3tools/contracts";
import { OrganizationRepositoryStore } from "./OrganizationRepositoryStore.ts";

export interface OrganizationRepositorySyncCoordinatorShape {
  readonly runOnce: () => Effect.Effect<number, SqlError>;
}
export class OrganizationRepositorySyncCoordinator extends Context.Service<
  OrganizationRepositorySyncCoordinator,
  OrganizationRepositorySyncCoordinatorShape
>()("t3/organizations/OrganizationRepositorySyncLoop/OrganizationRepositorySyncCoordinator") {}

export const OrganizationRepositorySyncCoordinatorLive = Layer.effect(
  OrganizationRepositorySyncCoordinator,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repositories = yield* OrganizationRepositoryStore;
    const runOnce: OrganizationRepositorySyncCoordinatorShape["runOnce"] = () =>
      Effect.gen(function* () {
        const current = DateTime.formatIso(yield* DateTime.now);
        const due = yield* sql<{ organization_id: string }>`SELECT organization_id
        FROM organization_repositories WHERE auto_sync_enabled = 1
          AND (next_sync_at IS NULL OR next_sync_at <= ${current})
        ORDER BY next_sync_at, organization_id LIMIT 4`;
        for (const row of due) {
          yield* repositories
            .syncBackground({ organizationId: OrganizationId.make(row.organization_id) })
            .pipe(Effect.ignoreCause({ log: false }));
        }
        return due.length;
      });
    return { runOnce };
  }),
);

/** The link stores consent; this loop resumes after a server restart. */
export const OrganizationRepositorySyncLoopLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const coordinator = yield* OrganizationRepositorySyncCoordinator;
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* coordinator.runOnce().pipe(Effect.ignoreCause({ log: false }));
        yield* Effect.sleep("60 seconds");
      }),
    ).pipe(Effect.forkScoped);
  }),
);
