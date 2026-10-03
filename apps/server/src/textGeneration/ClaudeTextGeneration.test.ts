import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { it } from "@effect/vitest";
import {
  ClaudeSettings,
  OrganizationId,
  OrganizationRoleId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessPlatform, isHostWindows } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import {
  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
  SYNTHETIC_CLAUDE_THINKING_MODEL,
} from "../provider/ClaudeModelCatalog.testFixtures.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { sanitizeThreadTitle } from "./TextGenerationUtils.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { OrganizationPatchProcessObserver } from "./OrganizationPatchProcessObserver.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const architectInput = {
  modelSelection: createModelSelection(
    ProviderInstanceId.make("claudeAgent"),
    SYNTHETIC_CLAUDE_STANDARD_MODEL,
  ),
  organization: {
    id: OrganizationId.make("org-architect-test"),
    title: "Studio",
    mission: "Build useful software",
    draftRevision: 3,
    workflows: [],
    graph: {
      roles: [
        {
          id: OrganizationRoleId.make("architect"),
          kind: "architect" as const,
          title: "Architect",
          mandate: "Design the organization",
          poolSize: 1,
        },
      ],
      edges: [],
    },
  },
  transcript: [{ role: "user" as const, text: "We need a QA role." }],
  userText: "Suggest a plan.",
};

const patchCurrentContent = "export const answer = 1;\n";
const patchBaseDigest = NodeCrypto.createHash("sha256").update(patchCurrentContent).digest("hex");
const patchInput = {
  modelSelection: createModelSelection(
    ProviderInstanceId.make("claudeAgent"),
    SYNTHETIC_CLAUDE_STANDARD_MODEL,
  ),
  taskText: "Change answer to 2.",
  fileName: "answer.js",
  currentContent: patchCurrentContent,
  baseDigest: patchBaseDigest,
};

const ClaudeTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-claude-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

// The stub behaviour lives in Node so the same implementation runs on Windows,
// where a shebang file is not executable and would fall through to the real
// Claude CLI on PATH; `writeFakeCli` picks the launcher shape per host.
function makeFakeClaudeBinary(dir: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const binDir = path.join(dir, "bin");
    writeFakeCli({
      directory: binDir,
      name: "claude",
      platform,
      source: [
        "const argv = process.argv.slice(2);",
        'const args = argv.join(" ");',
        'const { realpathSync } = await import("node:fs");',
        "",
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        "",
        'const permissionIndex = argv.indexOf("--permission-mode");',
        'if (permissionIndex === -1 || argv[permissionIndex + 1] !== "dontAsk") {',
        '  fail("text generation must deny permission prompts", 12);',
        "}",
        'const toolsIndex = argv.indexOf("--tools");',
        'if (toolsIndex === -1 || argv[toolsIndex + 1] !== "") {',
        '  fail("text generation must receive an explicit empty tool set", 6);',
        "}",
        'if (argv.includes("--dangerously-skip-permissions")) {',
        '  fail("text generation must not bypass permissions", 7);',
        "}",
        'if (!argv.includes("--disable-slash-commands")) {',
        '  fail("text generation must disable skills", 8);',
        "}",
        'if (!argv.includes("--strict-mcp-config")) {',
        '  fail("text generation must not load configured MCP servers", 9);',
        "}",
        'const settingsIndex = argv.indexOf("--settings");',
        "if (settingsIndex === -1 || JSON.parse(argv[settingsIndex + 1]).disableAllHooks !== true) {",
        '  fail("text generation must disable hooks", 10);',
        "}",
        "const cwdMustNotBe = process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;",
        "if (cwdMustNotBe && realpathSync(process.cwd()) === realpathSync(cwdMustNotBe)) {",
        '  fail("text generation ran in the project directory", 11);',
        "}",
        "",
        'let stdinContent = "";',
        "if (!process.stdin.isTTY) {",
        "  const chunks = [];",
        "  for await (const chunk of process.stdin) {",
        "    chunks.push(chunk);",
        "  }",
        '  stdinContent = Buffer.concat(chunks).toString("utf8");',
        "}",
        "",
        "const argsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;",
        "if (argsMustContain && !args.includes(argsMustContain)) {",
        '  fail("args missing expected content", 2);',
        "}",
        "",
        "const argsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;",
        "if (argsMustNotContain && args.includes(argsMustNotContain)) {",
        '  fail("args contained forbidden content", 3);',
        "}",
        "",
        "const stdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;",
        "if (stdinMustContain && !stdinContent.includes(stdinMustContain)) {",
        '  fail("stdin missing expected content", 4);',
        "}",
        "",
        "const configDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;",
        "if (configDirMustBe && process.env.CLAUDE_CONFIG_DIR !== configDirMustBe) {",
        '  fail("CLAUDE_CONFIG_DIR was " + (process.env.CLAUDE_CONFIG_DIR ?? ""), 5);',
        "}",
        "",
        "const stderrText = process.env.T3_FAKE_CLAUDE_STDERR;",
        "if (process.env.T3_FAKE_CLAUDE_WAIT_FOR_SIGNAL) await new Promise(() => {});",
        "if (stderrText) {",
        '  process.stderr.write(stderrText + "\\n");',
        "}",
        "",
        'process.stdout.write(process.env.T3_FAKE_CLAUDE_OUTPUT_REPEAT ? "x".repeat(Number(process.env.T3_FAKE_CLAUDE_OUTPUT_REPEAT)) : (process.env.T3_FAKE_CLAUDE_OUTPUT ?? ""));',
        "process.exitCode = Number(process.env.T3_FAKE_CLAUDE_EXIT_CODE ?? 0);",
        "",
      ].join("\n"),
    });
    return binDir;
  });
}

