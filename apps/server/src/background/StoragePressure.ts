// @effect-diagnostics nodeBuiltinImport:off - statfs and Linux PSI are host probes outside Effect's FileSystem API.
import * as NodeFSP from "node:fs/promises";
import type * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { BackgroundPolicySnapshot } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ServerConfig from "../config.ts";

type Snapshot = NonNullable<BackgroundPolicySnapshot["storagePressure"]>;

const unknown = (sampledAt: DateTime.Utc): Snapshot => ({
  ioSomeAvg10: null,
  ioFullAvg10: null,
  availableBytes: null,
  totalBytes: null,
  reason: null,
  sampledAt,
});

export class StoragePressure extends Context.Reference<{
  readonly read: Effect.Effect<Snapshot>;
}>("t3/background/StoragePressure", {
  defaultValue: () => ({ read: DateTime.now.pipe(Effect.map(unknown)) }),
}) {}

// PSI is time stalled on I/O, not disk utilization. Bound probes, cache them,
// and retain a cooldown so a recovered host is not immediately flooded again.
interface Readings {
  readonly psi: string | null;
  readonly availableBytes: number | null;
  readonly totalBytes: number | null;
}

/** Accepts a sampler so storage stalls and recovery can be tested without host I/O. */
export const makeWith = (readings: Effect.Effect<Readings>) =>
  Effect.gen(function* () {
    const cooldown = yield* Ref.make<{ until: number; reason: Snapshot["reason"] }>({
      until: 0,
      reason: null,
    });
    const sample = Effect.gen(function* () {
      const sampledAt = yield* DateTime.now;
      const { psi, availableBytes, totalBytes } = yield* readings;
      const text = psi ?? "";
      const number = (kind: "some" | "full") => {
        const match = new RegExp(`^${kind} avg10=([0-9.]+)`, "m").exec(text);
        const value = match ? Number(match[1]) : NaN;
        return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
      };
      const ioSomeAvg10 = number("some");
      const ioFullAvg10 = number("full");
      const reason: Snapshot["reason"] =
        availableBytes !== null &&
        totalBytes !== null &&
        totalBytes > 0 &&
        (availableBytes < 2 * 1024 ** 3 || availableBytes / totalBytes < 0.05)
          ? "low-space"
          : (ioSomeAvg10 ?? 0) >= 20 || (ioFullAvg10 ?? 0) >= 10
            ? "io-pressure"
            : null;
      const now = DateTime.toEpochMillis(sampledAt);
      const held = yield* Ref.modify(cooldown, (previous) => {
        const next = reason
          ? { until: now + 60_000, reason }
          : previous.until > now
            ? previous
            : { until: 0, reason: null };
        return [next.reason, next] as const;
      });
      return {
        ioSomeAvg10,
        ioFullAvg10,
        availableBytes,
        totalBytes,
        reason: held,
        sampledAt,
      } satisfies Snapshot;
    });
    const cache = yield* Cache.make({
      capacity: 1,
      lookup: () => sample,
      timeToLive: "5 seconds",
    });
    return { read: Cache.get(cache, "host") };
  });

const makeForDatabase = (dbPath: string) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const psi =
      platform === "linux"
        ? Effect.tryPromise((signal) =>
            NodeFSP.readFile("/proc/pressure/io", { encoding: "utf8", signal }),
          ).pipe(
            Effect.timeoutOption("250 millis"),
            Effect.orElseSucceed(() => Option.none<string>()),
          )
        : Effect.succeed(Option.none<string>());
    // statfs cannot be cancelled. Reuse an outstanding native request after a
    // timeout so a stalled filesystem cannot fill libuv's queue with probes.
    let diskFlight: Promise<NodeFS.StatsFs> | undefined;
    const disk = Effect.tryPromise(
      () =>
        diskFlight ??
        (diskFlight = NodeFSP.statfs(NodePath.dirname(dbPath)).finally(() => {
          diskFlight = undefined;
        })),
    ).pipe(
      Effect.timeoutOption("250 millis"),
      Effect.orElseSucceed(() => Option.none<NodeFS.StatsFs>()),
    );
    return yield* makeWith(
      Effect.all([psi, disk], { concurrency: "unbounded" }).pipe(
        Effect.map(([psiResult, diskResult]) => {
          const stats = Option.getOrNull(diskResult);
          return {
            psi: Option.getOrNull(psiResult),
            availableBytes: stats ? stats.bavail * stats.bsize : null,
            totalBytes: stats ? stats.blocks * stats.bsize : null,
          };
        }),
      ),
    );
  });

/** Samples the database filesystem; an explicit path also supports isolated probe tests. */
export const layerForDatabase = (dbPath: string) =>
  Layer.effect(StoragePressure, makeForDatabase(dbPath));

export const layer = Layer.effect(
  StoragePressure,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* makeForDatabase(config.dbPath);
  }),
);
