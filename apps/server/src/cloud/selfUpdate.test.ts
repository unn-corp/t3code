import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "blocked";
  readonly desktopAppUpdate?: DesktopAppUpdate.DesktopAppUpdate["Service"];
}

// The staged runtime is a release archive: the fake client serves SHA256SUMS
// and the tarball, and the fake runner stands in for tar before it answers
// the staged preflight.
const archiveBytes = new TextEncoder().encode("not really a tarball");
const releaseHttpClient = (order: string[]) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url.endsWith("/SHA256SUMS")) {
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", archiveBytes));
        const hex = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        return HttpClientResponse.fromWeb(
          request,
          new Response(`${hex}  t3-1.1.0-linux-x64.tar.gz\n`),
        );
      }
      order.push("download");
      return HttpClientResponse.fromWeb(request, new Response(archiveBytes));
    }),
  );

const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" });
  const order: string[] = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.command === "tar") {
          order.push("extract");
          const stagingDir = input.args[input.args.indexOf("-C") + 1];
          if (stagingDir === undefined) return yield* Effect.die("missing tar target");
          yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\n").pipe(Effect.orDie);
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }
        order.push("preflight");
        const result =
          options.preflight === "blocked"
            ? { status: "blocked", version: "1.1.0", reason: "local update required" }
            : {
                status: "ready",
                version: "1.1.0",
                launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
              };
        return {
          // @effect-diagnostics-next-line preferSchemaOverJson:off - fake child-process stdout.
          stdout: JSON.stringify(result),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const launcher = ServiceLauncherClient.ServiceLauncherClient.of({
    managed: options.managed ?? true,
    supportsMaintenanceTrial: true,
    requestUpdate: () =>
      Effect.sync(() => {
        order.push("accept");
        return "launcher-id";
      }),
    prepareTrial: Effect.undefined,
  });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const selfUpdate = yield* ServerSelfUpdate.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, launcher),
    Effect.provideService(
      DesktopAppUpdate.DesktopAppUpdate,
      options.desktopAppUpdate ?? {
        available: false,
        run: () => Effect.die("unexpected desktop app update run"),
      },
    ),
    Effect.provideService(HttpClient.HttpClient, releaseHttpClient(order)),
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(HostProcessArchitecture, "x64"),
    Effect.provide(ServerConfig.layer({ ...config, mode: options.mode ?? "web" })),
  );
  return { selfUpdate, order };
});

it.layer(NodeServices.layer)("server self update", (it) => {
  it.effect(
    "stages, checks and preflights a runtime without ever asking the launcher to activate it",
    () =>
      Effect.gen(function* () {
        const { selfUpdate, order } = yield* makeHarness();
        const runtime = yield* selfUpdate.stage({ targetVersion: "1.1.0" });
        expect(runtime.entryPath.endsWith("1.1.0/t3")).toBe(true);
        expect(order).toEqual(["download", "extract", "preflight"]);
      }),
  );

  it.effect(
    "refuses a release whose checksum file disagrees with the digest in the release manifest",
    () =>
      Effect.gen(function* () {
        const { selfUpdate, order } = yield* makeHarness();
        const failure = yield* selfUpdate
          .stage({ targetVersion: "1.1.0", expectedArchiveSha256: "0".repeat(64) })
          .pipe(Effect.flip);
        expect(failure.reason).toBe("Could not prepare t3@1.1.0.");
        expect(order).toEqual([]);
      }),
  );

  it.effect(
    "rejects invalid versions, desktop-managed servers and unmanaged servers before staging",
    () =>
      Effect.gen(function* () {
        const web = yield* makeHarness();
        expect(
          (yield* web.selfUpdate.stage({ targetVersion: "latest" }).pipe(Effect.flip)).reason,
        ).toBe("'latest' is not an exact t3 version.");
        const desktop = yield* makeHarness({ mode: "desktop" });
        expect(
          (yield* desktop.selfUpdate.stage({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
        ).toContain("background service");
        const unmanaged = yield* makeHarness({ managed: false });
        expect(
          (yield* unmanaged.selfUpdate.stage({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
        ).toContain("background service");
        expect([...web.order, ...desktop.order, ...unmanaged.order]).toEqual([]);
      }),
  );

  it.effect("preserves the preflight refusal reason", () =>
    Effect.gen(function* () {
      const { selfUpdate } = yield* makeHarness({ preflight: "blocked" });
      expect((yield* selfUpdate.stage({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "local update required",
      );
    }),
  );

  it.effect("refuses the retired install methods so no path bypasses the device coordinator", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness();
      expect(
        (yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("device maintenance");
      expect((yield* selfUpdate.commitDesktopUpdate("request").pipe(Effect.flip)).reason).toContain(
        "device maintenance",
      );
      expect(order).toEqual([]);
    }),
  );
});
