import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type CodexCloudBinding,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Settings from "../serverSettings.ts";
import * as Runner from "../processRunner.ts";
import * as CloudCli from "./CodexCloudCli.ts";

const encodeErrorCode = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String })),
);

const binding: CodexCloudBinding = {
  providerInstanceId: ProviderInstanceId.make("personal"),
  environmentId: "fixture-env",
  label: "Fixture",
  branch: "",
};

it.layer(NodeServices.layer)("cloud CLI accounts", (it) => {
  it.effect(
    "selects the private shadow login, removes ambient inference overrides, and rejects changed identity",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-cli-shared-" });
        const shadow = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-cli-private-" });
        yield* fs.writeFileString(
          `${home}/auth.json`,
          '{"tokens":{"account_id":"shared-account"}}',
        );
        yield* fs.writeFileString(
          `${shadow}/auth.json`,
          '{"tokens":{"account_id":"personal-account"}}',
        );
        const calls: Runner.ProcessRunInput[] = [];
        let failure: string | null = null;
        const cli = yield* CloudCli.CodexCloudCli.pipe(
          Effect.provide(
            CloudCli.layer.pipe(
              Layer.provide(
                Layer.mock(Settings.ServerSettingsService)({
                  getSettings: Effect.succeed({
                    ...DEFAULT_SERVER_SETTINGS,
                    providerInstances: {
                      personal: {
                        driver: ProviderDriverKind.make("codex"),
                        config: {
                          homePath: home,
                          shadowHomePath: shadow,
                          binaryPath: "fixture-codex",
                        },
                      },
                    },
                  }),
                }),
              ),
              Layer.provide(
                Layer.mock(Runner.ProcessRunner)({
                  run: (input) =>
                    Effect.sync(() => {
                      calls.push(input);
                      return {
                        stdout: "fixture response",
                        stderr: failure ?? "",
                        code: ChildProcessSpawner.ExitCode(failure === null ? 0 : 1),
                        timedOut: false,
                        stdoutTruncated: false,
                        stderrTruncated: false,
                        stdoutInvalidUtf8: false,
                        stderrInvalidUtf8: false,
                      };
                    }),
                }),
              ),
            ),
          ),
        );
        const fingerprint = yield* cli.identity(binding);
        yield* cli.run(binding, ["list", "--json"], home, fingerprint);
        assert.strictEqual(calls[0]?.command, "fixture-codex");
        assert.deepStrictEqual(calls[0]?.args, ["cloud", "list", "--json"]);
        assert.strictEqual(calls[0]?.env?.CODEX_HOME, shadow);
        for (const key of [
          "OPENAI_API_KEY",
          "OPENAI_BASE_URL",
          "CODEX_BACKEND_URL",
          "CODEX_AUTH_TOKEN",
          "T3CODE_CODEX_LAUNCH_ARGS",
        ])
          assert.strictEqual(calls[0]?.env?.[key], undefined);
        failure = `Error: environment '${binding.environmentId}' not found; run \`codex cloud\` to list available environments`;
        assert.strictEqual(
          (yield* cli
            .run(binding, ["exec", "--env", binding.environmentId], home, fingerprint)
            .pipe(Effect.flip)).code,
          "environment",
        );
        failure = "Network response lost after submission";
        assert.strictEqual(
          (yield* cli
            .run(binding, ["exec", "--env", binding.environmentId], home, fingerprint)
            .pipe(Effect.flip)).code,
          "cli",
        );
        yield* fs.writeFileString(
          `${shadow}/auth.json`,
          '{"tokens":{"account_id":"replacement-account"}}',
        );
        assert.strictEqual(
          (yield* cli.run(binding, ["diff", "task"], home, fingerprint).pipe(Effect.flip)).code,
          "task",
        );
        assert.strictEqual(calls.length, 3);
      }),
  );

  it.effect(
    "rejects managed-only accounts and returns safe errors for malformed native credentials",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-cli-invalid-" });
        yield* fs.writeFileString(
          `${home}/auth.json`,
          '{"tokens":{"access_token":"fixture-sensitive-value"}}',
        );
        for (const config of [{ homePath: home }, { homePath: home, setupMode: "managed" }]) {
          const cli = yield* CloudCli.CodexCloudCli.pipe(
            Effect.provide(
              CloudCli.layer.pipe(
                Layer.provide(
                  Layer.mock(Settings.ServerSettingsService)({
                    getSettings: Effect.succeed({
                      ...DEFAULT_SERVER_SETTINGS,
                      providerInstances: {
                        personal: { driver: ProviderDriverKind.make("codex"), config },
                      },
                    }),
                  }),
                ),
                Layer.provide(Layer.mock(Runner.ProcessRunner)({})),
              ),
            ),
          );
          const error = yield* cli.identity(binding).pipe(Effect.flip);
          assert.strictEqual(error.code, "account");
          const encoded = yield* encodeErrorCode(error);
          assert.strictEqual(encoded.includes("fixture-sensitive-value"), false);
          assert.strictEqual(Object.hasOwn(error, "cause"), false);
        }
      }),
  );
});