function withFakeClaudeEnv<A, E, R>(
  input: {
    output: string;
    outputRepeat?: number;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    argsMustNotContain?: string;
    stdinMustContain?: string;
    configDirMustBe?: string;
    cwdMustNotBe?: string;
    waitForSignal?: boolean;
    claudeConfig?: Partial<ClaudeSettings>;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-claude-text-" });
    const binDir = yield* makeFakeClaudeBinary(tempDir);
    const pathDelimiter = (yield* isHostWindows) ? ";" : ":";
    const previousPath = process.env.PATH;
    const previousOutput = process.env.T3_FAKE_CLAUDE_OUTPUT;
    const previousOutputRepeat = process.env.T3_FAKE_CLAUDE_OUTPUT_REPEAT;
    const previousExitCode = process.env.T3_FAKE_CLAUDE_EXIT_CODE;
    const previousStderr = process.env.T3_FAKE_CLAUDE_STDERR;
    const previousArgsMustContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
    const previousArgsMustNotContain = process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
    const previousStdinMustContain = process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
    const previousConfigDirMustBe = process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
    const previousCwdMustNotBe = process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
    const previousWaitForSignal = process.env.T3_FAKE_CLAUDE_WAIT_FOR_SIGNAL;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${binDir}${pathDelimiter}${previousPath ?? ""}`;
        process.env.T3_FAKE_CLAUDE_OUTPUT = input.output;
        if (input.waitForSignal) process.env.T3_FAKE_CLAUDE_WAIT_FOR_SIGNAL = "1";
        else delete process.env.T3_FAKE_CLAUDE_WAIT_FOR_SIGNAL;
        if (input.outputRepeat !== undefined) {
          process.env.T3_FAKE_CLAUDE_OUTPUT_REPEAT = String(input.outputRepeat);
        } else {
          delete process.env.T3_FAKE_CLAUDE_OUTPUT_REPEAT;
        }

        if (input.exitCode !== undefined) {
          process.env.T3_FAKE_CLAUDE_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDERR = input.stderr;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
        }

        if (input.argsMustNotContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = input.argsMustNotContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
        }

        if (input.cwdMustNotBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE = input.cwdMustNotBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
        }

        if (input.configDirMustBe !== undefined) {
          process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = input.configDirMustBe;
        } else {
          delete process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
        }
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;

          if (previousOutput === undefined) {
            delete process.env.T3_FAKE_CLAUDE_OUTPUT;
          } else {
            process.env.T3_FAKE_CLAUDE_OUTPUT = previousOutput;
          }
          if (previousOutputRepeat === undefined) {
            delete process.env.T3_FAKE_CLAUDE_OUTPUT_REPEAT;
          } else {
            process.env.T3_FAKE_CLAUDE_OUTPUT_REPEAT = previousOutputRepeat;
          }

          if (previousWaitForSignal === undefined) {
            delete process.env.T3_FAKE_CLAUDE_WAIT_FOR_SIGNAL;
          } else {
            process.env.T3_FAKE_CLAUDE_WAIT_FOR_SIGNAL = previousWaitForSignal;
          }

          if (previousExitCode === undefined) {
            delete process.env.T3_FAKE_CLAUDE_EXIT_CODE;
          } else {
            process.env.T3_FAKE_CLAUDE_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDERR;
          } else {
            process.env.T3_FAKE_CLAUDE_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }

          if (previousArgsMustNotContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_ARGS_MUST_NOT_CONTAIN = previousArgsMustNotContain;
          }

          if (previousStdinMustContain === undefined) {
            delete process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_CLAUDE_STDIN_MUST_CONTAIN = previousStdinMustContain;
          }

          if (previousCwdMustNotBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_CWD_MUST_NOT_BE = previousCwdMustNotBe;
          }

          if (previousConfigDirMustBe === undefined) {
            delete process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE;
          } else {
            process.env.T3_FAKE_CLAUDE_CONFIG_DIR_MUST_BE = previousConfigDirMustBe;
          }
        }),
    );

    const config = decodeClaudeSettings(input.claudeConfig ?? {});
    const textGeneration = yield* makeClaudeTextGeneration(
      config,
      undefined,
      Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(ClaudeTextGenerationTestLayer)("ClaudeTextGeneration", (it) => {
  it.effect("interrupts and verifies exact patch CLI exit", () =>
    withFakeClaudeEnv({ output: "", waitForSignal: true }, (textGeneration) =>
      Effect.gen(function* () {
        const spawned = yield* Deferred.make<number>();
        const exited = yield* Deferred.make<number>();
        const observer = {
          environment: { T3_ORG_PROVIDER_LAUNCH_ID: "disposable-claude-marker" },
          preparing: () => Effect.void,
          spawned: (handle: ChildProcessSpawner.ChildProcessHandle) =>
            Deferred.succeed(spawned, handle.pid).pipe(Effect.asVoid),
          exited: (handle: ChildProcessSpawner.ChildProcessHandle) =>
            Effect.gen(function* () {
              expect(yield* handle.isRunning.pipe(Effect.orDie)).toBe(false);
              yield* Deferred.succeed(exited, handle.pid);
            }),
        };
        const fiber = yield* textGeneration.generateOrganizationPatchProposal!(patchInput).pipe(
          Effect.provideService(OrganizationPatchProcessObserver, observer),
          Effect.forkChild,
        );
        const processId = yield* Deferred.await(spawned);
        yield* Fiber.interrupt(fiber);
        expect(yield* Deferred.await(exited)).toBe(processId);
      }),
    ),
  );
  it.effect("verifies the patch CLI exit through the live observer", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            fileName: "answer.js",
            baseDigest: patchBaseDigest,
            replacementContent: "export const answer = 2;\n",
            rationale: "Updates the answer.",
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const seen: string[] = [];
          const observer = {
            environment: { T3_ORG_PROVIDER_LAUNCH_ID: "disposable-claude-marker" },
            preparing: () =>
              Effect.sync(() => {
                seen.push("preparing");
              }),
            spawned: (handle: ChildProcessSpawner.ChildProcessHandle) =>
              Effect.sync(() => {
                seen.push(`spawned:${handle.pid}`);
              }),
            exited: (handle: ChildProcessSpawner.ChildProcessHandle) =>
              Effect.gen(function* () {
                expect(yield* handle.isRunning.pipe(Effect.orDie)).toBe(false);
                seen.push(`exited:${handle.pid}`);
              }),
          };
          yield* textGeneration.generateOrganizationPatchProposal!(patchInput).pipe(
            Effect.provideService(OrganizationPatchProcessObserver, observer),
          );
          expect(seen[0]).toBe("preparing");
          expect(seen[1]).toMatch(/^spawned:\d+$/);
          expect(seen[2]).toBe(`exited:${seen[1]!.slice(8)}`);
        }),
    ),
  );
  it.effect("proposes one bounded file replacement without checkout or tools", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            fileName: "answer.js",
            baseDigest: patchBaseDigest,
            replacementContent: "export const answer = 2;\n",
            rationale: "Updates the answer.",
          },
        }),
        cwdMustNotBe: process.cwd(),
        stdinMustContain: "Change answer to 2.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generate = textGeneration.generateOrganizationPatchProposal;
          expect(generate).toBeDefined();
          if (!generate) return;
          const proposal = yield* generate(patchInput);
          expect(proposal.fileName).toBe("answer.js");
          expect(proposal.replacementContent).toContain("2");
        }),
    ),
  );

  it.effect("rejects patch path, digest, source hash and byte-limit violations", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            fileName: "../secret",
            baseDigest: patchBaseDigest,
            replacementContent: "changed",
            rationale: "wrong path",
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generate = textGeneration.generateOrganizationPatchProposal;
          if (!generate) return;
          expect((yield* Effect.flip(generate(patchInput))).detail).toContain("invalid structured");
          expect(
            (yield* Effect.flip(generate({ ...patchInput, baseDigest: "0".repeat(64) }))).detail,
          ).toContain("digest");
          expect(
            (yield* Effect.flip(generate({ ...patchInput, fileName: "../escape" }))).detail,
          ).toContain("invalid");
        }),
    ),
  );

  it.effect("rejects validly shaped patch output for another file or digest", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            fileName: "other.js",
            baseDigest: patchBaseDigest,
            replacementContent: "changed",
            rationale: "wrong file",
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generate = textGeneration.generateOrganizationPatchProposal;
          if (!generate) return;
          expect((yield* Effect.flip(generate(patchInput))).detail).toContain("does not match");
        }),
    ),
  );

  it.effect("caps raw patch subprocess output", () =>
    withFakeClaudeEnv(
      {
        output: "",
        outputRepeat: 262_145,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generate = textGeneration.generateOrganizationPatchProposal;
          if (!generate) return;
          expect((yield* Effect.flip(generate(patchInput))).detail).toContain("size limit");
        }),
    ),
  );
  it.effect("generates revision-bound Architect proposals without checkout or tools", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            reply: "Add quality review before integration.",
            proposals: [{ baseRevision: 3, change: { type: "set-title", title: "Studio Team" } }],
          },
        }),
        cwdMustNotBe: process.cwd(),
        stdinMustContain: "Suggest a plan.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generate = textGeneration.generateOrganizationArchitectTurn;
          expect(generate).toBeDefined();
          if (!generate) return;
          const result = yield* generate(architectInput);
          expect(result.reply).toContain("quality review");
          expect(result.proposals[0]?.baseRevision).toBe(3);
        }),
    ),
  );

  it.effect("rejects Architect proposals for another draft revision", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            reply: "Here is a suggestion.",
            proposals: [{ baseRevision: 2, change: { type: "set-title", title: "Studio Team" } }],
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generate = textGeneration.generateOrganizationArchitectTurn;
          if (!generate) return;
          const error = yield* Effect.flip(generate(architectInput));
          expect(error.detail).toContain("revision");
        }),
    ),
  );

  it.effect("rejects disallowed Architect changes and oversized output", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            reply: "Remove the role.",
            proposals: [{ baseRevision: 3, change: { type: "remove-role", roleId: "architect" } }],
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generate = textGeneration.generateOrganizationArchitectTurn;
          if (!generate) return;
          const error = yield* Effect.flip(generate(architectInput));
          expect(error.detail).toContain("invalid structured output");
        }),
    ),
  );

  it.effect("rejects Architect inputs beyond the byte limit before spawning", () =>
    withFakeClaudeEnv({ output: "" }, (textGeneration) =>
      Effect.gen(function* () {
        const generate = textGeneration.generateOrganizationArchitectTurn;
        if (!generate) return;
        const error = yield* Effect.flip(
          generate({ ...architectInput, userText: "x".repeat(4_001) }),
        );
        expect(error.detail).toContain("4,000 UTF-8 bytes");
      }),
    ),
  );

  it.effect("caps Architect subprocess output", () =>
    withFakeClaudeEnv({ output: "x".repeat(64_001) }, (textGeneration) =>
      Effect.gen(function* () {
        const generate = textGeneration.generateOrganizationArchitectTurn;
        if (!generate) return;
        const error = yield* Effect.flip(generate(architectInput));
        expect(error.detail).toContain("size limit");
      }),
    ),
  );

  it.effect("forwards Claude thinking settings without passing unsupported effort", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            subject: "Add important change",
            body: "",
          },
        }),
        argsMustContain: '--settings {"disableAllHooks":true,"alwaysThinkingEnabled":false}',
        argsMustNotContain: "--effort",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/claude-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: {
              ...createModelSelection(
                ProviderInstanceId.make("claudeAgent"),
                SYNTHETIC_CLAUDE_THINKING_MODEL,
                [
                  { id: "thinking", value: false },
                  { id: "effort", value: "high" },
                ],
              ),
            },
          });

          expect(generated.subject).toBe("Add important change");
        }),
    ),
  );

  it.effect("keeps a configured custom alias opaque to the Claude CLI", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: "Keep custom model",
            body: "",
          },
        }),
        argsMustContain: `--model ${SYNTHETIC_CLAUDE_COLLIDING_ALIAS} --settings`,
        claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/custom-model",
            commitSummary: "Keep custom model",
            diffSummary: "1 file changed",
            diffPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("claudeAgent"),
              SYNTHETIC_CLAUDE_COLLIDING_ALIAS,
              [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
                { id: "contextWindow", value: "expanded" },
              ],
            ),
          });

          expect(generated.title).toBe("Keep custom model");
        }),
    ),
  );

  it.effect(
    "keeps canonical built-in capabilities when a custom model collides with its alias",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title: "Improve orchestration flow",
              body: "Body",
            },
          }),
          argsMustContain: `--model ${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded] --effort max --settings {"disableAllHooks":true,"fastMode":true}`,
          claudeConfig: { customModels: [SYNTHETIC_CLAUDE_COLLIDING_ALIAS] },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generatePrContent({
              cwd: process.cwd(),
              baseBranch: "main",
              headBranch: "feature/claude-effect",
              commitSummary: "Improve orchestration",
              diffSummary: "1 file changed",
              diffPatch: "diff --git a/README.md b/README.md",
              modelSelection: {
                ...createModelSelection(
                  ProviderInstanceId.make("claudeAgent"),
                  SYNTHETIC_CLAUDE_CAPABLE_MODEL,
                  [
                    { id: "effort", value: "max" },
                    { id: "fastMode", value: true },
                  ],
                ),
              },
            });

            expect(generated.title).toBe("Improve orchestration flow");
          }),
      ),
  );

  it.effect(
    "generates thread titles outside the project with tools, skills, and hooks disabled",
    () =>
      withFakeClaudeEnv(
        {
          output: JSON.stringify({
            structured_output: {
              title:
                '  "Reconnect failures after restart because the session state does not recover"  ',
            },
          }),
          cwdMustNotBe: process.cwd(),
          stdinMustContain: "/call-script",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "/call-script",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(
              sanitizeThreadTitle(
                '"Reconnect failures after restart because the session state does not recover"',
              ),
            );
          }),
      ),
  );

  it.effect("generates branch names from skill prompts without executable capabilities", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({ structured_output: { branch: "call-script" } }),
        stdinMustContain: "/call-script",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "/call-script",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.branch).toBe("call-script");
        }),
    ),
  );

  it.effect("runs Claude text generation with the configured CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claudeConfigDir = path.join(process.cwd(), ".claude-work-test");
      return yield* withFakeClaudeEnv(
        {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          output: JSON.stringify({
            structured_output: {
              title: "Use Claude home",
            },
          }),
          configDirMustBe: claudeConfigDir,
          claudeConfig: { homePath: claudeConfigDir },
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "thread title",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe(sanitizeThreadTitle("Use Claude home"));
          }),
      );
    }),
  );

  for (const verbose of [false, true]) {
    it.effect(`unwraps a JSON title in ${verbose ? "verbose" : "normal"} Claude output`, () => {
      const result = {
        type: "result",
        structured_output: { title: '{"title": "Refresh ev-stg APP ASG instances"}' },
      };
      return withFakeClaudeEnv(
        { output: JSON.stringify(verbose ? [result] : result) },
        (textGeneration) =>
          Effect.gen(function* () {
            const generated = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Refresh ev-stg APP ASG instances",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            });

            expect(generated.title).toBe("Refresh ev-stg APP ASG instances");
          }),
      );
    });
  }

  for (const previousTitle of [undefined, "Old thread title"]) {
    it.effect(
      `reads the result from verbose Claude output when ${previousTitle ? "regenerating" : "generating"} a title`,
      () =>
        withFakeClaudeEnv(
          {
            output: JSON.stringify([
              { type: "system", subtype: "init" },
              { type: "assistant", message: { content: [] } },
              { type: "user", message: { content: [] } },
              { type: "rate_limit_event" },
              {
                type: "result",
                subtype: "success",
                result: '{"title":"Refresh ev-stg APP ASG Instances"}',
                structured_output: { title: "Refresh ev-stg APP ASG Instances" },
              },
            ]),
          },
          (textGeneration) =>
            Effect.gen(function* () {
              const generated = yield* textGeneration.generateThreadTitle({
                cwd: process.cwd(),
                message: "Refresh ev-stg APP ASG instances",
                previousTitle,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
                },
              });

              expect(generated.title).toBe("Refresh ev-stg APP ASG Instances");
            }),
        ),
    );
  }

  for (const [name, output] of [
    ["empty message array", []],
    ["missing result", [{ type: "assistant", structured_output: { title: "Not a result" } }]],
    ["invalid title", [{ type: "result", structured_output: { title: 42 } }]],
    [
      "final result without structured output",
      [
        { type: "result", structured_output: { title: "Earlier result" } },
        { type: "result", subtype: "error_max_structured_output_retries" },
      ],
    ],
  ] as const) {
    it.effect(`rejects verbose Claude output with ${name}`, () =>
      withFakeClaudeEnv({ output: JSON.stringify(output) }, (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread",
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
              },
            }),
          );

          expect(error._tag).toBe("TextGenerationError");
        }),
      ),
    );
  }

  it.effect("falls back when Claude thread title normalization becomes whitespace-only", () =>
    withFakeClaudeEnv(
      {
        output: JSON.stringify({
          structured_output: {
            title: '  """   """  ',
          },
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
            },
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );
});
