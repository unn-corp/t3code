import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** One immutable, human-selected activation per saved intent. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_work_intent_activations (
    intent_id TEXT PRIMARY KEY REFERENCES organization_work_intents(intent_id),
    organization_id TEXT NOT NULL REFERENCES organizations(organization_id),
    work_id TEXT NOT NULL UNIQUE REFERENCES organization_work_items(work_id),
    selection_json TEXT NOT NULL CHECK (json_valid(selection_json)
      AND length(CAST(selection_json AS BLOB)) <= 24576),
    activated_by TEXT NOT NULL CHECK (length(activated_by) BETWEEN 1 AND 160),
    activated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX organization_work_intent_activations_by_organization
    ON organization_work_intent_activations(organization_id, activated_at, intent_id)`;
  yield* sql`CREATE TRIGGER organization_work_intent_activation_matches_work
    BEFORE INSERT ON organization_work_intent_activations
    WHEN NOT EXISTS (
      SELECT 1 FROM organization_work_items work
      JOIN organization_work_intents intent ON intent.intent_id = NEW.intent_id
      WHERE work.work_id = NEW.work_id
        AND work.organization_id = NEW.organization_id
        AND intent.organization_id = NEW.organization_id
        AND work.finding_id = intent.finding_id
        AND work.project_id = intent.project_id
        AND work.binding_id = intent.binding_id
        AND work.binding_version = intent.binding_version
        AND work.published_revision = intent.published_revision
        AND work.creator_subject = NEW.activated_by
    )
    BEGIN SELECT RAISE(ABORT, 'Organization work activation target differs from its intent'); END`;
  yield* sql`CREATE TRIGGER organization_work_intent_activations_immutable
    BEFORE UPDATE ON organization_work_intent_activations
    BEGIN SELECT RAISE(ABORT, 'Organization work activation is immutable'); END`;
  yield* sql`CREATE TRIGGER organization_work_intent_activations_no_delete
    BEFORE DELETE ON organization_work_intent_activations
    BEGIN SELECT RAISE(ABORT, 'Organization work activation cannot be deleted'); END`;
});
