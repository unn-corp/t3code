import {
  OrchestrationGetSnapshotError,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type OrchestrationSubscribeShellInput,
  type OrchestrationSubscribeThreadInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  projectActivityEvent,
  projectThreadDetailSnapshot,
} from "../orchestration/ActivityPayloadProjection.ts";
import { makeLiveStreamBudget, type RetainedLiveItem } from "../orchestration/LiveStreamBudget.ts";
import { makeThreadLiveEventCoalescer } from "../orchestration/ThreadLiveEventCoalescer.ts";
import { isThreadDetailEvent } from "../orchestration/ThreadDetailEvents.ts";
import type { TeamNativeConnection } from "./TeamNativeProjects.ts";

const MAX_REPLAY_EVENTS = 1000;
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
const streamFailure = () =>
  new OrchestrationGetSnapshotError({
    message: "Project stream could not be loaded. Reconnect to synchronize.",
  });
type ShellEvent = Pick<OrchestrationEvent, "aggregateKind" | "aggregateId" | "type" | "sequence">;
type ShellInput = { kind: "event"; event: ShellEvent } | { kind: "synchronized" };
const shellEvent = ({
  aggregateKind,
  aggregateId,
  type,
  sequence,
}: OrchestrationEvent): ShellEvent => ({ aggregateKind, aggregateId, type, sequence });

// Subscribe first, capture the baseline, then track every later domain event.
// Markers wait for the consumer to drain through a captured engine head; merely
// offering into its output queue can overtake an event still waiting in PubSub.
const makeProgress = Effect.fn("TeamNative.streamProgress")(function* (baseline: number) {
  const drained = yield* Deferred.make<void>();
  let processed = baseline;
  let target: number | undefined;
  return {
    advance: (sequence: number) =>
      Effect.gen(function* () {
        processed = sequence;
        if (target !== undefined && processed >= target)
          yield* Deferred.succeed(drained, undefined);
      }),
    through: (sequence: number) =>
      Effect.gen(function* () {
        target = sequence;
        if (processed >= target) return;
        yield* Deferred.await(drained);
      }),
  };
});

export const nativeShellStream = Effect.fn("TeamNative.shellStream")(function* (
  connection: TeamNativeConnection,
  input: OrchestrationSubscribeShellInput,
) {
  yield* connection.check();
  const { engine, query } = connection;
  // Overflow must release the source even while the client stops pulling and
  // keeps its RPC scope open. Acquire before the baseline to preserve ordering.
  const liveScope = yield* Scope.fork(yield* Effect.scope);
  const live = yield* engine.subscribeDomainEvents.pipe(Scope.provide(liveScope));
  const baseline = yield* engine.latestSequence;
  const progress = yield* makeProgress(baseline);
  const budget = yield* makeLiveStreamBudget();
  const queue = yield* Queue.unbounded<
    RetainedLiveItem<ShellInput>,
    OrchestrationGetSnapshotError
  >();
  const close = Effect.gen(function* () {
    budget.release(yield* Queue.clear(queue).pipe(Effect.orDie));
    yield* Queue.shutdown(queue);
  });
  yield* Effect.addFinalizer(() => close);
  yield* live.pipe(
    Stream.filter((event) => event.sequence > baseline),
    Stream.map(shellEvent),
    Stream.runForEach((event) =>
      budget.retain({ kind: "event" as const, event }).pipe(
        Effect.flatMap((item) => Queue.offer(queue, item)),
        Effect.andThen(progress.advance(event.sequence)),
        Effect.uninterruptible,
      ),
    ),
    Effect.raceFirst(budget.failed),
    Effect.onExit((exit) => Scope.close(liveScope, exit)),
    Effect.catch(() => close),
    Effect.forkScoped,
  );

  const coalesce = Effect.fn("TeamNative.coalesceShell")(function* (
    inputs: ReadonlyArray<ShellInput>,
  ) {
    const output: Array<OrchestrationShellStreamItem> = [];
    const pending = new Map<string, ShellEvent>();
    const flush = Effect.gen(function* () {
      for (const event of [...pending.values()].sort((a, b) => a.sequence - b.sequence)) {
        yield* connection.check();
        let item: OrchestrationShellStreamEvent;
        if (event.aggregateKind === "project") {
          const project = yield* query.getProjectShellById(ProjectId.make(event.aggregateId));
          item = Option.isSome(project)
            ? { kind: "project-upserted", sequence: event.sequence, project: project.value }
            : {
                kind: "project-removed",
                sequence: event.sequence,
                projectId: ProjectId.make(event.aggregateId),
              };
        } else {
          const thread = yield* query.getThreadShellById(ThreadId.make(event.aggregateId));
          item = Option.isSome(thread)
            ? { kind: "thread-upserted", sequence: event.sequence, thread: thread.value }
            : {
                kind: "thread-removed",
                sequence: event.sequence,
                threadId: ThreadId.make(event.aggregateId),
              };
        }
        output.push(item);
      }
      pending.clear();
    });
    for (const item of inputs) {
      if (item.kind === "event")
        pending.set(`${item.event.aggregateKind}:${item.event.aggregateId}`, item.event);
      else {
        yield* flush;
        output.push(item);
      }
    }
    yield* flush;
    return output;
  });
  const tail = budget.deliver(
    Stream.fromQueue(queue).pipe(
      Stream.groupedWithin(512, "50 millis"),
      Stream.mapEffect((items) =>
        coalesce(items.map((item) => item.value)).pipe(
          Effect.flatMap((output) => budget.replace(items, output)),
        ),
      ),
      Stream.flatMap(Stream.fromIterable),
    ),
  );
  const completedTail = input.requestCompletionMarker
    ? Stream.unwrap(
        Effect.gen(function* () {
          yield* progress
            .through(yield* engine.latestSequence)
            .pipe(Effect.raceFirst(budget.failed));
          const marker = yield* budget.retain({ kind: "synchronized" as const });
          yield* Queue.offer(queue, marker);
          return tail;
        }),
      )
    : tail;
  const head = yield* engine.latestSequence;
  if (
    input.afterSequence !== undefined &&
    input.afterSequence <= head &&
    head - input.afterSequence <= MAX_REPLAY_EVENTS
  ) {
    const stats = yield* query.getEventReplayStats({
      fromSequenceExclusive: input.afterSequence,
      toSequenceInclusive: head,
    });
    if (stats.eventCount <= MAX_REPLAY_EVENTS && stats.payloadBytes <= MAX_REPLAY_BYTES) {
      const replay = engine.readEvents(input.afterSequence, head - input.afterSequence).pipe(
        Stream.takeWhile((event) => event.sequence <= head),
        Stream.map((event): ShellInput => ({ kind: "event", event: shellEvent(event) })),
        Stream.grouped(512),
        Stream.mapEffect(coalesce),
        Stream.flatMap(Stream.fromIterable),
      );
      return Stream.concat(replay, completedTail).pipe(Stream.mapError(streamFailure));
    }
  }
  const snapshot = yield* query.getShellSnapshot();
  return Stream.concat(Stream.make({ kind: "snapshot" as const, snapshot }), completedTail).pipe(
    Stream.mapError(streamFailure),
  );
});

