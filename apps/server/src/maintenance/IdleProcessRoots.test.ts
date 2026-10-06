import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  classifyProcessActivity,
  IdleProcessRoots,
  layer,
  registerIdleProcessRoot,
} from "./IdleProcessRoots.ts";

describe("idle process roots", () => {
  it("exempts only the exact live root identity and keeps its children blocking", () => {
    const result = classifyProcessActivity(
      "participant",
      [
        { pid: 41, label: "provider", result: { kind: "present", identity: "boot:1" } },
        { pid: 42, label: "worker", result: { kind: "present", identity: "boot:2" } },
      ],
      [{ pid: 41, started: "boot:1", kind: "provider" }],
    );

    expect(result.descendants.map(({ pid }) => pid)).toEqual([41, 42]);
    expect(result.blockers).toEqual([
      expect.objectContaining({ participantId: "participant", reason: "background-work" }),
    ]);
  });

  it("keeps an idle terminal shell blocked because same-process command state is unknown", () => {
    const result = classifyProcessActivity(
      "participant",
      [{ pid: 41, label: "zsh", result: { kind: "present", identity: "boot:1" } }],
      [{ pid: 41, started: "boot:1", kind: "terminal" }],
    );

    expect(result.blockers).toEqual([
      expect.objectContaining({
        participantId: "participant",
        reason: "commands",
        label: expect.stringContaining("Close it after its work finishes"),
      }),
    ]);
  });

  it("treats PID reuse and unreadable identity as blocking, while dropping a confirmed exit", () => {
    const result = classifyProcessActivity(
      "participant",
      [
        { pid: 41, label: "reused", result: { kind: "present", identity: "boot:2" } },
        { pid: 42, label: "unknown", result: { kind: "unreadable" } },
        { pid: 43, label: "finished sampler", result: { kind: "absent" } },
      ],
      [{ pid: 41, started: "boot:1", kind: "provider" }],
    );

    expect(result.descendants.map(({ pid }) => pid)).toEqual([41, 42]);
    expect(result.descendants[1]?.started).toBe("unknown-process-identity");
    expect(result.blockers.map(({ reason }) => reason)).toEqual([
      "background-work",
      "unknown-participant",
    ]);
  });

  it.effect("does not exempt a spawn whose handle is already stopped", () =>
    Effect.gen(function* () {
      const release = yield* registerIdleProcessRoot(
        process.pid,
        "provider",
        Effect.succeed(false),
      );
      const roots = yield* IdleProcessRoots.pipe(Effect.flatMap((service) => service.snapshot));
      expect(roots).toEqual([]);
      yield* release;
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not exempt a spawn when its handle status cannot be read", () =>
    Effect.gen(function* () {
      const release = yield* registerIdleProcessRoot(
        process.pid,
        "provider",
        Effect.sync(() => {
          throw new Error("handle status unavailable");
        }),
      );
      const roots = yield* IdleProcessRoots.pipe(Effect.flatMap((service) => service.snapshot));
      expect(roots).toEqual([]);
      yield* release;
    }).pipe(Effect.provide(layer)),
  );

  it.effect("checks handle liveness again after capturing the OS identity", () =>
    Effect.gen(function* () {
      let checks = 0;
      const release = yield* registerIdleProcessRoot(
        process.pid,
        "provider",
        Effect.sync(() => ++checks === 1),
      );
      const roots = yield* IdleProcessRoots.pipe(Effect.flatMap((service) => service.snapshot));
      expect(checks).toBe(2);
      expect(roots).toEqual([]);
      yield* release;
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not invent an exemption when no registry is composed", () =>
    Effect.gen(function* () {
      const release = yield* registerIdleProcessRoot(process.pid, "terminal", Effect.succeed(true));
      yield* release;
      const result = classifyProcessActivity(
        "participant",
        [{ pid: process.pid, label: "shell", result: { kind: "present", identity: "start" } }],
        [],
      );
      expect(result.blockers).toEqual([expect.objectContaining({ reason: "background-work" })]);
    }),
  );

  it.effect("keeps a live exact identity until its scoped release", () =>
    Effect.gen(function* () {
      const service = yield* IdleProcessRoots;
      const release = yield* service.register(process.pid, "terminal", Effect.succeed(true));
      const [root] = yield* service.snapshot;
      expect(root).toMatchObject({ pid: process.pid, kind: "terminal" });
      yield* release;
      expect(yield* service.snapshot).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});
