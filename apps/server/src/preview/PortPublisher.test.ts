import { expect, it } from "@effect/vitest";

import {
  FIRST_PUBLISH_SERVE_PORT,
  LAST_PUBLISH_SERVE_PORT,
  nextServePort,
} from "./PortPublisher.ts";

it("allocates the lowest free serve port", () => {
  expect(nextServePort(new Set())).toBe(FIRST_PUBLISH_SERVE_PORT);
  expect(nextServePort(new Set([FIRST_PUBLISH_SERVE_PORT]))).toBe(FIRST_PUBLISH_SERVE_PORT + 1);
});

it("never hands back a port something else is already serving on", () => {
  // 443 is the tailnet default and carries the environment itself; 8443 is
  // pairing. Publishing over either would take down the way in.
  const everything = new Set<number>();
  for (let port = FIRST_PUBLISH_SERVE_PORT; port <= LAST_PUBLISH_SERVE_PORT; port += 1) {
    const allocated = nextServePort(everything);
    if (allocated === null) break;
    expect(allocated).not.toBe(443);
    expect(allocated).not.toBe(8443);
    everything.add(allocated);
  }
  expect(everything.size).toBeGreaterThan(0);
});

it("reports exhaustion rather than allocating outside its range", () => {
  const taken = new Set<number>();
  for (let port = FIRST_PUBLISH_SERVE_PORT; port <= LAST_PUBLISH_SERVE_PORT; port += 1) {
    taken.add(port);
  }
  expect(nextServePort(taken)).toBeNull();
});

// The external Tailscale process is faked; the publisher and HTTP proxy are real.
import { NodeServices } from "@effect/platform-node";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { Effect, FileSystem, Layer, Path, Sink, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortPublisher from "./PortPublisher.ts";
import * as PreviewManager from "./Manager.ts";
import { ThreadId } from "@t3tools/contracts";

const fixture = () => {
  const mappings = new Map<number, string>();
  const calls: string[][] = [];
  let failOff = false;
  const status = () =>
    JSON.stringify({
      TCP: Object.fromEntries([...mappings.keys()].map((port) => [port, { HTTPS: true }])),
      Web: Object.fromEntries(
        [...mappings].map(([port, proxy]) => [
          `fixture.tail.ts.net:${port}`,
          { Handlers: { "/": { Proxy: proxy } } },
        ]),
      ),
    });
  const spawner = ChildProcessSpawner.make((command) => {
    const { args } = command as { readonly args: readonly string[] };
    calls.push([...args]);
    let code = 0;
    let stdout = "";
    if (args[0] === "status") stdout = '{"Self":{"DNSName":"fixture.tail.ts.net."}}';
    else {
      const port = Number(args.find((arg) => arg.startsWith("--https="))?.split("=")[1]);
      if (args.includes("off")) {
        if (failOff) code = 1;
        else mappings.delete(port);
      } else mappings.set(port, args.at(-1)!);
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  const runner = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: () =>
        Effect.succeed({
          stdout: status(),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
    }),
  );
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "preview-share-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const dependencies = Layer.mergeAll(
    config,
    NodeServices.layer,
    runner,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HostProcessPlatform, "linux"),
  );
  return {
    mappings,
    calls,
    dependencies,
    layer: PortPublisher.layer.pipe(Layer.provide(dependencies)),
    setFailOff: (value: boolean) => {
      failOff = value;
    },
  };
};

it.effect("closes a share only after its last tab closes, preserving unrelated mappings", () => {
  const f = fixture();
  f.mappings.set(443, "http://127.0.0.1:3773");
  f.mappings.set(8450, "http://127.0.0.1:9999");
  return Effect.gen(function* () {
    const publisher = yield* PortPublisher.PortPublisher;
    const first = yield* publisher.publish(
      "thread-a/tab-a",
      "http://localhost:5173/path?x=1#section",
    );
    const second = yield* publisher.publish("thread-b/tab-b", "http://127.0.0.1:5173/other");
    expect(first).toBe("https://fixture.tail.ts.net:8451/path?x=1#section");
    expect(new URL(second).origin).toBe(new URL(first).origin);
    yield* publisher.release("thread-a/tab-a");
    expect(f.mappings.has(8451)).toBe(true);
    yield* publisher.release("thread-b/tab-b");
    expect(f.mappings.has(8451)).toBe(false);
    expect(f.mappings.size).toBe(2);
  }).pipe(Effect.provide(f.layer));
});

it.effect("expires after one hour without incoming URL traffic even with a tab open", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const publisher = yield* PortPublisher.PortPublisher;
    yield* publisher.publish("tab", "http://localhost:5173/");
    yield* TestClock.adjust("59 minutes");
    expect(f.mappings.size).toBe(1);
    yield* TestClock.adjust("1 minute");
    expect(f.mappings.size).toBe(0);
    expect(yield* publisher.list).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("real incoming requests renew the idle deadline, including visits outside T3", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const publisher = yield* PortPublisher.PortPublisher;
    yield* publisher.publish("tab", "http://localhost:1/");
    yield* TestClock.adjust("50 minutes");
    const proxy = [...f.mappings.values()][0]!;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(proxy).pipe(HttpClientRequest.setHeader("accept", "text/html")),
    );
    yield* response.arrayBuffer;
    yield* TestClock.adjust("50 minutes");
    expect(f.mappings.size).toBe(1);
    yield* TestClock.adjust("10 minutes");
    expect(f.mappings.size).toBe(0);
  }).pipe(Effect.provide(Layer.merge(f.layer, FetchHttpClient.layer)));
});

