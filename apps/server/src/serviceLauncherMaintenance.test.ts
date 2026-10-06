// @effect-diagnostics preferSchemaOverJson:off - fixtures write and read fake child-process reports.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";
import {
  decodeServiceLauncherChildMessage,
  SERVICE_LAUNCHER_PROTOCOL,
} from "./cloud/serviceProtocol.ts";

it("passes a well-formed maintenance capability through the request and rejects a malformed one", () => {
  const trial = { transactionId: "tx", home: "/h", nonce: "n" };
  assert.deepEqual(
    decodeServiceLauncherChildMessage({
      type: "request-update",
      targetVersion: "1.1.0",
      dbPath: "/d",
      trial,
    }),
    { type: "request-update", targetVersion: "1.1.0", dbPath: "/d", trial },
  );
  assert.deepEqual(
    decodeServiceLauncherChildMessage({
      type: "request-update",
      targetVersion: "1.1.0",
      dbPath: "/d",
    }),
    { type: "request-update", targetVersion: "1.1.0", dbPath: "/d" },
  );
  // A malformed capability must not silently become an update without one.
  assert.isUndefined(
    decodeServiceLauncherChildMessage({
      type: "request-update",
      targetVersion: "1.1.0",
      dbPath: "/d",
      trial: { transactionId: "tx" },
    }),
  );
  assert.isUndefined(
    decodeServiceLauncherChildMessage({
      type: "request-update",
      targetVersion: "1.1.0",
      dbPath: "/d",
      trial: { transactionId: "", home: "/h", nonce: "n" },
    }),
  );
});

const writeFakeRuntime = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  versionDir: string,
  childSource: string,
) =>
  Effect.gen(function* () {
    const entryPath = path.join(versionDir, "t3");
    yield* fs.makeDirectory(versionDir, { recursive: true });
    yield* fs.writeFileString(entryPath, `#!${process.execPath}\n${childSource}`);
    yield* fs.chmod(entryPath, 0o755);
    yield* fs.writeFileString(
      path.join(versionDir, ".install-complete"),
      `${path.basename(versionDir)}\n`,
    );
  });

it.layer(NodeServices.layer)("service launcher maintenance capability", (it) => {
  it.effect(
    "hands the one-use capability only to the trial child, advertises the capability, and strips any inherited one",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launcher-maintenance-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
        yield* fs.writeFileString(databasePath, "before trial");
        const report = path.join(root, "reports");
        yield* fs.makeDirectory(report, { recursive: true });
        // @effect-diagnostics-next-line preferSchemaOverJson:off - embeds paths in fake child source.
        const encoded = (value: string) => JSON.stringify(value);
        const childSource = `
const fs = require("fs");
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
const role = context.update === undefined ? "active-initial" : "trial";
fs.writeFileSync(${encoded(report)} + "/" + role + ".json", JSON.stringify({ trial: process.env.T3CODE_MAINTENANCE_TRIAL ?? null, capabilities: context.capabilities ?? [] }));
if (role === "trial") {
  process.send({ type: "prepared", updateId: context.update.id });
  process.on("message", (message) => { if (message.type === "committed") process.exit(0); });
} else if (role === "active-initial") {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encoded(databasePath)}, trial: { transactionId: "tx-1", home: ${encoded(root)}, nonce: "one-use-nonce" } });
  setInterval(() => {}, 1_000);
}
`;
        for (const version of ["1.0.0", "1.1.0"])
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            childSource,
          );
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );

        const inherited = process.env.T3CODE_MAINTENANCE_TRIAL;
        // A capability in the launcher's own environment must never reach any child.
        process.env.T3CODE_MAINTENANCE_TRIAL = JSON.stringify({
          transactionId: "stale",
          home: "/x",
          nonce: "stale",
        });
        try {
          const launcher = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
            async () => {},
          );
          yield* Effect.promise(() =>
            launcher.run().then(
              () => Promise.reject(new Error("launcher unexpectedly completed")),
              () => Promise.resolve(),
            ),
          );
        } finally {
          if (inherited === undefined) delete process.env.T3CODE_MAINTENANCE_TRIAL;
          else process.env.T3CODE_MAINTENANCE_TRIAL = inherited;
        }
        const read = (role: string) =>
          fs
            .readFileString(path.join(report, `${role}.json`))
            .pipe(
              Effect.map(
                (text) => JSON.parse(text) as { trial: string | null; capabilities: string[] },
              ),
            );
        const initial = yield* read("active-initial");
        const trial = yield* read("trial");
        assert.isNull(initial.trial);
        assert.deepEqual(JSON.parse(trial.trial!), {
          transactionId: "tx-1",
          home: root,
          nonce: "one-use-nonce",
        });
        for (const child of [initial, trial])
          assert.include(child.capabilities, "maintenance-trial");
        assert.equal(
          (yield* Effect.promise(() => readServiceState(statePath))).update?.status,
          "committed",
        );
      }),
  );
});
