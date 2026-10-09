import type { Session, WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ElectronDialog } from "../electron/ElectronDialog.ts";

const SavedChoice = Schema.Struct({
  origin: Schema.String,
  allowed: Schema.Boolean,
});
const SavedChoices = Schema.fromJsonString(Schema.Union([SavedChoice, Schema.Array(SavedChoice)]));
const decodeChoice = Schema.decodeUnknownOption(SavedChoices);
const encodeChoices = Schema.encodeSync(Schema.fromJsonString(Schema.Array(SavedChoice)));
const originOf = (url: string | undefined) => {
  try {
    if (!url) return null;
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
};
const isCurrentPage = (contents: WebContents | null, origin: string) =>
  Boolean(contents && !contents.isDestroyed() && originOf(contents.getURL()) === origin);

/** Owns one profile's microphone choice; no page can write this permission file. */
export const make = (browserSession: Session, allowedPermissions: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dialog = yield* ElectronDialog;
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    const file = browserSession.storagePath
      ? path.join(browserSession.storagePath, "t3code-microphone-permission.json")
      : null;
    const gate = yield* Semaphore.make(1);
    const saved = file
      ? yield* fs.readFileString(file).pipe(
          Effect.map(decodeChoice),
          Effect.catch(() => Effect.succeed(Option.none())),
        )
      : Option.none();
    const choices = new Map<string, boolean>();
    if (Option.isSome(saved)) {
      // Keep choices written by the original single-origin implementation.
      const entries = Array.isArray(saved.value) ? saved.value : [saved.value];
      for (const entry of entries) {
        if (originOf(entry.origin) === entry.origin) choices.set(entry.origin, entry.allowed);
      }
    }
    let generation = 0;
    const pending = new Map<string, Promise<boolean>>();

    const requestChoice = (contents: WebContents, origin: string) => {
      const choice = choices.get(origin);
      if (choice !== undefined) return Promise.resolve(choice);
      const existing = pending.get(origin);
      if (existing) return existing;
      const requestedGeneration = generation;
      const request = runPromise(
        Effect.gen(function* () {
          const result = yield* dialog.showMessageBox({
            type: "question",
            title: "Microphone access",
            message: `${origin} wants to use your microphone.`,
            detail:
              "Your choice is remembered for this browser profile. Camera access stays blocked.",
            buttons: ["Allow microphone", "Deny"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          });
          return yield* gate.withPermits(1)(
            Effect.gen(function* () {
              if (generation !== requestedGeneration || !isCurrentPage(contents, origin))
                return false;
              const allowed = result.response === 0;
              const nextChoices = new Map(choices);
              nextChoices.set(origin, allowed);
              if (file) {
                yield* fs.makeDirectory(path.dirname(file), { recursive: true });
                yield* fs.writeFileString(
                  `${file}.tmp`,
                  encodeChoices([...nextChoices].map(([origin, allowed]) => ({ origin, allowed }))),
                  { mode: 0o600 },
                );
                yield* fs.rename(`${file}.tmp`, file);
              }
              if (generation !== requestedGeneration) return false;
              choices.set(origin, allowed);
              return allowed;
            }),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Preview microphone permission could not be completed", error).pipe(
              Effect.as(false),
            ),
          ),
        ),
      ).finally(() => {
        pending.delete(origin);
      });
      pending.set(origin, request);
      return request;
    };

    browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission !== "media") {
        callback(allowedPermissions.has(permission));
        return;
      }
      const origin = originOf(details?.requestingUrl);
      // Mixed audio/video, missing media types, and subframes are never microphone grants.
      if (
        !details?.isMainFrame ||
        origin === null ||
        !("mediaTypes" in details) ||
        details.mediaTypes?.length !== 1 ||
        details.mediaTypes[0] !== "audio" ||
        (details.securityOrigin !== undefined && originOf(details.securityOrigin) !== origin) ||
        !isCurrentPage(contents, origin)
      ) {
        callback(false);
        return;
      }
      const requestedGeneration = generation;
      void requestChoice(contents, origin).then(
        (allowed) =>
          callback(
            allowed && generation === requestedGeneration && isCurrentPage(contents, origin),
          ),
        () => callback(false),
      );
    });
    browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      if (permission !== "media") return allowedPermissions.has(permission);
      const origin = originOf(requestingOrigin);
      return (
        origin !== null &&
        choices.get(origin) === true &&
        details?.mediaType === "audio" &&
        details.isMainFrame &&
        (details.requestingUrl === undefined || originOf(details.requestingUrl) === origin) &&
        (details.securityOrigin === undefined || originOf(details.securityOrigin) === origin) &&
        isCurrentPage(contents, origin)
      );
    });

    return {
      clear: Effect.suspend(() => {
        generation++;
        choices.clear();
        return gate.withPermits(1)(file ? fs.remove(file, { force: true }) : Effect.void);
      }),
    };
  });
