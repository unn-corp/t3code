// @effect-diagnostics nodeBuiltinImport:off - exercises actual mounted atoms across process garbage collection.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

it("keeps mounted queries and subscriptions live across garbage collection and isolates replacement accounts", async () => {
  const source = new URL(
    "../../../packages/client-runtime/src/state/teamProjects.ts",
    import.meta.url,
  ).href;
  const registry = new URL(
    "../../../packages/client-runtime/src/connection/registry.ts",
    import.meta.url,
  ).href;
  const supervisor = new URL(
    "../../../packages/client-runtime/src/connection/supervisor.ts",
    import.meta.url,
  ).href;
  const model = new URL("../../../packages/client-runtime/src/connection/model.ts", import.meta.url)
    .href;
  const script = `
      import * as Effect from "effect/Effect";
      import * as Layer from "effect/Layer";
      import * as Option from "effect/Option";
      import * as Stream from "effect/Stream";
      import * as SubscriptionRef from "effect/SubscriptionRef";
      import { Atom, AtomRegistry } from "effect/unstable/reactivity";
      import { createTeamProjectAtoms } from ${JSON.stringify(source)};
      import { EnvironmentRegistry } from ${JSON.stringify(registry)};
      import { EnvironmentSupervisor } from ${JSON.stringify(supervisor)};
      import { PrimaryConnectionTarget, AVAILABLE_CONNECTION_STATE } from ${JSON.stringify(model)};
      import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
      import { LOCAL_TEAM_METHODS, LOCAL_TEAM_DIRECTORY_METHOD } from "@t3tools/contracts/teamProjects";
      import { LOCAL_TEAM_FILES_STATE_METHOD } from "@t3tools/contracts/teamFiles";
      import { LOCAL_PRESENCE_WS_METHODS } from "@t3tools/contracts/teamPresence";
      const environmentId = EnvironmentId.make("synthetic");
      const projectId = ProjectId.make("synthetic");
      const threadId = ThreadId.make("synthetic");
      const calls = new Map();
      const counted = (name, value) => Effect.sync(() => {
        calls.set(name, (calls.get(name) ?? 0) + 1);
        return value;
      });
      const stream = (name, value) => Stream.fromEffect(counted(name, value)).pipe(Stream.concat(Stream.never));
      const client = {
        [LOCAL_TEAM_DIRECTORY_METHOD]: () => counted("directory", { role: "owner", members: [], invites: [] }),
        [LOCAL_TEAM_METHODS.snapshot]: () => counted("snapshot", { snapshotSequence: 1, discussions: [] }),
        [LOCAL_TEAM_FILES_STATE_METHOD]: () => counted("filesState", { enabled: false }),
        [LOCAL_TEAM_METHODS.subscribeProject]: () => stream("project", { kind: "snapshot", sequence: 1, threads: [] }),
        [LOCAL_TEAM_METHODS.subscribeThread]: () => stream("thread", { kind: "snapshot", snapshot: { snapshotSequence: 1 } }),
        [LOCAL_PRESENCE_WS_METHODS.subscribe]: () => stream("presence", { members: [] }),
      };
      const service = await Effect.runPromise(Effect.gen(function* () {
        return EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({ environmentId, label: "Synthetic", httpBaseUrl: "https://synthetic.invalid", wsBaseUrl: "wss://synthetic.invalid" }),
          state: yield* SubscriptionRef.make({ ...AVAILABLE_CONNECTION_STATE, phase: "connected", generation: 1 }),
          session: yield* SubscriptionRef.make(Option.some({ client })),
          prepared: yield* SubscriptionRef.make(Option.none()),
          connect: Effect.void, disconnect: Effect.void, retryNow: Effect.void,
        });
      }));
      const environments = EnvironmentRegistry.of({
        run: (_, effect) => Effect.provideService(effect, EnvironmentSupervisor, service),
        followStream: (_, value) => Stream.provideService(value, EnvironmentSupervisor, service),
      });
      const teams = createTeamProjectAtoms(Atom.runtime(Layer.succeed(EnvironmentRegistry, environments)));
      const atomRegistry = AtomRegistry.make();
      const target = { environmentId, sourceScope: "account-one", input: { projectId } };
      const reads = ["directory", "snapshot", "filesState", "project", "thread", "presence"].map(name => {
        const scoped = { ...target, input: name === "snapshot" || name === "thread" ? { projectId, threadId } : target.input };
        const atom = teams[name](scoped);
        return { name, scoped, atom, stop: atomRegistry.mount(atom) };
      });
      await Promise.all(reads.map(({ atom }) => Effect.runPromise(AtomRegistry.getResult(atomRegistry, atom))));
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setImmediate(resolve));
        global.gc();
      }
      const retained = reads.every(({ name, scoped, atom }) => teams[name](scoped) === atom);
      const oldOwner = atomRegistry.get(reads[0].atom).value.role;
      const replacement = teams.directory({ ...target, sourceScope: "account-two" });
      const isolated = replacement !== reads[0].atom;
      const replacementOwner = await Effect.runPromise(AtomRegistry.getResult(atomRegistry, replacement));
      console.log(JSON.stringify({ retained, isolated, oldOwner, replacementOwner: replacementOwner.role, calls: Object.fromEntries(calls) }));
      for (const read of reads) read.stop();
      atomRegistry.dispose();
    `;
  const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
    process.execPath,
    ["--expose-gc", "--input-type=module", "-e", script],
    { cwd: NodeURL.fileURLToPath(new URL(".", import.meta.url)) },
  );
  expect(JSON.parse(stdout.trim())).toEqual({
    retained: true,
    isolated: true,
    oldOwner: "owner",
    replacementOwner: "owner",
    calls: { directory: 2, snapshot: 1, filesState: 1, project: 1, thread: 1, presence: 1 },
  });
});
