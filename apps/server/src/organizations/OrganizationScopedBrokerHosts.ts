// @effect-diagnostics nodeBuiltinImport:off - Server-owned scoped execution adapters.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { organizationScopeLaunchBrokerClient } from "./OrganizationScopeLaunchBroker.ts";
import {
  allocateOrganizationScopedUnitName,
  stopAndVerifyOrganizationScopedSandbox,
} from "./OrganizationScopedSandboxHost.ts";
import {
  OrganizationSingleFileAttemptError,
  OrganizationSingleFileAttemptHost,
} from "./OrganizationSingleFileAttemptCoordinator.ts";
import { OrganizationSingleFileQAHost } from "./OrganizationSingleFileQACoordinator.ts";
import { evaluateOrganizationSingleFileQA } from "./OrganizationSingleFileQAEvaluator.ts";

const unavailable = (message: string) =>
  new OrganizationSingleFileAttemptError({ code: "unavailable", message });

/** A reviewed worker policy can supply this layer. It never calls systemd-run
 * in the server process; reserve is durable before launch-requested is saved.
 */
export const organizationSingleFileAttemptBrokerHost = (baseDir: string) => {
  const broker = organizationScopeLaunchBrokerClient(baseDir);
  return Layer.succeed(OrganizationSingleFileAttemptHost, {
    reserve: (attemptId, unitName) => broker.reserve(attemptId, unitName),
    prepare: ({ attemptId, ...input }) => broker.prepare(attemptId, input),
    verifyStopped: (identity) =>
      Effect.tryPromise({
        try: () => stopAndVerifyOrganizationScopedSandbox(identity),
        catch: () => unavailable("Exact scoped worker stop could not be verified."),
      }),
  });
};

/** QA gets a distinct journal operation for every probe. An uncertain
 * post-dispatch result remains held by the broker across process restarts.
 */
export const organizationSingleFileQABrokerHost = (baseDir: string) => {
  const broker = organizationScopeLaunchBrokerClient(baseDir);
  return Layer.succeed(OrganizationSingleFileQAHost, {
    evaluate: (attemptId, input) =>
      evaluateOrganizationSingleFileQA(input, async (sandboxInput) => {
        const attemptDigest = NodeCrypto.createHash("sha256").update(attemptId).digest("hex");
        const operationId = `org-qa:${attemptDigest}:${NodeCrypto.randomUUID()}`;
        const reservedUnitName = allocateOrganizationScopedUnitName();
        await broker.reserve(operationId, reservedUnitName);
        return broker.prepare(operationId, { ...sandboxInput, reservedUnitName });
      }),
  });
};
