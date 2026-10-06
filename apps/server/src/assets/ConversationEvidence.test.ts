import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as AttachmentStore from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ConversationEvidence from "./ConversationEvidence.ts";

const TestLayer = ConversationEvidence.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-conversation-evidence-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
const first = ThreadId.make("thread/one");
const second = ThreadId.make("thread-one");

describe("conversation evidence ownership and cleanup", () => {
  it.effect("isolates even ambiguous thread IDs and allocates a stable directory", () =>
    Effect.gen(function* () {
      const service = yield* ConversationEvidence.ConversationEvidence;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const a = yield* service.directory(first);
      const b = yield* service.directory(second);
      expect(a).not.toBe(b);
      expect(yield* service.directory(first)).toBe(a);
      expect(path.dirname(a)).toBe(path.join(config.stateDir, "conversation-evidence"));
      expect(path.basename(a)).toMatch(/^[a-f0-9]{64}$/);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "cleans nested evidence while preserving another thread, attachments and legacy captures",
    () =>
      Effect.gen(function* () {
        const service = yield* ConversationEvidence.ConversationEvidence;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const a = yield* service.directory(first);
        const b = yield* service.saveScreenshot(
          second,
          "https://example.test",
          new Uint8Array([1]),
        );
        const nested = path.join(a, "review");
        yield* fs.makeDirectory(nested);
        yield* fs.writeFileString(path.join(nested, "proof.webm"), "video");
        yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true });
        const upload = path.join(config.attachmentsDir, "user.png");
        const legacy = path.join(config.browserArtifactsDir, "legacy.png");
        yield* fs.writeFileString(upload, "upload");
        yield* fs.writeFileString(legacy, "legacy");
        expect(yield* service.clean(first, () => Effect.succeed(true))).toBe(1);
        expect(yield* fs.readDirectory(nested)).toEqual([]);
        expect(yield* fs.exists(a)).toBe(true);
        expect(yield* fs.readFileString(upload)).toBe("upload");
        expect(yield* fs.readFileString(legacy)).toBe("legacy");
        expect(yield* fs.exists(b)).toBe(true);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("expires files by age and preserves fresh evidence", () =>
    Effect.gen(function* () {
      const service = yield* ConversationEvidence.ConversationEvidence;
      const fs = yield* FileSystem.FileSystem;
      const old = yield* service.saveScreenshot(first, "https://example.test", new Uint8Array([1]));
      const fresh = yield* service.saveScreenshot(
        first,
        "https://example.test",
        new Uint8Array([2]),
      );
      yield* fs.utimes(old, 10, 10);
      yield* fs.utimes(fresh, 100, 100);
      expect(yield* service.clean(first, (mtime) => Effect.succeed(mtime < 50_000))).toBe(1);
      expect(yield* fs.exists(old)).toBe(false);
      expect(yield* fs.exists(fresh)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rechecks policy for each removal and skips all symlinks", () =>
    Effect.gen(function* () {
      const service = yield* ConversationEvidence.ConversationEvidence;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const directory = yield* service.directory(first);
      const other = yield* service.saveScreenshot(
        second,
        "https://example.test",
        new Uint8Array([1]),
      );
      const outside = path.join(config.stateDir, "outside");
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(path.join(outside, "keep.png"), "keep");
      yield* fs.symlink(outside, path.join(directory, "outside-link"));
      yield* fs.symlink(other, path.join(directory, "thread-link.png"));
      yield* fs.symlink(path.join(outside, "missing"), path.join(directory, "broken-link"));
      yield* fs.writeFileString(path.join(directory, "a.png"), "a");
      yield* fs.writeFileString(path.join(directory, "b.png"), "b");
      let enabled = true;
      expect(
        yield* service.clean(first, () =>
          Effect.sync(() => {
            const result = enabled;
            enabled = false;
            return result;
          }),
        ),
      ).toBe(1);
      expect(yield* fs.exists(other)).toBe(true);
      expect(yield* fs.readFileString(path.join(outside, "keep.png"))).toBe("keep");
      const remaining = yield* fs.readDirectory(directory);
      expect(remaining.filter((file) => file === "a.png" || file === "b.png")).toHaveLength(1);
      expect(remaining).toContain("broken-link");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses a replaced conversation directory and a replaced storage root", () =>
    Effect.gen(function* () {
      const service = yield* ConversationEvidence.ConversationEvidence;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const directory = yield* service.directory(first);
      const outside = path.join(config.stateDir, "outside");
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(path.join(outside, "keep.png"), "keep");
      yield* fs.remove(directory, { recursive: true });
      yield* fs.symlink(outside, directory);
      expect(
        (yield* service.clean(first, () => Effect.succeed(true)).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* service.directory(first).pipe(Effect.result))._tag).toBe("Failure");
      yield* fs.remove(path.dirname(directory), { recursive: true });
      yield* fs.symlink(outside, path.dirname(directory));
      expect(
        (yield* service
          .saveScreenshot(first, "https://example.test", new Uint8Array([1]))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* service.clean(first, () => Effect.succeed(true)).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* fs.readFileString(path.join(outside, "keep.png"))).toBe("keep");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects symlinked recordings without deleting their source", () =>
    Effect.gen(function* () {
      const service = yield* ConversationEvidence.ConversationEvidence;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      const outside = path.join(config.stateDir, "keep.webm");
      const uploadedId = AttachmentStore.createPendingAttachmentId(".webm");
      const pending = path.join(config.attachmentsDir, `${uploadedId}.webm`);
      yield* fs.writeFileString(outside, "video");
      yield* fs.symlink(outside, pending);
      const result = yield* service.claimRecording(first, uploadedId, 5).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* fs.readFileString(outside)).toBe("video");
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("supports a relocated state directory while rejecting symlinked upload files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      const relocated = path.join(path.dirname(config.stateDir), "relocated");
      yield* fs.symlink(config.stateDir, relocated);
      const uploadedId = AttachmentStore.createPendingAttachmentId(".webm");
      const pending = path.join(relocated, "attachments", `${uploadedId}.webm`);
      yield* fs.writeFileString(pending, "video");
      yield* Effect.gen(function* () {
        const service = yield* ConversationEvidence.ConversationEvidence;
        const owned = yield* service.directory(first);
        const recording = yield* service.claimRecording(first, uploadedId, 5);
        expect(path.dirname(recording.path)).toBe(owned);
        expect(yield* fs.readFileString(recording.path)).toBe("video");
        expect(yield* fs.exists(pending)).toBe(false);
      }).pipe(
        Effect.provide(
          Layer.fresh(ConversationEvidence.layer).pipe(
            Layer.provide(
              Layer.succeed(ServerConfig.ServerConfig, {
                ...config,
                stateDir: relocated,
                attachmentsDir: path.join(relocated, "attachments"),
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("cleanup of one conversation does not block another conversation's captures", () =>
    Effect.gen(function* () {
      const service = yield* ConversationEvidence.ConversationEvidence;
      const fs = yield* FileSystem.FileSystem;
      const cleaning = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      yield* service.saveScreenshot(first, "https://example.test", new Uint8Array([1]));
      const fiber = yield* service
        .clean(first, () =>
          Deferred.succeed(cleaning, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as(true),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(cleaning);
      const other = yield* service.saveScreenshot(
        second,
        "https://example.test",
        new Uint8Array([2]),
      );
      expect(yield* fs.exists(other)).toBe(true);
      yield* Deferred.succeed(resume, undefined);
      expect(yield* Fiber.join(fiber)).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );
});
