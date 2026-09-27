// @effect-diagnostics nodeBuiltinImport:off - Server-owned scoped execution adapters.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
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

type BrokerClient = Pick<
  ReturnType<typeof organizationScopeLaunchBrokerClient>,
  "reserve" | "prepare" | "status"
>;

/** One scope at a time for the first live slice. The broker journal remains
 * authoritative across restarts; this latch also fences concurrent calls in
 * one server process and stays held when a reply may have been lost.
 */
const activeScopeByBaseDir = new Map<string, string>();
/** The journal operation itself durably binds each QA launch to its attempt. */
export const organizationQABrokerOperationPrefix = (attemptId: string) =>
  `org-qa:${NodeCrypto.createHash("sha256").update(attemptId).digest("hex")}:`;
const brokerHostGate = (baseDir: string, broker: BrokerClient) => {
  const key = NodePath.resolve(baseDir);
  const release = (operationId: string) => {
    if (activeScopeByBaseDir.get(key) === operationId) activeScopeByBaseDir.delete(key);
  };
  const reserve = async (operationId: string, unitName: string): Promise<void> => {
    if (activeScopeByBaseDir.has(key))
      throw unavailable("A scoped worker or QA launch is still unresolved.");
    activeScopeByBaseDir.set(key, operationId);
    let reserveRequested = false;
    try {
      const journal = await broker.status();
      if (journal.some((entry) => entry.phase !== "stopped" && entry.phase !== "never-dispatched"))
        throw unavailable("Broker journal has an unresolved scoped launch.");
      // A missing reserve reply is ambiguous: leave the latch held until
      // process restart and broker journal recovery, even if no handle exists.
      reserveRequested = true;
      await broker.reserve(operationId, unitName);
    } catch (error) {
      if (!reserveRequested) release(operationId);
      throw error;
    }
  };
  const prepare = async (operationId: string, input: Parameters<BrokerClient["prepare"]>[1]) => {
    if (activeScopeByBaseDir.get(key) !== operationId)
      throw unavailable("Scoped launch has no current host reservation.");
    const handle = await broker.prepare(operationId, input);
    const terminal = <T>(finish: () => Promise<T>): Promise<T> =>
      finish().then((result) => {
        // The broker only acknowledges after its exact-stop journal record
        // is durable. A rejected or lost reply keeps the launch fenced.
        release(operationId);
        return result;
      });
    return {
      ...handle,
      wait: () => terminal(handle.wait),
      stop: () => terminal(handle.stop),
      discard: () => terminal(handle.discard),
    };
  };
  return { reserve, prepare };
};

/** A reviewed worker policy can supply this layer. It never calls systemd-run
 * in the server process; reserve is durable before launch-requested is saved.
 */
export const organizationSingleFileAttemptBrokerHost = (
  baseDir: string,
  broker: BrokerClient = organizationScopeLaunchBrokerClient(baseDir),
) => {
  const gate = brokerHostGate(baseDir, broker);
  return Layer.succeed(OrganizationSingleFileAttemptHost, {
    reserve: (attemptId, unitName) => gate.reserve(attemptId, unitName),
    prepare: ({ attemptId, ...input }) => gate.prepare(attemptId, input),
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
export const organizationSingleFileQABrokerHost = (
  baseDir: string,
  broker: BrokerClient = organizationScopeLaunchBrokerClient(baseDir),
) => {
  const gate = brokerHostGate(baseDir, broker);
  return Layer.succeed(OrganizationSingleFileQAHost, {
    evaluate: (attemptId, input) =>
      evaluateOrganizationSingleFileQA(input, async (sandboxInput) => {
        const operationId = `${organizationQABrokerOperationPrefix(attemptId)}${NodeCrypto.randomUUID()}`;
        const reservedUnitName = allocateOrganizationScopedUnitName();
        await gate.reserve(operationId, reservedUnitName);
        return gate.prepare(operationId, { ...sandboxInput, reservedUnitName });
      }),
  });
};