it.effect("retains failed teardown for retry and never forgets an exposed port", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const publisher = yield* PortPublisher.PortPublisher;
    yield* publisher.publish("tab", "http://localhost:5173/");
    f.setFailOff(true);
    yield* publisher.release("tab");
    expect(yield* publisher.list).toHaveLength(1);
    f.setFailOff(false);
    yield* TestClock.adjust("1 minute");
    expect(f.mappings.size).toBe(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("the real preview manager releases every share when the owning tab closes", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    const tab = yield* manager.open({
      threadId: ThreadId.make("shared-thread"),
      url: "http://localhost:5173/",
      shareLocalhost: true,
    });
    expect(tab.navStatus._tag !== "Idle" && tab.navStatus.url).toContain("fixture.tail.ts.net");
    yield* manager.navigate({
      threadId: ThreadId.make(tab.threadId),
      tabId: tab.tabId,
      url: "http://localhost:5174/",
      shareLocalhost: true,
    });
    expect(f.mappings.size).toBe(2);
    yield* manager.close({ threadId: ThreadId.make(tab.threadId), tabId: tab.tabId });
    expect(f.mappings.size).toBe(0);
  }).pipe(Effect.provide(PreviewManager.layer.pipe(Layer.provide(f.layer))));
});

it.effect("restart cleanup removes only recorded exact proxy targets", () => {
  const f = fixture();
  f.mappings.set(8450, "http://127.0.0.1:9998");
  f.mappings.set(8451, "http://127.0.0.1:9997");
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const journal = path.join(config.stateDir, "temporary-browser-shares.json");
    yield* fs.writeFileString(
      journal,
      '[{"servePort":8450,"proxyPort":9998},{"servePort":8451,"proxyPort":9998}]',
    );
    yield* Effect.gen(function* () {
      yield* PortPublisher.PortPublisher;
      expect(f.mappings.has(8450)).toBe(false);
      expect(f.mappings.get(8451)).toBe("http://127.0.0.1:9997");
      expect(yield* fs.readFileString(journal)).toBe("[]");
    }).pipe(Effect.provide(PortPublisher.layer));
  }).pipe(Effect.provide(f.dependencies));
});

it.effect("shutdown removes mappings without touching the permanent environment route", () => {
  const f = fixture();
  f.mappings.set(443, "http://127.0.0.1:3773");
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const publisher = yield* PortPublisher.PortPublisher;
      yield* publisher.publish("tab", "http://localhost:5173/");
      expect(f.mappings.size).toBe(2);
    }).pipe(Effect.provide(f.layer));
    expect(f.mappings.size).toBe(1);
    expect(f.mappings.get(443)).toBe("http://127.0.0.1:3773");
  });
});

it.effect("automatic probes and background fetches do not keep an unused share alive", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const publisher = yield* PortPublisher.PortPublisher;
    yield* publisher.publish("tab", "http://localhost:1/");
    yield* TestClock.adjust("50 minutes");
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get([...f.mappings.values()][0]!);
    yield* response.arrayBuffer;
    yield* TestClock.adjust("10 minutes");
    expect(f.mappings.size).toBe(0);
  }).pipe(Effect.provide(Layer.merge(f.layer, FetchHttpClient.layer)));
});
