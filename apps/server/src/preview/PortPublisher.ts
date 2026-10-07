/** Temporary browser shares own their proxy, idle deadline, and Tailscale mapping. */
import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { ChildProcessSpawner } from "effect/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { openTemporaryShareProxy, type TemporaryShareProxy } from "./TemporaryShareProxy.ts";

export const FIRST_PUBLISH_SERVE_PORT = 8450;
export const LAST_PUBLISH_SERVE_PORT = 8499;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
const OwnedMapping = Schema.Struct({
  servePort: Schema.Int.check(
    Schema.isBetween({ minimum: FIRST_PUBLISH_SERVE_PORT, maximum: LAST_PUBLISH_SERVE_PORT }),
  ),
  proxyPort: Port,
});
const Journal = Schema.Array(OwnedMapping);
const decodeJournal = Schema.decodeEffect(Schema.fromJsonString(Journal));
const ServeStatus = Schema.Struct({
  TCP: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  Web: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        Handlers: Schema.Record(
          Schema.String,
          Schema.Struct({ Proxy: Schema.optional(Schema.String) }),
        ),
      }),
    ),
  ),
});

const decodeServeStatus = Schema.decodeEffect(Schema.fromJsonString(ServeStatus));

export class PortPublishUnavailableError extends Schema.TaggedError<PortPublishUnavailableError>()(
  "PortPublishUnavailableError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.reason;
  }
}

export const nextServePort = (taken: ReadonlySet<number>): number | null => {
  for (let port = FIRST_PUBLISH_SERVE_PORT; port <= LAST_PUBLISH_SERVE_PORT; port += 1)
    if (!taken.has(port)) return port;
  return null;
};

interface PublishedPort {
  readonly localPort: number;
  readonly servePort: number;
  readonly url: string;
  readonly proxy: TemporaryShareProxy;
  readonly owners: Set<string>;
  lastVisit: number;
  closing: boolean;
}

export class PortPublisher extends Context.Service<
  PortPublisher,
  {
    readonly publish: (
      owner: string,
      url: string,
    ) => Effect.Effect<string, PortPublishUnavailableError>;
    readonly release: (owner: string) => Effect.Effect<void>;
    readonly list: Effect.Effect<
      ReadonlyArray<{
        readonly localPort: number;
        readonly servePort: number;
        readonly url: string;
      }>
    >;
  }
