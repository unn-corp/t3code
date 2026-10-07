// @effect-diagnostics nodeBuiltinImport:off - This Node-only server module uses synchronous host crypto for persistent IDs or hashes; replacing it would add Crypto service requirements through the persistence API.
import * as NodeCrypto from "node:crypto";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as AttachmentStore from "../attachmentStore.ts";
import * as AttachmentPaths from "../attachmentPaths.ts";
import * as ServerConfig from "../config.ts";

export class ConversationEvidenceError extends Schema.TaggedError<ConversationEvidenceError>()(
  "ConversationEvidenceError",
  { threadId: Schema.String, cause: Schema.Defect() },
) {}

class EvidencePathError extends Schema.TaggedError<EvidencePathError>()("EvidencePathError", {
  message: Schema.String,
}) {}

export class ConversationEvidence extends Context.Service<
  ConversationEvidence,
  {
    readonly directory: (threadId: ThreadId) => Effect.Effect<string, ConversationEvidenceError>;
    readonly saveScreenshot: (
      threadId: ThreadId,
      pageUrl: string,
      bytes: Uint8Array,
    ) => Effect.Effect<string, ConversationEvidenceError>;
    readonly claimRecording: (
      threadId: ThreadId,
      uploadedAttachmentId: string,
      sizeBytes: number,
    ) => Effect.Effect<{ readonly id: string; readonly path: string }, ConversationEvidenceError>;
    /** Recheck thread activity and policy immediately before each file removal. */
    readonly clean: (
      threadId: ThreadId,
      shouldRemove: (modifiedAt: number) => Effect.Effect<boolean>,
    ) => Effect.Effect<number, ConversationEvidenceError>;
  }
>()("t3/assets/ConversationEvidence") {}

