import type { Session, WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ElectronDialog } from "../electron/ElectronDialog.ts";

const MICROPHONE_ORIGIN = "http://127.0.0.1:5274";
const SavedChoice = Schema.fromJsonString(
  Schema.Struct({ origin: Schema.Literal(MICROPHONE_ORIGIN), allowed: Schema.Boolean }),
);
const decodeChoice = Schema.decodeUnknownOption(SavedChoice);
const encodeChoice = Schema.encodeSync(SavedChoice);
const originOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};
const isCurrentPage = (contents: WebContents | null) =>
  Boolean(contents && !contents.isDestroyed() && originOf(contents.getURL()) === MICROPHONE_ORIGIN);

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
    let choice: boolean | undefined = Option.isSome(saved) ? saved.value.allowed : undefined;
    let generation = 0;
    let pending: Promise<boolean> | null = null;

    const requestChoice = (contents: WebContents) => {
      if (choice !== undefined) return Promise.resolve(choice);
      if (pending) return pending;
      const requestedGeneration = generation;
      pending = runPromise(
        Effect.gen(function* () {
          const result = yield* dialog.showMessageBox({
            type: "question",
            title: "Microphone access",
            message: `${MICROPHONE_ORIGIN} wants to use your microphone.`,
            detail:
              "Your choice is remembered for this browser profile. Camera access stays blocked.",
            buttons: ["Allow microphone", "Deny"],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          });
          return yield* gate.withPermits(1)(
            Effect.gen(function* () {
              if (generation !== requestedGeneration || !isCurrentPage(contents)) return false;
              const allowed = result.response === 0;
              if (file) {
                yield* fs.makeDirectory(path.dirname(file), { recursive: true });
                yield* fs.writeFileString(
                  `${file}.tmp`,
                  encodeChoice({ origin: MICROPHONE_ORIGIN, allowed }),
                  { mode: 0o600 },
                );
                yield* fs.rename(`${file}.tmp`, file);
              }
              if (generation !== requestedGeneration) return false;
              choice = allowed;
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
        pending = null;
      });
      return pending;
    };

    browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission !== "media") {
        callback(allowedPermissions.has(permission));
        return;
      }
      // Mixed audio/video, missing media types, and subframes are never microphone grants.
      if (
        !details?.isMainFrame ||
        originOf(details.requestingUrl) !== MICROPHONE_ORIGIN ||
        !("mediaTypes" in details) ||
        details.mediaTypes?.length !== 1 ||
        details.mediaTypes[0] !== "audio" ||
        (details.securityOrigin !== undefined &&
          originOf(details.securityOrigin) !== MICROPHONE_ORIGIN) ||
        !isCurrentPage(contents)
      ) {
        callback(false);
        return;
      }
      const requestedGeneration = generation;
      void requestChoice(contents).then(
        (allowed) =>
          callback(allowed && generation === requestedGeneration && isCurrentPage(contents)),
        () => callback(false),
      );
    });
    browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      if (permission !== "media") return allowedPermissions.has(permission);
      return (
        choice === true &&
        details?.mediaType === "audio" &&
        details.isMainFrame &&
        originOf(requestingOrigin) === MICROPHONE_ORIGIN &&
        (details.requestingUrl === undefined ||
          originOf(details.requestingUrl) === MICROPHONE_ORIGIN) &&
        (details.securityOrigin === undefined ||
          originOf(details.securityOrigin) === MICROPHONE_ORIGIN) &&
        isCurrentPage(contents)
      );
    });

    return {
      clear: Effect.suspend(() => {
        generation++;
        choice = undefined;
        return gate.withPermits(1)(file ? fs.remove(file, { force: true }) : Effect.void);
      }),
    };
  });
