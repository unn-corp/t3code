import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { TerminalSummary } from "@t3tools/contracts";
import * as ProcessDiagnostics from "../diagnostics/ProcessDiagnostics.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as IdleProcessRoots from "./IdleProcessRoots.ts";
import { collectActivity, receiptSlotFor } from "./MaintenanceCoordinator.ts";

const terminal = (overrides: Partial<TerminalSummary> = {}): TerminalSummary => ({
  threadId: "thread-1",
  terminalId: "t1",
  cwd: "/work",
  worktreePath: null,
  status: "running",
  pid: 100,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: "zsh",
  updatedAt: "2026-10-05T00:00:00.000Z",
  ...overrides,
});

interface Sources {
  readonly terminals?: ReadonlyArray<TerminalSummary>;
  readonly clones?: ReadonlyArray<{ readonly phase: string }>;
  readonly processes?: ReadonlyArray<{
    readonly pid: number;
    readonly startTimeMs: number;
    readonly command: string;
  }>;
  readonly processError?: string;
  readonly staleProcessRead?: boolean;
  readonly roots?: ReadonlyArray<IdleProcessRoots.IdleProcessRoot>;
  readonly identities?: Readonly<Record<number, "present" | "absent" | "unreadable">>;
}
const processRead = (sources: Sources) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => {
      const processes = (sources.processes ?? []).map((entry) => ({
        ...entry,
        ppid: 1,
        pgid: Option.none(),
        status: "Running",
        cpuPercent: 0,
        rssBytes: 1,
        elapsed: "0:01",
        depth: 1,
        childPids: [],
      }));
      return {
        serverPid: 1,
        readAt: DateTime.makeUnsafe(now - (sources.staleProcessRead ? 60_000 : 0)),
        processCount: processes.length,
        totalRssBytes: processes.length,
        totalCpuPercent: 0,
        processes,
        error: sources.processError
          ? Option.some({ message: sources.processError })
          : Option.none(),
      };
    }),
  );
const layer = (sources: Sources = {}) =>
  Layer.mergeAll(
    ProjectionStore.layerMemory,
    Layer.succeed(TerminalManager.TerminalManager, {
      subscribeMetadata: (
        listener: (event: {
          type: "snapshot";
          terminals: ReadonlyArray<TerminalSummary>;
        }) => Effect.Effect<void>,
      ) =>
        listener({ type: "snapshot", terminals: sources.terminals ?? [] }).pipe(
          Effect.as(() => undefined),
        ),
    } as never),
    Layer.succeed(ProjectCloneTracker.ProjectCloneTracker, {
      stream: Stream.make(sources.clones ?? []),
    } as never),
    Layer.succeed(ProcessDiagnostics.ProcessDiagnostics, {
      read: processRead(sources),
    } as never),
    Layer.succeed(IdleProcessRoots.IdleProcessRoots, {
      register: () => Effect.succeed(Effect.void),
      snapshot: Effect.succeed(sources.roots ?? []),
      identify: (pids: ReadonlyArray<number>) =>
        Promise.resolve(
          pids.map((pid: number) => {
            const state = sources.identities?.[pid] ?? "present";
            return state === "present"
              ? {
                  kind: "present" as const,
                  identity: String(
                    sources.processes?.find((entry) => entry.pid === pid)?.startTimeMs ?? pid,
                  ),
                }
              : state === "absent"
                ? { kind: "absent" as const }
                : { kind: "unreadable" as const, cause: new Error("unreadable") };
          }),
        ),
    } as never),
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory));

