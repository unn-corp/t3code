import * as Layer from "effect/Layer";
import {
  OrganizationWorkApprovalReceiptStoreLive,
  OrganizationWorkApprovalVerifierFromReceipts,
} from "./OrganizationWorkApprovalReceiptStore.ts";
import {
  OrganizationWorkArtifactStoreLive,
  OrganizationWorkArtifactVerifierFromStore,
} from "./OrganizationWorkArtifactStore.ts";
import {
  OrganizationWorkIntegrationReceiptStoreLive,
  OrganizationWorkIntegrationVerifierFromReceipts,
} from "./OrganizationWorkIntegrationReceiptStore.ts";
import {
  OrganizationWorkEvaluationVerifierFromQAReceipts,
  OrganizationWorkQAReceiptStoreLive,
} from "./OrganizationWorkQAReceiptStore.ts";
import {
  OrganizationWorkExecutionDisabled,
  OrganizationWorkStoreLayer,
} from "./OrganizationWorkStore.ts";

const evidenceStores = OrganizationWorkApprovalReceiptStoreLive.pipe(
  Layer.provideMerge(
    OrganizationWorkQAReceiptStoreLive.pipe(Layer.provideMerge(OrganizationWorkArtifactStoreLive)),
  ),
  Layer.provide(OrganizationWorkArtifactStoreLive),
);

const receiptStores = OrganizationWorkIntegrationReceiptStoreLive.pipe(
  Layer.provideMerge(evidenceStores),
);

const persistedVerifiers = Layer.mergeAll(
  OrganizationWorkArtifactVerifierFromStore,
  OrganizationWorkEvaluationVerifierFromQAReceipts,
  OrganizationWorkApprovalVerifierFromReceipts,
  OrganizationWorkIntegrationVerifierFromReceipts,
).pipe(Layer.provide(receiptStores));

/** Live reads use persisted evidence; work mutation and evidence capture remain denied. */
export const OrganizationWorkStoreReadOnlyLive = OrganizationWorkStoreLayer.pipe(
  Layer.provide(OrganizationWorkExecutionDisabled),
  Layer.provide(persistedVerifiers),
);
