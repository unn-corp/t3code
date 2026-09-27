import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_architect_requests (
    request_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    actor_subject TEXT NOT NULL,
    base_revision INTEGER NOT NULL CHECK (base_revision > 0),
    input_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
    failure_message TEXT,
    completion_digest TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX organization_architect_requests_by_org
    ON organization_architect_requests(organization_id, created_at, request_id)`;
  yield* sql`CREATE UNIQUE INDEX organization_architect_one_pending_per_org
    ON organization_architect_requests(organization_id) WHERE status = 'pending'`;
  yield* sql`CREATE TABLE organization_architect_messages (
    message_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    request_id TEXT NOT NULL REFERENCES organization_architect_requests(request_id),
    role TEXT NOT NULL CHECK (role IN ('user', 'architect')),
    text TEXT NOT NULL,
    base_revision INTEGER NOT NULL CHECK (base_revision > 0),
    model_selection_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (request_id, role)
  )`;
  yield* sql`CREATE INDEX organization_architect_messages_by_org
    ON organization_architect_messages(organization_id, created_at, message_id)`;
  yield* sql`CREATE TABLE organization_architect_proposals (
    proposal_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    request_id TEXT NOT NULL REFERENCES organization_architect_requests(request_id),
    response_message_id TEXT NOT NULL REFERENCES organization_architect_messages(message_id),
    position INTEGER NOT NULL CHECK (position >= 0),
    base_revision INTEGER NOT NULL CHECK (base_revision > 0),
    change_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (request_id, position)
  )`;
  yield* sql`CREATE INDEX organization_architect_proposals_by_request
    ON organization_architect_proposals(request_id, proposal_id)`;
});
