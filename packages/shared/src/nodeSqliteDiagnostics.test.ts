import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Tracer from "effect/Tracer";
import * as Diagnostics from "./nodeSqliteDiagnostics.ts";

it.effect("records successful and failed calls, bounds warnings, and preserves results", () =>
  Effect.gen(function* () {
    let time = 0;
    const measure = Diagnostics.make(() => time);
    const messages: unknown[] = [];
    const spans: Tracer.NativeSpan[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const timer = Metric.withAttributes(Diagnostics.operationDuration, { operation: "execute" });
    const before = yield* Metric.value(timer);
    yield* Effect.gen(function* () {
      assert.equal(
        yield* measure(
          "execute",
          () => {
            time += 300;
            return 42;
          },
          () => "unexpected failure",
        ),
        42,
      );
      const error = yield* measure(
        "execute",
        () => {
          time += 400;
          throw new Error("private SQL or parameter");
        },
        () => "private SQL or parameter",
      ).pipe(Effect.flip);
      assert.equal(error, "private SQL or parameter");
      time += 60_000;
      const failed = yield* measure(
        "execute",
        () => {
          time += 500;
          throw new Error("private failed SQL");
        },
        () => "private failed SQL",
      ).pipe(Effect.flip);
      assert.equal(failed, "private failed SQL");
      yield* measure(
        "execute",
        () => {
          time += 10;
        },
        () => "unexpected failure",
      );
    }).pipe(Effect.provide(Logger.layer([logger])), Effect.withTracer(tracer));
    const after = yield* Metric.value(timer);
    assert.equal(after.count - before.count, 4);
    assert.equal(after.sum - before.sum, 1210);
    assert.equal(messages.length, 2);
    assert.equal(spans.length, 2);
    assert.deepEqual(
      spans.map((span) => span.name),
      ["sqlite.operation.slow", "sqlite.operation.slow"],
    );
    assert.deepEqual(Object.fromEntries(spans[0]!.attributes), {
      operation: "execute",
      durationMs: 300,
      outcome: "success",
    });
    assert.equal(spans[1]!.attributes.get("outcome"), "failure");
    // @effect-diagnostics-next-line preferSchemaOverJson:off - check emitted diagnostics for private data.
    assert.notInclude(JSON.stringify(messages), "private SQL or parameter");
  }),
);