describe("device activity sources", () => {
  it.effect("reads an idle device as idle", () =>
    Effect.gen(function* () {
      expect(yield* collectActivity("participant").pipe(Effect.provide(layer()))).toEqual({
        blockers: [],
        descendants: [],
        descendantsKnown: true,
      });
    }),
  );

  it.effect("counts a running terminal command, but not a shell waiting at its prompt", () =>
    Effect.gen(function* () {
      const idle = yield* collectActivity("participant").pipe(
        Effect.provide(layer({ terminals: [terminal()] })),
      );
      expect(idle.blockers).toEqual([]);
      const busy = yield* collectActivity("participant").pipe(
        Effect.provide(
          layer({ terminals: [terminal({ hasRunningSubprocess: true, label: "pnpm build" })] }),
        ),
      );
      expect(busy.blockers).toEqual([
        expect.objectContaining({
          reason: "commands",
          threadId: "thread-1",
          label: expect.stringContaining("pnpm build"),
        }),
      ]);
    }),
  );

  it.effect("counts a repository clone that is still running and ignores finished ones", () =>
    Effect.gen(function* () {
      expect(
        (yield* collectActivity("participant").pipe(
          Effect.provide(layer({ clones: [{ phase: "done" }, { phase: "failed" }] })),
        )).blockers,
      ).toEqual([]);
      expect(
        (yield* collectActivity("participant").pipe(
          Effect.provide(layer({ clones: [{ phase: "running" }] })),
        )).blockers,
      ).toEqual([
        expect.objectContaining({
          reason: "background-work",
          label: "A repository clone is still running.",
        }),
      ]);
    }),
  );

  it.effect("blocks live processes outside a registered idle root", () =>
    Effect.gen(function* () {
      const result = yield* collectActivity("participant").pipe(
        Effect.provide(
          layer({ processes: [{ pid: 4242, startTimeMs: 1, command: "codex app-server" }] }),
        ),
      );
      expect(result.descendants).toEqual([{ pid: 4242, started: "1", label: "codex app-server" }]);
      expect(result.blockers).toContainEqual(
        expect.objectContaining({
          reason: "background-work",
          label: expect.stringContaining("service root"),
        }),
      );
      expect(result.descendantsKnown).toBe(true);
    }),
  );

  it.effect("exempts only the exact registered root identity, not its child", () =>
    Effect.gen(function* () {
      const result = yield* collectActivity("participant").pipe(
        Effect.provide(
          layer({
            processes: [
              { pid: 4242, startTimeMs: 1, command: "codex app-server" },
              { pid: 4243, startTimeMs: 2, command: "sleep" },
            ],
            roots: [{ pid: 4242, started: "1", kind: "provider" }],
          }),
        ),
      );
      expect(result.descendants.map((entry) => entry.pid)).toEqual([4242, 4243]);
      expect(result.blockers).toEqual([
        expect.objectContaining({
          reason: "background-work",
          label: expect.stringContaining("service root"),
        }),
      ]);
    }),
  );

  it.effect("treats a reused root PID as work and an unreadable child as unknown", () =>
    Effect.gen(function* () {
      const reused = yield* collectActivity("participant").pipe(
        Effect.provide(
          layer({
            processes: [{ pid: 4242, startTimeMs: 2, command: "worker" }],
            roots: [{ pid: 4242, started: "1", kind: "provider" }],
          }),
        ),
      );
      expect(reused.blockers[0]?.reason).toBe("background-work");
      const unreadable = yield* collectActivity("participant").pipe(
        Effect.provide(
          layer({
            processes: [{ pid: 4242, startTimeMs: 2, command: "worker" }],
            identities: { 4242: "unreadable" },
          }),
        ),
      );
      expect(unreadable.blockers).toContainEqual(
        expect.objectContaining({
          reason: "unknown-participant",
          label: expect.stringContaining("identity"),
        }),
      );
    }),
  );

  it.effect("does not block a process found absent by the fresh identity check", () =>
    Effect.gen(function* () {
      const result = yield* collectActivity("participant").pipe(
        Effect.provide(
          layer({
            processes: [{ pid: 4242, startTimeMs: 1, command: "finished sampler" }],
            identities: { 4242: "absent" },
          }),
        ),
      );
      expect(result.blockers).toEqual([]);
      expect(result.descendants).toEqual([]);
      expect(result.descendantsKnown).toBe(true);
    }),
  );

  it.effect("treats a stale or incomplete process census as unknown activity", () =>
    Effect.gen(function* () {
      for (const sources of [
        {
          processError: "refresh failed",
          processes: [{ pid: 4242, startTimeMs: 1, command: "codex" }],
        },
        { staleProcessRead: true, processes: [{ pid: 4242, startTimeMs: 1, command: "codex" }] },
      ]) {
        const result = yield* collectActivity("participant").pipe(Effect.provide(layer(sources)));
        expect(result.blockers).toContainEqual(
          expect.objectContaining({
            reason: "unknown-participant",
            label: expect.stringContaining("Process"),
          }),
        );
        expect(result.descendantsKnown).toBe(false);
      }
    }),
  );

  it.effect("does not truncate a complete process census after 200 descendants", () =>
    Effect.gen(function* () {
      const processes = Array.from({ length: 240 }, (_, index) => ({
        pid: 5000 + index,
        startTimeMs: index + 1,
        command: `worker-${index}`,
      }));
      const result = yield* collectActivity("participant").pipe(
        Effect.provide(layer({ processes })),
      );
      expect(result.descendants).toHaveLength(240);
      expect(result.descendants[239]?.pid).toBe(5239);
    }),
  );

  it.effect(
    "counts running organization work and a recent Architect request, but not an expired one",
    () =>
      Effect.gen(function* () {
        const insertGeneric = (table: string, values: Record<string, string>) =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.unsafe("PRAGMA foreign_keys = OFF");
            const columns = yield* sql.unsafe<{
              name: string;
              type: string;
              notnull: number;
              dflt_value: string | null;
            }>(`PRAGMA table_info(${table})`);
            const names: string[] = [];
            const args: Array<string | number> = [];
            for (const column of columns) {
              if (column.name in values) {
                names.push(column.name);
                args.push(values[column.name]!);
              } else if (column.notnull === 1 && column.dflt_value === null) {
                names.push(column.name);
                args.push(/INT/i.test(column.type) ? 1 : "x");
              }
            }
            yield* sql.unsafe(
              `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
              args,
            );
          });
        const now = yield* DateTime.now;
        const recent = DateTime.formatIso(DateTime.add(now, { seconds: -30 }));
        const expired = DateTime.formatIso(DateTime.add(now, { seconds: -600 }));
        const program = Effect.gen(function* () {
          const quiet = yield* collectActivity("participant");
          expect(quiet.blockers).toEqual([]);
          yield* insertGeneric("organization_architect_requests", {
            status: "pending",
            created_at: expired,
            organization_id: "org-expired",
          });
          expect((yield* collectActivity("participant")).blockers).toEqual([]);
          yield* insertGeneric("organization_architect_requests", {
            status: "pending",
            created_at: recent,
            request_id: "recent",
            organization_id: "org-recent",
          });
          expect((yield* collectActivity("participant")).blockers).toEqual([
            expect.objectContaining({ label: "An Architect request is still running." }),
          ]);
          yield* insertGeneric("organization_live_work_phase_claims", { phase: "attempt" });
          expect(
            (yield* collectActivity("participant")).blockers.map((blocker) => blocker.label),
          ).toContain("Organization work is still running.");
        });
        yield* program.pipe(Effect.provide(layer()));
      }),
  );

  it.effect(
    "fails closed: a source that cannot be read blocks as unknown instead of reading as idle",
    () =>
      Effect.gen(function* () {
        const broken = Layer.succeed(SqlClient.SqlClient, (() =>
          Effect.die("database unreadable")) as never);
        const result = yield* collectActivity("participant").pipe(
          Effect.provide(
            Layer.mergeAll(
              IdleProcessRoots.layer,
              Layer.succeed(TerminalManager.TerminalManager, {
                subscribeMetadata: () => Effect.die("terminals unreadable"),
              } as never),
              Layer.succeed(ProjectCloneTracker.ProjectCloneTracker, {
                stream: Stream.die("clones unreadable"),
              } as never),
              Layer.succeed(ProcessDiagnostics.ProcessDiagnostics, {
                read: Effect.die("processes unreadable"),
              } as never),
              ProjectionStore.layerMemory,
            ).pipe(Layer.provideMerge(broken)),
          ),
        );
        const labels = result.blockers.map((blocker) => blocker.label);
        expect(result.blockers.every((blocker) => blocker.reason === "unknown-participant")).toBe(
          true,
        );
        expect(labels).toEqual(
          expect.arrayContaining([
            "Organization work activity could not be read.",
            "Terminal activity could not be read.",
            "Repository clone activity could not be read.",
            "Process activity could not be read.",
          ]),
        );
      }),
  );
});

describe("health receipt slot", () => {
  it("proves the new build with a trial receipt, and a restoration with a restored one, even when a capability is present", () => {
    expect(receiptSlotFor({ trial: true }, "trial")).toBe("trial");
    expect(receiptSlotFor({ trial: true }, "verified")).toBe("trial");
    // The previous-build desktop reverting a failed trial: capability present, journal already restored.
    expect(receiptSlotFor({ trial: true }, "restored")).toBe("restored");
    expect(receiptSlotFor({ trial: false }, "restored")).toBe("restored");
  });

  it("records nothing for a successor adopted to commit, or without a journal", () => {
    expect(receiptSlotFor({ trial: false }, "trial")).toBeNull();
    expect(receiptSlotFor({ trial: false }, null)).toBeNull();
    expect(receiptSlotFor({ trial: true }, null)).toBe("trial");
  });
});
