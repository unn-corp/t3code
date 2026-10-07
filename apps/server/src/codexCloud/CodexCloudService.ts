// @effect-diagnostics nodeBuiltinImport:off -- UUIDs and constant-time comparisons stay inside service effects.
import * as NodeCrypto from "node:crypto";
import {
  CodexCloudBinding,
  CodexCloudCommandInput,
  CodexCloudError,
  CodexCloudRun,
  CodexCloudSnapshot,
  CodexCloudWorker,
  CodexCloudWorkerSetupInput,
  CodexCloudWorkerSetupResult,
  ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as CloudCli from "./CodexCloudCli.ts";
import { cloudSubmissionReference, validateControllerOrigin } from "./cloudTaskOutput.ts";
import { cloudWorkerSource } from "./cloudWorkerSource.ts";

const State = Schema.Struct({
  version: Schema.Literal(1),
  bindings: Schema.Record(Schema.String, CodexCloudBinding),
  runs: Schema.Array(CodexCloudRun),
  workers: Schema.Array(CodexCloudWorker),
});
type State = typeof State.Type;
const decodeState = Schema.decodeEffect(Schema.fromJsonString(State));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(State));
const isCloudError = Schema.is(CodexCloudError);
export const WorkerPollInput = Schema.Struct({
  instanceId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,160}$/)),
  agents: Schema.Array(Schema.Literals(["codex", "claude"])),
  activeRunId: Schema.NullOr(Schema.String),
});
export const WorkerEventInput = Schema.Struct({
  instanceId: WorkerPollInput.fields.instanceId,
  runId: Schema.String,
  sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  output: Schema.String.check(Schema.isMaxLength(60_000)),
  status: Schema.Literals(["running", "completed", "failed", "cancelled"]),
  sessionId: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,160}$/))),
});
export class CodexCloudService extends Context.Service<
  CodexCloudService,
  {
    readonly read: (projectId: ProjectId) => Effect.Effect<CodexCloudSnapshot, CodexCloudError>;
    readonly command: (
      input: CodexCloudCommandInput,
    ) => Effect.Effect<{ snapshot: CodexCloudSnapshot; output: string }, CodexCloudError>;
    readonly setupWorker: (
      input: typeof CodexCloudWorkerSetupInput.Type,
    ) => Effect.Effect<typeof CodexCloudWorkerSetupResult.Type, CodexCloudError>;
    readonly pollWorker: (
      credential: string,
      input: typeof WorkerPollInput.Type,
    ) => Effect.Effect<{ job: CodexCloudRun | null; cancel: boolean }, CodexCloudError>;
    readonly workerEvent: (
      credential: string,
      input: typeof WorkerEventInput.Type,
    ) => Effect.Effect<{ accepted: boolean }, CodexCloudError>;
  }
