/**
 * Publishes a local dev-server port on the tailnet, so a phone can open it in
 * its own browser.
 *
 * Streaming a page to a device that already has a browser is the expensive way
 * round: it re-encodes every frame, sends it base64 over the app's socket, and
 * hands back a scaled-down picture with synthetic input. The cheap way is to
 * make the page reachable and get out of the way. A dev server binds loopback,
 * so it is not reachable from a phone; Tailscale Serve is the bridge, and the
 * machinery for it already exists for pairing.
 *
 * Publishing is deliberately explicit and revocable. A mapping stays up until
 * something takes it down, so this tracks what it opened, exposes that list,
 * and closes everything when the server stops rather than leaving ports on the
 * tailnet after the process that opened them is gone.
 */
import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleStatus,
  DEFAULT_TAILSCALE_SERVE_PORT,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface PublishedPort {
  /** Loopback port on this machine, as the dev server bound it. */
  readonly localPort: number;
  /** Tailnet HTTPS port the mapping listens on. */
  readonly servePort: number;
  /** What to hand a browser. */
  readonly url: string;
}

/**
 * Serve ports are allocated from here upward. 443 is the tailnet's default and
 * is already taken by the environment itself, and pairing uses 8443, so
 * publishing starts clear of both rather than silently stealing one.
 */
export const FIRST_PUBLISH_SERVE_PORT = 8450;
export const LAST_PUBLISH_SERVE_PORT = 8499;

const RESERVED_SERVE_PORTS = new Set([DEFAULT_TAILSCALE_SERVE_PORT, 8443]);

export class PortPublishUnavailableError extends Data.TaggedError("PortPublishUnavailableError")<{
  readonly reason: string;
}> {}

/**
 * Lowest free serve port. Linear because the range is fifty wide and a person
 * is unlikely to publish more than a handful of dev servers at once.
 */
export const nextServePort = (taken: ReadonlySet<number>): number | null => {
  for (let port = FIRST_PUBLISH_SERVE_PORT; port <= LAST_PUBLISH_SERVE_PORT; port += 1) {
    if (!taken.has(port) && !RESERVED_SERVE_PORTS.has(port)) return port;
  }
  return null;
};

export class PortPublisher extends Context.Service<
  PortPublisher,
  {
    readonly publish: (
      localPort: number,
    ) => Effect.Effect<
      PublishedPort,
      PortPublishUnavailableError,
      ChildProcessSpawner.ChildProcessSpawner
    >;
    readonly revoke: (
      localPort: number,
    ) => Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner>;
    readonly list: Effect.Effect<ReadonlyArray<PublishedPort>>;
  }
>()("t3/preview/PortPublisher") {}

export const make = Effect.gen(function* () {
  const published = yield* SynchronizedRef.make<ReadonlyMap<number, PublishedPort>>(new Map());
  const scope = yield* Effect.scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const revoke = Effect.fn("PortPublisher.revoke")(function* (localPort: number) {
    const existing = yield* SynchronizedRef.modify(published, (current) => {
      const entry = current.get(localPort);
      if (!entry) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(localPort);
      return [entry, next as ReadonlyMap<number, PublishedPort>] as const;
    });
    if (!existing) return;
    yield* disableTailscaleServe({ servePort: existing.servePort }).pipe(Effect.ignore);
  });

  // Nothing this process opened outlives it: a mapping left behind would keep
  // a dev server on the tailnet with nothing running to explain why.
  yield* Scope.addFinalizer(
    scope,
    Effect.gen(function* () {
      const current = yield* SynchronizedRef.get(published);
      yield* Effect.forEach(current.values(), (entry) =>
        disableTailscaleServe({ servePort: entry.servePort }).pipe(Effect.ignore),
      );
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );

  const publish = Effect.fn("PortPublisher.publish")(function* (localPort: number) {
    const current = yield* SynchronizedRef.get(published);
    const already = current.get(localPort);
    // Publishing twice is a no-op rather than a second mapping, so a viewer
    // reopening the same dev server keeps one stable URL.
    if (already) return already;

    const status = yield* readTailscaleStatus.pipe(Effect.orElseSucceed(() => null));
    const magicDnsName = status?.magicDnsName ?? null;
    if (!magicDnsName) {
      return yield* Effect.fail(
        new PortPublishUnavailableError({
          reason:
            "This machine is not on a tailnet with MagicDNS, so there is no address a phone could open.",
        }),
      );
    }

    const servePort = nextServePort(new Set(Array.from(current.values(), (e) => e.servePort)));
    if (servePort === null) {
      return yield* Effect.fail(
        new PortPublishUnavailableError({ reason: "Every publishable port is already in use." }),
      );
    }

    yield* ensureTailscaleServe({ localPort, servePort }).pipe(
      Effect.mapError(
        () =>
          new PortPublishUnavailableError({
            reason:
              "Tailscale refused to publish the port. Check that Tailscale is running and HTTPS is enabled for this tailnet.",
          }),
      ),
    );

    const entry: PublishedPort = {
      localPort,
      servePort,
      url: buildTailscaleHttpsBaseUrl({ magicDnsName, servePort }),
    };
    yield* SynchronizedRef.update(published, (map) => new Map(map).set(localPort, entry));
    return entry;
  });

  return PortPublisher.of({
    publish,
    revoke,
    list: SynchronizedRef.get(published).pipe(
      Effect.map((map) => Array.from(map.values()) as ReadonlyArray<PublishedPort>),
    ),
  });
});

export const layer = Layer.effect(PortPublisher, make);
