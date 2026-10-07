// @effect-diagnostics nodeBuiltinImport:off -- Hashes account identity without storing account credentials.
import * as NodeCrypto from "node:crypto";
import { CodexCloudBinding, CodexCloudError, CodexSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerSettings from "../serverSettings.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";

const decodeSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeAuth = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ tokens: Schema.Struct({ account_id: Schema.String }) })),
);

export class CodexCloudCli extends Context.Service<
  CodexCloudCli,
  {
    readonly identity: (binding: CodexCloudBinding) => Effect.Effect<string, CodexCloudError>;
    readonly run: (
      binding: CodexCloudBinding,
      args: ReadonlyArray<string>,
      cwd: string,
      fingerprint?: string,
    ) => Effect.Effect<string, CodexCloudError>;
  }
>()("t3/codexCloud/CodexCloudCli") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const resolve = Effect.fn("CodexCloudCli.resolve")(function* (binding: CodexCloudBinding) {
    const all = yield* settings.getSettings.pipe(
      Effect.mapError(() => new CodexCloudError({ code: "account" })),
    );
    const instance = all.providerInstances[binding.providerInstanceId];
    if (!instance || instance.driver !== "codex" || instance.enabled === false)
      return yield* new CodexCloudError({ code: "account" });
    const config = yield* decodeSettings(instance.config).pipe(
      Effect.mapError(() => new CodexCloudError({ code: "account" })),
    );
    if (!config.enabled || config.setupMode === "managed")
      return yield* new CodexCloudError({ code: "account" });
    const layout = yield* resolveCodexHomeLayout(config).pipe(
      Effect.provideService(Path.Path, path),
    );
    const home = layout.effectiveHomePath ?? layout.sharedHomePath;
    const raw = yield* fs
      .readFileString(`${home}/auth.json`)
      .pipe(Effect.mapError(() => new CodexCloudError({ code: "account" })));
    const auth = yield* decodeAuth(raw).pipe(
      Effect.mapError(() => new CodexCloudError({ code: "account" })),
    );
    if (!auth.tokens.account_id.trim()) return yield* new CodexCloudError({ code: "account" });
    const fingerprint = NodeCrypto.createHash("sha256")
      .update(auth.tokens.account_id)
      .digest("hex");
    return { config, home, fingerprint };
  });
  return CodexCloudCli.of({
    identity: (binding) => resolve(binding).pipe(Effect.map((r) => r.fingerprint)),
    run: Effect.fn("CodexCloudCli.run")(function* (binding, args, cwd, fingerprint) {
      const runtime = yield* resolve(binding);
      if (fingerprint !== undefined && fingerprint !== runtime.fingerprint)
        return yield* new CodexCloudError({ code: "task" });
      // Cloud commands must use this account's native CLI login, never ambient inference credentials.
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: runtime.home };
      for (const key of [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "ACCESS_TOKEN",
        "CODEX_API_KEY",
        "CODEX_AUTH_TOKEN",
        "CODEX_BACKEND_URL",
        "T3CODE_CODEX_LAUNCH_ARGS",
      ])
        delete env[key];
      const result = yield* runner
        .run({
          command: runtime.config.binaryPath,
          args: ["cloud", ...args],
          cwd,
          env,
          timeout: "45 seconds",
          maxOutputBytes: 180_000,
        })
        .pipe(Effect.mapError(() => new CodexCloudError({ code: "cli" })));
      if (result.code !== 0) {
        if (
          result.stderr.trim() ===
          `Error: environment '${binding.environmentId}' not found; run \`codex cloud\` to list available environments`
        )
          return yield* new CodexCloudError({ code: "environment" });
        return yield* new CodexCloudError({ code: "cli" });
      }
      return result.stdout;
    }),
  });
});
export const layer = Layer.effect(CodexCloudCli, make);