>()("t3/codexCloud/CodexCloudService") {}

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const epoch = (value: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(value));
const snapshot = (state: State, projectId: ProjectId): CodexCloudSnapshot => ({
  binding: state.bindings[projectId] ?? null,
  runs: state.runs
    .filter((r) => r.projectId === projectId)
    .slice(-30)
    .toReversed()
    .map((r) => ({ ...r, prompt: r.prompt.slice(0, 500), output: r.output.slice(-2_000) })),
  workers: state.workers
    .filter((w) => w.projectId === projectId)
    .slice(-30)
    .toReversed(),
});
const terminal = (status: CodexCloudRun["status"]) =>
  ["completed", "failed", "cancelled"].includes(status);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const secrets = yield* Secrets.ServerSecretStore;
  const cli = yield* CloudCli.CodexCloudCli;
  const lock = yield* Semaphore.make(1);
  const file = path.join(config.stateDir, "codex-cloud.json");
  const storage = () => new CodexCloudError({ code: "storage" });
  const load = fs.readFileString(file).pipe(
    Effect.flatMap(decodeState),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed<State>({ version: 1, bindings: {}, runs: [], workers: [] })
          : Effect.fail(storage()),
    }),
    Effect.mapError((cause) => (isCloudError(cause) ? cause : storage())),
  );
  const save = Effect.fn("CodexCloudService.save")(function* (state: State) {
    const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fs.makeDirectory(config.stateDir, { recursive: true }).pipe(Effect.mapError(storage));
    yield* fs
      .writeFileString(temp, yield* encodeState(state).pipe(Effect.mapError(storage)), {
        mode: 0o600,
      })
      .pipe(
        Effect.flatMap(() => fs.rename(temp, file)),
        Effect.mapError(storage),
        Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)),
      );
  });
  const project = (id: ProjectId) =>
    projects.get(id).pipe(
      Effect.mapError(() => new CodexCloudError({ code: "configuration" })),
      Effect.flatMap((row) =>
        Option.isSome(row) && row.value.deletedAt === null
          ? Effect.succeed(row.value)
          : Effect.fail(new CodexCloudError({ code: "configuration" })),
      ),
    );
  const authenticate = Effect.fn("CodexCloudService.authenticate")(function* (
    state: State,
    credential: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const match = /^([a-zA-Z0-9_-]{1,160})\.([a-f0-9]{64})$/.exec(credential);
    if (!match) return yield* new CodexCloudError({ code: "unauthorized" });
    const worker = state.workers.find((w) => w.id === match[1]);
    if (!worker || worker.revoked || epoch(worker.expiresAt) <= now)
      return yield* new CodexCloudError({ code: "unauthorized" });
    const secret = yield* secrets
      .get(`codex-cloud-worker-${worker.id}`)
      .pipe(Effect.mapError(storage));
    if (
      Option.isNone(secret) ||
      secret.value.length !== 32 ||
      !NodeCrypto.timingSafeEqual(Buffer.from(match[2]!, "hex"), secret.value)
    )
      return yield* new CodexCloudError({ code: "unauthorized" });
    yield* project(worker.projectId);
    return worker;
  });
  const read = (projectId: ProjectId) =>
    project(projectId).pipe(
      Effect.flatMap(() => load),
      Effect.map((state) => snapshot(state, projectId)),
    );
  const command = Effect.fn("CodexCloudService.command")(function* (input: CodexCloudCommandInput) {
    const now = yield* Clock.currentTimeMillis;
    const checkout = yield* project(input.projectId);
    let state = yield* load;
    let output = "";
    if (input.action === "save") {
      if (input.binding) yield* cli.identity(input.binding);
      const bindings = { ...state.bindings };
      if (input.binding) bindings[input.projectId] = input.binding;
      else delete bindings[input.projectId];
      state = { ...state, bindings };
      yield* save(state);
    } else if (input.action === "probe") {
      output = yield* cli.run(
        input.binding,
        ["list", "--json", "--limit", "5", "--env", input.binding.environmentId],
        checkout.workspaceRoot,
      );
      // An empty task list establishes account connectivity, not environment membership.
      output =
        "Account cloud API responded. Verify the environment ID in ChatGPT before launching.\n" +
        output;
    } else if (input.action === "submit") {
      const previous = state.runs.find((r) => r.id === input.requestId);
      if (previous) {
        if (
          previous.projectId !== input.projectId ||
          previous.mode !== input.mode ||
          previous.agent !== input.agent ||
          previous.prompt !== input.prompt ||
          previous.workerId !== (input.mode === "worker" ? (input.workerId ?? null) : null) ||
          previous.continueRunId !== (input.continueRunId ?? null)
        )
          return yield* new CodexCloudError({ code: "task" });
        return {
          snapshot: snapshot(state, input.projectId),
          output: "This request was already recorded; no duplicate task was submitted.",
        };
      }
      const binding = state.bindings[input.projectId];
      if (!binding || !input.prompt.trim())
        return yield* new CodexCloudError({ code: "configuration" });
      const fingerprint = yield* cli.identity(binding);
      const worker = state.workers.find(
        (w) =>
          w.id === input.workerId &&
          w.projectId === input.projectId &&
          !w.revoked &&
          epoch(w.expiresAt) > now &&
          w.binding.providerInstanceId === binding.providerInstanceId &&
          w.binding.environmentId === binding.environmentId &&
          w.accountFingerprint === fingerprint &&
          w.agents.includes(input.agent) &&
          w.lastSeen !== null &&
          now - epoch(w.lastSeen) < 30_000,
      );
      if (input.mode === "worker" && !worker) return yield* new CodexCloudError({ code: "worker" });
      if (input.mode === "cloud" && (input.agent !== "codex" || input.continueRunId))
        return yield* new CodexCloudError({ code: "configuration" });
      const continued = input.continueRunId
        ? state.runs.find((r) => r.id === input.continueRunId)
        : undefined;
      if (
        input.continueRunId &&
        (!continued ||
          continued.projectId !== input.projectId ||
          continued.mode !== "worker" ||
          continued.workerId !== worker?.id ||
          continued.agent !== input.agent ||
          continued.accountFingerprint !== fingerprint ||
          !continued.sessionId ||
          !terminal(continued.status))
      )
        return yield* new CodexCloudError({ code: "task" });
      const run: CodexCloudRun = {
        id: input.requestId,
        projectId: input.projectId,
        binding,
        accountFingerprint: fingerprint,
        mode: input.mode,
        agent: input.agent,
        prompt: input.prompt,
        createdAt: iso(now),
        status: input.mode === "cloud" ? "submitting" : "queued",
        taskId: null,
        url: null,
        workerId: worker?.id ?? null,
        sessionId: continued?.sessionId ?? null,
        continueRunId: input.continueRunId ?? null,
        output: "",
        eventSequence: 0,
      };
      state = { ...state, runs: [...state.runs, run] };
      // Persist intent first. A lost CLI response remains uncertain and is never retried automatically.
      yield* save(state);
      if (input.mode === "cloud")
        return { snapshot: snapshot(state, input.projectId), output: "", launch: run };
    } else {
      const run = state.runs.find((r) => r.id === input.runId && r.projectId === input.projectId);
      if (!run) return yield* new CodexCloudError({ code: "task" });
      if (input.action === "cancel") {
        if (run.mode !== "worker") return yield* new CodexCloudError({ code: "configuration" });
        state = {
          ...state,
          runs: state.runs.map((r) =>
            r.id === run.id && !terminal(r.status) ? { ...r, status: "cancelled" as const } : r,
          ),
        };
        yield* save(state);
        output =
          "Cancellation recorded; a connected worker stops the running process on its next heartbeat.";
      } else if (run.mode === "cloud") {
        if (!run.taskId) return yield* new CodexCloudError({ code: "task" });
        output = yield* cli.run(
          run.binding,
          [input.action, run.taskId],
          checkout.workspaceRoot,
          run.accountFingerprint,
        );
      } else output = run.output;
    }
    return { snapshot: snapshot(state, input.projectId), output };
  });
  // Never hold the state lock across a cloud launch: worker heartbeats must remain responsive.
  const executeCommand = Effect.fn("CodexCloudService.executeCommand")(function* (
    input: CodexCloudCommandInput,
  ) {
    const result = yield* ["probe", "status", "diff"].includes(input.action)
      ? command(input)
      : lock.withPermits(1)(command(input));
    if (!("launch" in result) || !result.launch) return result;
    const run = result.launch;
    const checkout = yield* project(run.projectId);
    const args = [
      "exec",
      "--env",
      run.binding.environmentId,
      ...(run.binding.branch ? ["--branch", run.binding.branch] : []),
      "--",
      run.prompt,
    ];
    const launched = yield* cli
      .run(run.binding, args, checkout.workspaceRoot, run.accountFingerprint)
      .pipe(Effect.result);
    const ref = launched._tag === "Success" ? cloudSubmissionReference(launched.success) : null;
    const unavailableMessage =
      launched._tag === "Failure" && launched.failure.code === "environment"
        ? launched.failure.message
        : null;
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* load;
        const updated: CodexCloudRun = {
          ...run,
          status: ref ? "submitted" : unavailableMessage ? "failed" : "unknown",
          taskId: ref?.taskId ?? null,
          url: ref?.url ?? null,
          output: ref
            ? "Cloud task submitted."
            : (unavailableMessage ??
              "Submission outcome is uncertain. Check this account in ChatGPT before starting another task."),
        };
        const next = { ...state, runs: state.runs.map((r) => (r.id === run.id ? updated : r)) };
        yield* save(next);
        return { snapshot: snapshot(next, run.projectId), output: updated.output };
      }),
    );
  });
  const setupWorker = Effect.fn("CodexCloudService.setupWorker")(function* (
    input: typeof CodexCloudWorkerSetupInput.Type,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* project(input.projectId);
    let state = yield* load;
    if (input.revokeWorkerId) {
      const worker = state.workers.find(
        (w) => w.id === input.revokeWorkerId && w.projectId === input.projectId,
      );
      if (!worker) return yield* new CodexCloudError({ code: "worker" });
      state = {
        ...state,
        workers: state.workers.map((w) => (w.id === worker.id ? { ...w, revoked: true } : w)),
        runs: state.runs.map((r) =>
          r.workerId === worker.id && !terminal(r.status)
            ? { ...r, status: "cancelled" as const }
            : r,
        ),
      };
      yield* save(state);
      yield* secrets.remove(`codex-cloud-worker-${worker.id}`).pipe(Effect.mapError(storage));
      return {
        snapshot: snapshot(state, input.projectId),
        script: "",
        token: "",
        instructions: "Worker revoked.",
      };
    }
    const origin = validateControllerOrigin(input.origin);
    const binding = state.bindings[input.projectId];
    if (!origin || !binding) return yield* new CodexCloudError({ code: "configuration" });
    const accountFingerprint = yield* cli.identity(binding);
    const id = NodeCrypto.randomUUID();
    const token = yield* secrets
      .getOrCreateRandom(`codex-cloud-worker-${id}`, 32)
      .pipe(Effect.mapError(storage));
    const worker: CodexCloudWorker = {
      id,
      projectId: input.projectId,
      binding,
      accountFingerprint,
      createdAt: iso(now),
      expiresAt: iso(now + 24 * 3600_000),
      lastSeen: null,
      revoked: false,
      instanceId: null,
      agents: [],
    };
    state = { ...state, workers: [...state.workers, worker] };
    yield* save(state);
    return {
      snapshot: snapshot(state, input.projectId),
      script: cloudWorkerSource,
      token: `${id}.${Buffer.from(token).toString("hex")}`,
      instructions: `Save the downloaded script in the cloud task. Set T3_CLOUD_CONTROLLER to ${origin}, T3_CLOUD_TOKEN to the separately supplied credential, and T3_CLOUD_CWD to that task's checkout. Run python3 t3-cloud-worker.py. This credential expires in 24 hours and binds to the first worker process. Supply credentials during the task, after publishing; keep them out of the reusable environment snapshot.`,
    };
  });
  const pollWorker = Effect.fn("CodexCloudService.pollWorker")(function* (
    credential: string,
    input: typeof WorkerPollInput.Type,
  ) {
    const now = yield* Clock.currentTimeMillis;
    let state = yield* load;
    const worker = yield* authenticate(state, credential);
    if (worker.instanceId !== null && worker.instanceId !== input.instanceId)
      return yield* new CodexCloudError({ code: "worker" });
    const fingerprint = yield* cli.identity(worker.binding);
    if (fingerprint !== worker.accountFingerprint)
      return yield* new CodexCloudError({ code: "account" });
    const boundRuns = state.runs.filter((r) => r.workerId === worker.id);
    const running = boundRuns.find((r) => r.status === "running");
    // A restarted worker cannot replay a possibly completed edit or command.
    if (running && input.activeRunId !== running.id)
      state = {
        ...state,
        runs: state.runs.map((r) =>
          r.id === running.id
            ? {
                ...r,
                status: "failed" as const,
                output: r.output + "\nWorker lost the running process; this job was not replayed.",
              }
            : r,
        ),
      };
    state = {
      ...state,
      workers: state.workers.map((w) =>
        w.id === worker.id
          ? { ...w, instanceId: input.instanceId, lastSeen: iso(now), agents: input.agents }
          : w,
      ),
    };
    let job: CodexCloudRun | null = null;
    if (input.activeRunId === null) {
      job =
        state.runs.find(
          (r) =>
            r.workerId === worker.id &&
            r.status === "queued" &&
            r.accountFingerprint === fingerprint &&
            input.agents.includes(r.agent),
        ) ?? null;
      if (job)
        state = {
          ...state,
          runs: state.runs.map((r) =>
            r.id === job!.id ? { ...r, status: "running" as const } : r,
          ),
        };
    }
    const active = state.runs.find((r) => r.id === input.activeRunId && r.workerId === worker.id);
    yield* save(state);
    return {
      job,
      cancel:
        input.activeRunId !== null &&
        (!active || active.status !== "running" || active.accountFingerprint !== fingerprint),
    };
  });
  const workerEvent = Effect.fn("CodexCloudService.workerEvent")(function* (
    credential: string,
    input: typeof WorkerEventInput.Type,
  ) {
    let state = yield* load;
    const worker = yield* authenticate(state, credential);
    if (worker.instanceId !== input.instanceId)
      return yield* new CodexCloudError({ code: "worker" });
    const run = state.runs.find((r) => r.id === input.runId && r.workerId === worker.id);
    if (!run) return yield* new CodexCloudError({ code: "task" });
    if (input.sequence <= run.eventSequence || run.status === "cancelled")
      return { accepted: true };
    if (run.status !== "running" || input.sequence !== run.eventSequence + 1)
      return yield* new CodexCloudError({ code: "worker" });
    const fingerprint = yield* cli.identity(run.binding);
    if (fingerprint !== run.accountFingerprint) return yield* new CodexCloudError({ code: "task" });
    state = {
      ...state,
      runs: state.runs.map((r) =>
        r.id === run.id
          ? {
              ...r,
              status: input.status,
              eventSequence: input.sequence,
              output: (r.output + input.output).slice(-180_000),
              sessionId: input.sessionId ?? r.sessionId,
            }
          : r,
      ),
    };
    yield* save(state);
    return { accepted: true };
  });
  return CodexCloudService.of({
    read,
    command: executeCommand,
    setupWorker: (input) => lock.withPermits(1)(setupWorker(input)),
    pollWorker: (token, input) => lock.withPermits(1)(pollWorker(token, input)),
    workerEvent: (token, input) => lock.withPermits(1)(workerEvent(token, input)),
  });
});
export const layer = Layer.effect(CodexCloudService, make);
