import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CodexCloudError,
  ProjectId,
  ProviderInstanceId,
  type CodexCloudBinding,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Config from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Cli from "./CodexCloudCli.ts";
import * as Cloud from "./CodexCloudService.ts";

const projectId = ProjectId.make("squidhub");
const binding: CodexCloudBinding = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  environmentId: "squidhub-env",
  label: "Squidhub",
  branch: "main",
};
const cli: Cli.CodexCloudCli["Service"] = {
  identity: (b) => Effect.succeed(`account-${b.providerInstanceId}`),
  run: () => Effect.succeed("Created https://chatgpt.com/codex/tasks/task_fixture\n"),
};
const projects = Layer.mock(Projects.ProjectStoreV2)({
  get: (id) =>
    Effect.succeed(
      Option.some({
        projectId: id,
        title: "Fixture",
        workspaceRoot: process.cwd(),
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        faviconPath: null,
        projectIcon: null,
        scripts: [],
        createdAt: "2026-10-07T00:00:00.000Z",
        updatedAt: "2026-10-07T00:00:00.000Z",
        deletedAt: null,
      }),
    ),
});
const fixture = <A, E, R>(effect: Effect.Effect<A, E, R>, customCli = cli) =>
  Effect.scoped(
    effect.pipe(
      Effect.provide(
        Cloud.layer.pipe(
          Layer.provideMerge(Layer.succeed(Cli.CodexCloudCli, customCli)),
          Layer.provideMerge(projects),
          Layer.provideMerge(Secrets.layer),
          Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "t3-cloud-fixture-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
const save = (cloud: Cloud.CodexCloudService["Service"], b = binding) =>
  cloud.command({ action: "save", projectId, binding: b });
const submit = (requestId: string) => ({
  action: "submit" as const,
  projectId,
  requestId,
  mode: "cloud" as const,
  agent: "codex" as const,
  prompt: "Inspect the fixture without changing files.",
});
const poll = { instanceId: "worker-instance", agents: ["claude" as const], activeRunId: null };

it.effect("pins cloud launches and later reads to their original account and environment", () => {
  const calls: {
    binding: CodexCloudBinding;
    args: readonly string[];
    fingerprint: string | undefined;
  }[] = [];
  return fixture(
    Effect.gen(function* () {
      const cloud = yield* Cloud.CodexCloudService;
      yield* save(cloud);
      const first = yield* cloud.command(submit("launch-one"));
      assert.strictEqual(first.snapshot.runs[0]?.status, "submitted");
      yield* cloud.command(submit("launch-one"));
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0]?.args, [
        "exec",
        "--env",
        "squidhub-env",
        "--branch",
        "main",
        "--",
        submit("x").prompt,
      ]);
      yield* save(cloud, {
        ...binding,
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        environmentId: "work-env",
      });
      yield* cloud.command({ action: "diff", projectId, runId: "launch-one" });
      assert.strictEqual(calls[1]?.binding.providerInstanceId, "codex");
      assert.strictEqual(calls[1]?.binding.environmentId, "squidhub-env");
      assert.strictEqual(calls[1]?.fingerprint, "account-codex");
      assert.strictEqual(
        (yield* cloud
          .command({ ...submit("launch-one"), prompt: "Different work" })
          .pipe(Effect.flip)).code,
        "task",
      );
    }),
    {
      ...cli,
      run: (b, args, _cwd, fingerprint) =>
        Effect.sync(() => {
          calls.push({ binding: b, args, fingerprint });
          return "Created https://chatgpt.com/codex/tasks/task_fixture\n";
        }),
    },
  );
});

it.effect(
  "persists uncertain launches without resubmitting, including after a new service instance",
  () => {
    let calls = 0;
    return fixture(
      Effect.gen(function* () {
        const cloud = yield* Cloud.CodexCloudService;
        yield* save(cloud);
        const result = yield* cloud.command(submit("uncertain"));
        assert.strictEqual(result.snapshot.runs[0]?.status, "unknown");
        const restarted = yield* Cloud.CodexCloudService.pipe(
          Effect.provide(Layer.fresh(Cloud.layer)),
        );
        yield* restarted.command(submit("uncertain"));
        assert.strictEqual(calls, 1);
        assert.strictEqual((yield* restarted.read(projectId)).runs[0]?.status, "unknown");
      }),
      {
        ...cli,
        run: () =>
          Effect.suspend(() => {
            calls++;
            return Effect.fail(new CodexCloudError({ code: "cli" }));
          }),
      },
    );
  },
);

it.effect("records a known environment preflight rejection as failed without replay", () => {
  let calls = 0;
  return fixture(
    Effect.gen(function* () {
      const cloud = yield* Cloud.CodexCloudService;
      yield* save(cloud);
      const result = yield* cloud.command(submit("missing-environment"));
      assert.strictEqual(result.snapshot.runs[0]?.status, "failed");
      assert.strictEqual(result.snapshot.runs[0]?.taskId, null);
      yield* cloud.command(submit("missing-environment"));
      assert.strictEqual(calls, 1);
    }),
    {
      ...cli,
      run: () =>
        Effect.suspend(() => {
          calls++;
          return Effect.fail(new CodexCloudError({ code: "environment" }));
        }),
    },
  );
});

it.effect(
  "runs Claude jobs, acknowledges repeated output once, and resumes explicit conversations",
  () =>
    fixture(
      Effect.gen(function* () {
        const cloud = yield* Cloud.CodexCloudService;
        yield* save(cloud);
        const setup = yield* cloud.setupWorker({ projectId, origin: "https://fixture.example" });
        const workerId = setup.snapshot.workers[0]!.id;
        yield* cloud.pollWorker(setup.token, poll);
        const request = {
          ...submit("claude-one"),
          mode: "worker" as const,
          agent: "claude" as const,
          workerId,
        };
        yield* cloud.command(request);
        assert.strictEqual((yield* cloud.pollWorker(setup.token, poll)).job?.id, "claude-one");
        const event = {
          ...poll,
          runId: "claude-one",
          sequence: 1,
          output: "edited fixture\n",
          status: "completed" as const,
          sessionId: "claude_session",
        };
        yield* cloud.workerEvent(setup.token, event);
        yield* cloud.workerEvent(setup.token, event);
        assert.strictEqual((yield* cloud.read(projectId)).runs[0]?.output, "edited fixture\n");
        yield* cloud.command({ ...request, requestId: "claude-two", continueRunId: "claude-one" });
        const next = yield* cloud.pollWorker(setup.token, poll);
        assert.strictEqual(next.job?.sessionId, "claude_session");
        yield* cloud.command({ action: "cancel", projectId, runId: "claude-two" });
        assert.strictEqual(
          (yield* cloud.pollWorker(setup.token, { ...poll, activeRunId: "claude-two" })).cancel,
          true,
        );
        assert.strictEqual(
          (yield* cloud.command({ ...request, continueRunId: "claude-one" }).pipe(Effect.flip))
            .code,
          "task",
        );
        const config = yield* Config.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const state = yield* fs.readFileString(`${config.stateDir}/codex-cloud.json`);
        assert.strictEqual(state.includes(setup.token), false);
        assert.strictEqual(setup.script.includes(setup.token), false);
      }),
    ),
);

it.effect("rejects credential replay, out-of-order output, revocation, and expired workers", () =>
  fixture(
    Effect.gen(function* () {
      const cloud = yield* Cloud.CodexCloudService;
      yield* save(cloud);
      const setup = yield* cloud.setupWorker({ projectId, origin: "https://fixture.example" });
      const workerId = setup.snapshot.workers[0]!.id;
      yield* cloud.pollWorker(setup.token, poll);
      assert.strictEqual(
        (yield* cloud
          .pollWorker(setup.token, { ...poll, instanceId: "another-process" })
          .pipe(Effect.flip)).code,
        "worker",
      );
      assert.strictEqual(
        (yield* cloud.pollWorker(`${workerId}.${"0".repeat(64)}`, poll).pipe(Effect.flip)).code,
        "unauthorized",
      );
      yield* cloud.command({ ...submit("one"), mode: "worker", agent: "claude", workerId });
      yield* cloud.pollWorker(setup.token, poll);
      assert.strictEqual(
        (yield* cloud
          .workerEvent(setup.token, {
            ...poll,
            runId: "one",
            sequence: 2,
            output: "gap",
            status: "running",
            sessionId: null,
          })
          .pipe(Effect.flip)).code,
        "worker",
      );
      yield* cloud.setupWorker({ projectId, origin: "", revokeWorkerId: workerId });
      assert.strictEqual(
        (yield* cloud.pollWorker(setup.token, poll).pipe(Effect.flip)).code,
        "unauthorized",
      );
      const expiring = yield* cloud.setupWorker({ projectId, origin: "https://fixture.example" });
      yield* TestClock.adjust("25 hours");
      assert.strictEqual(
        (yield* cloud.pollWorker(expiring.token, poll).pipe(Effect.flip)).code,
        "unauthorized",
      );
    }),
  ),
);

it.effect("does not replay a lost worker job and refuses a replaced account login", () => {
  let fingerprint = "first-account";
  return fixture(
    Effect.gen(function* () {
      const cloud = yield* Cloud.CodexCloudService;
      yield* save(cloud);
      const setup = yield* cloud.setupWorker({ projectId, origin: "https://fixture.example" });
      yield* cloud.pollWorker(setup.token, poll);
      yield* cloud.command({
        ...submit("lost"),
        mode: "worker",
        agent: "claude",
        workerId: setup.snapshot.workers[0]!.id,
      });
      yield* cloud.pollWorker(setup.token, poll);
      assert.strictEqual((yield* cloud.pollWorker(setup.token, poll)).job, null);
      assert.strictEqual((yield* cloud.read(projectId)).runs[0]?.status, "failed");
      fingerprint = "replacement-account";
      assert.strictEqual(
        (yield* cloud.pollWorker(setup.token, poll).pipe(Effect.flip)).code,
        "account",
      );
    }),
    { ...cli, identity: () => Effect.sync(() => fingerprint) },
  );
});

it.effect("keeps worker heartbeats available while the cloud CLI is waiting", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    yield* fixture(
      Effect.gen(function* () {
        const cloud = yield* Cloud.CodexCloudService;
        yield* save(cloud);
        const setup = yield* cloud.setupWorker({ projectId, origin: "https://fixture.example" });
        const launch = yield* cloud.command(submit("waiting")).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* cloud.pollWorker(setup.token, poll);
        yield* Deferred.succeed(finish, undefined);
        assert.strictEqual(
          (yield* Fiber.join(launch)).snapshot.workers[0]?.instanceId,
          poll.instanceId,
        );
      }),
      {
        ...cli,
        run: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.as("https://chatgpt.com/codex/tasks/task_fixture"),
          ),
      },
    );
  }),
);
