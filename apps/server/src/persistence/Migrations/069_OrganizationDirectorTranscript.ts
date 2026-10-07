import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_director_requests (
    request_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    project_id TEXT,
    actor_subject TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX organization_director_requests_by_org
    ON organization_director_requests(organization_id, project_id, created_at)`;
  yield* sql`CREATE TABLE organization_director_messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    project_id TEXT,
    request_id TEXT NOT NULL REFERENCES organization_director_requests(request_id),
    role TEXT NOT NULL CHECK (role IN ('user', 'director')),
    text TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (request_id, role)
  )`;
  yield* sql`CREATE INDEX organization_director_messages_by_scope
    ON organization_director_messages(organization_id, project_id, sequence)`;
});
