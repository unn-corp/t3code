import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import discordBridge from "./036_DiscordBridge.ts";
import backfillLatestTurn from "./037_BackfillProjectionThreadsLatestTurn.ts";
import projectionThreadsPinned from "./038_ProjectionThreadsPinned.ts";
import canonicalizeLegacyReviewRuntimeMode from "./039_CanonicalizeLegacyReviewRuntimeMode.ts";
import projectionTurnsKeysetIndex from "./040_ProjectionTurnsKeysetIndex.ts";
import projectionProjectGitHubAccount from "./047_ProjectionProjectGitHubAccount.ts";

// Old desktop ledgers reused these IDs for different migrations. Reapply the
// idempotent implementations at a new ID without rewriting historical records
// or deleting the older context/title-state columns and their user data.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const earlier = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id,name FROM effect_sql_migrations WHERE migration_id IN (36,37)
  `;
  if (earlier.some((row) => row.migration_id === 36 && row.name === "ProjectionThreadsPinned")) {
    yield* discordBridge;
  }
  if (earlier.some((row) => row.migration_id === 37 && row.name === "ProjectionTurnsKeysetIndex")) {
    yield* backfillLatestTurn;
  }
  yield* projectionThreadsPinned;
  yield* canonicalizeLegacyReviewRuntimeMode;
  yield* projectionTurnsKeysetIndex;
  yield* projectionProjectGitHubAccount;
});