export const nativeThreadStream = Effect.fn("TeamNative.threadStream")(function* (
  connection: TeamNativeConnection,
  input: OrchestrationSubscribeThreadInput,
) {
  yield* connection.check();
  yield* connection.requireThread(connection.projectId, input.threadId);
  const { engine, query } = connection;
  const liveScope = yield* Scope.fork(yield* Effect.scope);
  const live = yield* engine.subscribeDomainEvents.pipe(Scope.provide(liveScope));
  const baseline = yield* engine.latestSequence;
  const progress = yield* makeProgress(baseline);
  const coalescer = yield* makeThreadLiveEventCoalescer();
  const filter = (event: OrchestrationEvent) =>
    event.aggregateKind === "thread" &&
    event.aggregateId === input.threadId &&
    isThreadDetailEvent(event);
  yield* live.pipe(
    Stream.filter((event) => event.sequence > baseline),
    Stream.runForEachArray((events) =>
      coalescer
        .offerAll(events.filter(filter).map((event) => ({ kind: "event" as const, event })))
        .pipe(Effect.andThen(progress.advance(events[events.length - 1]!.sequence))),
    ),
    Effect.raceFirst(coalescer.failed),
    Effect.onExit((exit) => Scope.close(liveScope, exit)),
    Effect.catch(() => Effect.void),
    Effect.forkScoped,
  );
  const tail = input.requestCompletionMarker
    ? Stream.unwrap(
        Effect.gen(function* () {
          yield* progress
            .through(yield* engine.latestSequence)
            .pipe(Effect.raceFirst(coalescer.failed));
          yield* coalescer.offer({ kind: "synchronized" });
          return coalescer.stream;
        }),
      )
    : coalescer.stream;
  const head = yield* engine.latestSequence;
  if (input.afterSequence !== undefined && input.afterSequence <= head) {
    const range = {
      threadId: input.threadId,
      fromSequenceExclusive: input.afterSequence,
      toSequenceInclusive: head,
    };
    const stats = yield* engine.getThreadReplayStats({ ...range, maxEvents: MAX_REPLAY_EVENTS });
    if (
      !stats.hasCreateEvent &&
      stats.eventCount <= MAX_REPLAY_EVENTS &&
      stats.payloadBytes <= MAX_REPLAY_BYTES
    ) {
      const replay = engine.readThreadEvents({ ...range, limit: MAX_REPLAY_EVENTS }).pipe(
        Stream.filter(filter),
        Stream.map((event) => ({ kind: "event" as const, event: projectActivityEvent(event) })),
      );
      return Stream.concat(replay, tail).pipe(Stream.mapError(streamFailure));
    }
  }
  const snapshot = yield* query.getThreadDetailSnapshot(
    input.threadId,
    input.turnLimit === undefined ? undefined : { turnLimit: Math.min(input.turnLimit, 100) },
  );
  if (Option.isNone(snapshot)) return yield* streamFailure();
  return Stream.concat(
    Stream.make({
      kind: "snapshot" as const,
      snapshot: projectThreadDetailSnapshot(snapshot.value),
    }),
    tail,
  ).pipe(Stream.mapError(streamFailure));
});
