import * as Schema from "effect/Schema";
import { IsoDateTime } from "./baseSchemas.ts";
import { OrganizationId } from "./organizations.ts";
import { OrganizationWorkAttemptId, OrganizationWorkId } from "./organizationWork.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const FullOid = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));

export const OrganizationWorkApprovalDecisionInput = Schema.Struct({
  organizationId: OrganizationId,
  workId: OrganizationWorkId,
  attemptId: OrganizationWorkAttemptId,
  requestId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/)),
  approved: Schema.Boolean,
  reason: Schema.String.check(Schema.isMaxLength(2_000)),
  artifactDigest: Digest,
  qaReceiptDigest: Digest,
  baseCodeRevision: FullOid,
  bindingVersion: IsoDateTime,
  projectRootDigest: Digest,
});
export type OrganizationWorkApprovalDecisionInput =
  typeof OrganizationWorkApprovalDecisionInput.Type;