const siteSlug = (rawUrl: string): string => {
  try {
    return (
      new URL(rawUrl).hostname
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/g, "") || "site"
    );
  } catch {
    return "site";
  }
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Use the physical state directory, including when a user relocated it with a symlink.
  yield* fs.makeDirectory(config.stateDir, { recursive: true });
  const stateRoot = yield* fs.realPath(config.stateDir);
  const root = path.join(stateRoot, "conversation-evidence");
  const gates = new Map<ThreadId, Semaphore.Semaphore>();
  const withThreadLock = <A, E>(threadId: ThreadId, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      let gate = gates.get(threadId);
      if (gate === undefined) {
        gate = Semaphore.makeUnsafe(1);
        gates.set(threadId, gate);
      }
      return gate.withPermits(1)(effect);
    });
  const ownedDirectory = (threadId: ThreadId) =>
    path.join(root, NodeCrypto.createHash("sha256").update(threadId).digest("hex"));
  const failure = (threadId: ThreadId, cause: unknown) =>
    new ConversationEvidenceError({ threadId, cause });
  const checkDirectory = Effect.fn("ConversationEvidence.checkDirectory")(function* (
    target: string,
  ) {
    if ((yield* fs.realPath(target)) !== target || (yield* fs.stat(target)).type !== "Directory") {
      return yield* Effect.fail(
        new EvidencePathError({ message: "Evidence directories must not be symlinks." }),
      );
    }
  });
  const directory = Effect.fn("ConversationEvidence.directory")(function* (threadId: ThreadId) {
    yield* fs.makeDirectory(root, { recursive: true });
    yield* checkDirectory(root);
    const target = ownedDirectory(threadId);
    yield* fs.makeDirectory(target, { recursive: true });
    yield* checkDirectory(target);
    return target;
  });
  const saveScreenshot = Effect.fn("ConversationEvidence.saveScreenshot")(function* (
    threadId: ThreadId,
    pageUrl: string,
    bytes: Uint8Array,
  ) {
    const target = yield* directory(threadId);
    const millis = yield* Clock.currentTimeMillis;
    const name = `browser-screenshot-${siteSlug(pageUrl)}-${millis.toString(36)}-${NodeCrypto.randomUUID().slice(0, 8)}.png`;
    const screenshotPath = path.join(target, name);
    yield* fs.writeFile(screenshotPath, bytes, { flag: "wx" });
    return screenshotPath;
  });
  const claimRecording = Effect.fn("ConversationEvidence.claimRecording")(function* (
    threadId: ThreadId,
    uploadedAttachmentId: string,
    sizeBytes: number,
  ) {
    const uuid = AttachmentStore.parseAttachmentUuid(uploadedAttachmentId);
    const extension = AttachmentStore.parseAttachmentFileExtension(uploadedAttachmentId);
    const threadSegment = AttachmentStore.toSafeThreadAttachmentSegment(threadId);
    const pendingId = `${AttachmentStore.PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}-${extension}`;
    const pendingPath = AttachmentPaths.resolveAttachmentRelativePath({
      attachmentsDir: config.attachmentsDir,
      relativePath: `${pendingId}.${extension}`,
    });
    if (
      !uuid ||
      !extension ||
      !threadSegment ||
      uploadedAttachmentId !== pendingId ||
      pendingPath === null ||
      sizeBytes <= 0 ||
      sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES
    ) {
      return yield* Effect.fail(new EvidencePathError({ message: "Invalid recording upload." }));
    }
    const target = yield* directory(threadId);
    const id = `${threadSegment}-${uuid}-${extension}`;
    const finalPath = path.join(target, `${id}.${extension}`);
    const validate = Effect.fn(function* (filePath: string) {
      if ((yield* fs.realPath(filePath)) !== filePath) {
        return yield* Effect.fail(
          new EvidencePathError({ message: "Evidence files must not be symlinks." }),
        );
      }
      const stat = yield* fs.stat(filePath);
      if (stat.type !== "File" || Number(stat.size) !== sizeBytes || sizeBytes <= 0) {
        return yield* Effect.fail(
          new EvidencePathError({ message: "Incomplete recording upload." }),
        );
      }
    });
    // A stop request may be retried after another request claimed this exact upload.
    if (yield* fs.exists(pendingPath)) {
      const attachmentsRoot = yield* fs.realPath(config.attachmentsDir);
      const canonicalSource = yield* fs.realPath(pendingPath);
      if (
        path.dirname(path.resolve(pendingPath)) !== path.resolve(config.attachmentsDir) ||
        canonicalSource !== path.join(attachmentsRoot, path.basename(pendingPath))
      ) {
        return yield* Effect.fail(
          new EvidencePathError({ message: "Recording must be a pending attachment upload." }),
        );
      }
      yield* validate(canonicalSource);
      yield* fs.rename(canonicalSource, finalPath);
    } else {
      yield* validate(finalPath);
    }
    return { id, path: finalPath };
  });
  const clean = Effect.fn("ConversationEvidence.clean")(function* (
    threadId: ThreadId,
    shouldRemove: (modifiedAt: number) => Effect.Effect<boolean>,
  ) {
    if (!(yield* fs.exists(root))) return 0;
    yield* checkDirectory(root);
    const target = ownedDirectory(threadId);
    if (!(yield* fs.exists(target))) return 0;
    yield* checkDirectory(target);
    let removed = 0;
    const visit = Effect.fn("ConversationEvidence.visit")(function* (
      folder: string,
    ): Effect.fn.Return<void, PlatformError | EvidencePathError> {
      for (const name of yield* fs.readDirectory(folder)) {
        const filePath = path.join(folder, name);
        // Never follow symlinks, including links to another conversation's evidence.
        if ((yield* fs.realPath(filePath).pipe(Effect.orElseSucceed(() => null))) !== filePath)
          continue;
        const stat = yield* fs.stat(filePath);
        if (stat.type === "Directory") {
          yield* visit(filePath);
        } else if (stat.type === "File") {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && (yield* shouldRemove(modified.getTime()))) {
            yield* checkDirectory(root);
            yield* checkDirectory(target);
            yield* checkDirectory(folder);
            if ((yield* fs.realPath(filePath)) !== filePath) continue;
            yield* fs.remove(filePath);
            removed += 1;
          }
        }
      }
    });
    yield* visit(target);
    // Keep the allocated directory stable for tools and resumed threads.
    return removed;
  });
  return ConversationEvidence.of({
    directory: (id) =>
      directory(id).pipe(
        (effect) => withThreadLock(id, effect),
        Effect.mapError((e) => failure(id, e)),
      ),
    saveScreenshot: (id, url, bytes) =>
      saveScreenshot(id, url, bytes).pipe(
        (effect) => withThreadLock(id, effect),
        Effect.mapError((e) => failure(id, e)),
      ),
    claimRecording: (id, uploadedAttachmentId, size) =>
      claimRecording(id, uploadedAttachmentId, size).pipe(
        (effect) => withThreadLock(id, effect),
        Effect.mapError((e) => failure(id, e)),
      ),
    clean: (id, predicate) =>
      clean(id, predicate).pipe(
        (effect) => withThreadLock(id, effect),
        Effect.mapError((e) => failure(id, e)),
      ),
  });
});

export const layer = Layer.effect(ConversationEvidence, make);