>()("t3/preview/PortPublisher") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const clock = yield* Clock.Clock;
  const scope = yield* Effect.scope;
  const journalPath = path.join(config.stateDir, "temporary-browser-shares.json");
  const published = yield* SynchronizedRef.make(new Map<number, PublishedPort>());
  const outstanding = new Map<number, typeof OwnedMapping.Type>();
  const unavailable = (reason: string, cause?: unknown) =>
    new PortPublishUnavailableError({ reason, cause });
  const readStatus = Effect.gen(function* () {
    const result = yield* runner.run({
      command: platform === "win32" ? "tailscale.exe" : "tailscale",
      args: ["serve", "status", "--json"],
      timeout: "10 seconds",
    });
    if (result.code !== 0 || result.timedOut)
      return yield* unavailable("Could not inspect existing Tailscale shares.");
    return yield* decodeServeStatus(result.stdout);
  });
  const persist = (entries: Iterable<typeof OwnedMapping.Type> = outstanding.values()) =>
    writeFileStringAtomically({
      filePath: journalPath,
      contents: JSON.stringify([...entries]),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const matches = (status: typeof ServeStatus.Type, entry: typeof OwnedMapping.Type) =>
    Object.entries(status.Web ?? {}).some(
      ([host, web]) =>
        host.endsWith(`:${entry.servePort}`) &&
        web.Handlers["/"]?.Proxy === `http://127.0.0.1:${entry.proxyPort}`,
    );
  const off = (entry: typeof OwnedMapping.Type) =>
    disableTailscaleServe({ servePort: entry.servePort }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.catchIf(
        (error) =>
          error._tag === "TailscaleCommandExitError" &&
          error.stderrDiagnostic === "no-existing-handler",
        () => Effect.void,
      ),
    );
  // Persist before publication. A restart removes only exact targets recorded here,
  // never every port in a range or the environment's permanent connection route.
  let journalValid = true;
  if (yield* fs.exists(journalPath)) {
    const result = yield* fs
      .readFileString(journalPath)
      .pipe(Effect.flatMap(decodeJournal), Effect.result);
    if (result._tag === "Success") {
      for (const entry of result.success) outstanding.set(entry.servePort, entry);
    } else {
      journalValid = false;
      yield* Effect.logWarning(
        "Temporary browser sharing disabled: ownership journal could not be read",
      );
    }
  }
  const recoverOrphans = Effect.fn("PortPublisher.recoverOrphans")(function* (
    current: ReadonlyMap<number, PublishedPort>,
  ) {
    const live = new Set([...current.values()].map((entry) => entry.servePort));
    const entries = [...outstanding.values()].filter((entry) => !live.has(entry.servePort));
    if (!entries.length) return;
    yield* Effect.gen(function* () {
      const status = yield* readStatus;
      for (const entry of entries) {
        if (matches(status, entry)) yield* off(entry);
        yield* persist(
          [...outstanding.values()].filter((mapping) => mapping.servePort !== entry.servePort),
        );
        outstanding.delete(entry.servePort);
      }
    }).pipe(
      Effect.catch(() => Effect.logWarning("Stale temporary browser share cleanup will retry")),
    );
  });
  yield* recoverOrphans(new Map());

  const remove = Effect.fn("PortPublisher.remove")(function* (entry: PublishedPort) {
    // Disable the proxy immediately, even if the daemon temporarily refuses cleanup.
    entry.closing = true;
    entry.proxy.close();
    const recorded = outstanding.get(entry.servePort)!;
    const removed = yield* Effect.gen(function* () {
      const status = yield* readStatus;
      if (matches(status, recorded)) yield* off(recorded);
      yield* persist(
        [...outstanding.values()].filter((mapping) => mapping.servePort !== entry.servePort),
      );
      outstanding.delete(entry.servePort);
      return true;
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Temporary browser share cleanup will retry", {
          servePort: entry.servePort,
        }).pipe(Effect.as(false)),
      ),
    );
    return removed;
  });
  const cleanup = () =>
    SynchronizedRef.updateEffect(published, (current) =>
      Effect.gen(function* () {
        yield* recoverOrphans(current);
        const next = new Map(current);
        for (const entry of current.values()) {
          if (
            entry.closing ||
            entry.owners.size === 0 ||
            clock.currentTimeMillisUnsafe() - entry.lastVisit >= IDLE_TIMEOUT_MS
          ) {
            if (yield* remove(entry)) next.delete(entry.localPort);
          }
        }
        return next;
      }),
    ).pipe(Effect.uninterruptible);
  yield* Scope.addFinalizer(
    scope,
    SynchronizedRef.updateEffect(published, (current) =>
      Effect.gen(function* () {
        for (const entry of current.values()) yield* remove(entry);
        yield* recoverOrphans(current);
        return new Map();
      }),
    ),
  );
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("1 minute");
      yield* cleanup();
    }
  }).pipe(Effect.forkScoped);

  const publish = Effect.fn("PortPublisher.publish")(function* (owner: string, rawUrl: string) {
    if (!journalValid)
      return yield* unavailable(
        "Temporary sharing is disabled until its ownership journal is repaired.",
      );
    const url = yield* Effect.try({
      try: () => new URL(rawUrl),
      catch: (cause) => unavailable("Invalid temporary share URL.", cause),
    });
    if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.username || url.password)
      return yield* unavailable(
        "Temporary sharing supports HTTP localhost URLs without credentials.",
      );
    const localPort = Number(url.port || 80);
    return yield* SynchronizedRef.modifyEffect(
      published,
      (
        current,
      ): Effect.Effect<
        readonly [
          { readonly value: string } | { readonly error: unknown },
          Map<number, PublishedPort>,
        ],
        PortPublishUnavailableError
      > =>
        Effect.gen(function* () {
          const next = new Map(current);
          let entry = next.get(localPort);
          if (entry?.closing)
            return yield* unavailable("This share is still being removed. Retry shortly.");
          if (!entry) {
            const status = yield* readStatus.pipe(
              Effect.mapError((cause) =>
                unavailable("Could not inspect existing Tailscale shares.", cause),
              ),
            );
            const tailnet = yield* readTailscaleStatus.pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.mapError((cause) => unavailable("Could not reach Tailscale.", cause)),
            );
            if (!tailnet.magicDnsName)
              return yield* unavailable("Tailscale sharing requires MagicDNS.");
            const taken = new Set([
              ...Object.keys(status.TCP ?? {}).map(Number),
              ...outstanding.keys(),
            ]);
            const servePort = nextServePort(taken);
            if (servePort === null)
              return yield* unavailable("Every temporary sharing port is occupied.");
            const activity = { time: clock.currentTimeMillisUnsafe() };
            const proxy = yield* openTemporaryShareProxy({
              localPort,
              onVisit: () => {
                activity.time = clock.currentTimeMillisUnsafe();
              },
            }).pipe(
              Effect.mapError((cause) =>
                unavailable("Could not start the temporary browser proxy.", cause),
              ),
            );
            outstanding.set(servePort, { servePort, proxyPort: proxy.port });
            const result = yield* Effect.gen(function* () {
              yield* persist();
              yield* ensureTailscaleServe({ localPort: proxy.port, servePort }).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              );
            }).pipe(Effect.result);
            entry = {
              localPort,
              servePort,
              proxy,
              url: buildTailscaleHttpsBaseUrl({ magicDnsName: tailnet.magicDnsName, servePort }),
              owners: new Set(),
              get lastVisit() {
                return activity.time;
              },
              set lastVisit(time) {
                activity.time = time;
              },
              closing: false,
            };
            if (result._tag === "Failure") {
              // The daemon may have applied a mapping before a command timed out.
              const removed = yield* remove(entry);
              if (!removed) next.set(localPort, entry);
              return [{ error: result.failure }, next] as const;
            }
            next.set(localPort, entry);
          }
          entry.owners.add(owner);
          const sharedUrl = new URL(entry.url);
          sharedUrl.pathname = url.pathname;
          sharedUrl.search = url.search;
          sharedUrl.hash = url.hash;
          return [{ value: sharedUrl.toString() }, next] as const;
        }),
    ).pipe(
      Effect.flatMap((result) =>
        "value" in result
          ? Effect.succeed(result.value)
          : Effect.fail(
              unavailable("Tailscale could not publish the temporary URL.", result.error),
            ),
      ),
      Effect.tap(() => cleanup()),
      Effect.uninterruptible,
    );
  });
  const release = Effect.fn("PortPublisher.release")(function* (owner: string) {
    yield* SynchronizedRef.update(published, (current) => {
      for (const entry of current.values()) entry.owners.delete(owner);
      return current;
    });
    yield* cleanup();
  });
  return PortPublisher.of({
    publish,
    release,
    list: SynchronizedRef.modify(
      published,
      (entries) =>
        [
          [...entries.values()].map(({ localPort, servePort, url }) => ({
            localPort,
            servePort,
            url,
          })),
          entries,
        ] as const,
    ),
  });
});

export const layer = Layer.effect(PortPublisher, make);
