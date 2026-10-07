/**
 * ClaudeTextGeneration – Text generation layer using the Claude CLI.
 *
 * Implements the same TextGeneration service contract as CodexTextGeneration but
 * delegates to the `claude` CLI (`claude -p`) with structured JSON output
 * instead of the `codex exec` CLI.
 *
 * @module ClaudeTextGeneration
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  OrganizationArchitectTurnOutput,
  OrganizationPatchProposalOutput,
  type ClaudeSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";
import { OrganizationPatchProcessObserver } from "./OrganizationPatchProcessObserver.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  getClaudeCatalogModelCapabilities,
  isClaudeCatalogUltracodeEffort,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelSlug,
  scopeClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import {
  buildOrganizationArchitectPrompt,
  validateOrganizationArchitectOutput,
} from "../organizations/OrganizationArchitectPrompt.ts";
import {
  buildOrganizationPatchPrompt,
  validateOrganizationPatchProposal,
} from "../organizations/OrganizationPatchPrompt.ts";

const CLAUDE_TIMEOUT_MS = 180_000;
const ARCHITECT_TIMEOUT_MS = 60_000;
const ARCHITECT_STDOUT_MAX_BYTES = 64_000;
const ARCHITECT_STDERR_MAX_BYTES = 8_000;
const PATCH_TIMEOUT_MS = 60_000;
const PATCH_STDOUT_MAX_BYTES = 256 * 1024;
const PATCH_STDERR_MAX_BYTES = 8_000;
const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Schema for the wrapper JSON returned by `claude -p --output-format json`.
 * Verbose mode wraps the result in an array of conversation messages.
 */
const ClaudeOutputEnvelope = Schema.Struct({
  structured_output: Schema.Unknown,
});
const ClaudeOutputMessage = Schema.Struct({
  type: Schema.String,
  structured_output: Schema.optionalKey(Schema.Unknown),
});
const isClaudeOutputEnvelope = Schema.is(ClaudeOutputEnvelope);

const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeOutput = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Union([ClaudeOutputEnvelope, Schema.Array(ClaudeOutputMessage)])),
);

export const makeClaudeTextGeneration = Effect.fn("makeClaudeTextGeneration")(function* (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  modelCatalog: Effect.Effect<ClaudeModelCatalog> = Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const scopedModelCatalog = modelCatalog.pipe(
    Effect.map((catalog) => scopeClaudeModelCatalog(catalog, claudeSettings.customModels)),
  );

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
    maxBytes?: number,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => ({ text: "", bytes: 0, exceeded: false }),
        (acc, chunk) => {
          if (acc.exceeded) return acc;
          const bytes = Buffer.byteLength(chunk, "utf8");
          if (maxBytes !== undefined && acc.bytes + bytes > maxBytes) {
            return { ...acc, exceeded: true };
          }
          return { text: acc.text + chunk, bytes: acc.bytes + bytes, exceeded: false };
        },
      ),
      Effect.flatMap((output) =>
        output.exceeded
          ? Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Claude CLI output exceeded the structured output size limit.",
              }),
            )
          : Effect.succeed(output.text),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  const encodeJsonForOperation = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateOrganizationArchitectTurn"
      | "generateOrganizationPatchProposal",
    value: unknown,
    detail: string,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail,
            cause,
          }),
      ),
    );

  /**
   * Spawn the Claude CLI with structured JSON output and return the parsed,
   * schema-validated result.
   */
  const runClaudeJson = Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateOrganizationArchitectTurn"
      | "generateOrganizationPatchProposal";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const catalog = yield* scopedModelCatalog;
    const resolvedModelSelection = {
      ...modelSelection,
      model: resolveClaudeModelSlug(catalog, modelSelection.model),
    };
    const jsonSchemaStr = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
      "Failed to encode structured output schema.",
    );
    const caps = getClaudeCatalogModelCapabilities(catalog, resolvedModelSelection.model);
    const descriptors = getProviderOptionDescriptors({
      caps,
      selections: resolvedModelSelection.options,
    });
    const findDescriptor = (id: string) => descriptors.find((descriptor) => descriptor.id === id);
    const rawEffortSelection = getModelSelectionStringOptionValue(resolvedModelSelection, "effort");
    const resolvedEffort = resolveClaudeCatalogEffort(
      catalog,
      resolvedModelSelection.model,
      rawEffortSelection,
    );
    const cliEffort = normalizeClaudeCatalogEffort(
      catalog,
      resolvedEffort,
      resolvedModelSelection.model,
    );
    const ultracode = isClaudeCatalogUltracodeEffort(resolvedEffort);
    const thinkingDescriptor = findDescriptor("thinking");
    const fastModeDescriptor = findDescriptor("fastMode");
    const thinking =
      thinkingDescriptor?.type === "boolean" ? thinkingDescriptor.currentValue : undefined;
    const fastMode =
      fastModeDescriptor?.type === "boolean" ? fastModeDescriptor.currentValue : undefined;
    const settings = {
      disableAllHooks: true,
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      ...(fastMode ? { fastMode: true } : {}),
      ...(ultracode ? { ultracode: true } : {}),
    };
    const settingsJson = yield* encodeJsonForOperation(
      operation,
      settings,
      "Failed to encode Claude CLI settings.",
    );

    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* () {
      // Titles and Architect turns need only the supplied prompt, never checkout context.
      const workingDirectory =
        operation === "generateThreadTitle" ||
        operation === "generateOrganizationArchitectTurn" ||
        operation === "generateOrganizationPatchProposal"
          ? yield* fileSystem
              .makeTempDirectoryScoped({
                prefix:
                  operation === "generateThreadTitle"
                    ? "t3code-claude-title-"
                    : operation === "generateOrganizationArchitectTurn"
                      ? "t3code-claude-architect-"
                      : "t3code-claude-org-patch-",
              })
              .pipe(
                Effect.mapError((cause) =>
                  normalizeCliError(
                    "claude",
                    operation,
                    cause,
                    "Failed to create isolated generation directory",
                  ),
                ),
              )
          : cwd;
      const spawnCommand = yield* resolveSpawnCommand(
        claudeSettings.binaryPath || "claude",
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          resolveClaudeCatalogApiModelId(catalog, resolvedModelSelection),
          ...(cliEffort ? ["--effort", cliEffort] : []),
          "--settings",
          settingsJson,
          // Metadata prompts need no executable capabilities, even when they contain a skill name.
          "--tools",
          "",
          "--disable-slash-commands",
          "--strict-mcp-config",
          "--permission-mode",
          "dontAsk",
        ],
        { env: claudeEnvironment },
      );
      const observer =
        operation === "generateOrganizationPatchProposal"
          ? yield* OrganizationPatchProcessObserver
          : null;
      if (observer) yield* observer.preparing();
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: { ...claudeEnvironment, ...observer?.environment },
        cwd: workingDirectory,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });

      const [stdout, stderr, exitCode] = yield* Effect.acquireUseRelease(
        commandSpawner
          .spawn(command)
          .pipe(
            Effect.mapError((cause) =>
              normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
            ),
          ),
        (child) =>
          Effect.gen(function* () {
            if (observer) yield* observer.spawned(child);
            return yield* Effect.all(
              [
                readStreamAsString(
                  operation,
                  child.stdout,
                  operation === "generateOrganizationArchitectTurn"
                    ? ARCHITECT_STDOUT_MAX_BYTES
                    : operation === "generateOrganizationPatchProposal"
                      ? PATCH_STDOUT_MAX_BYTES
                      : undefined,
                ),
                readStreamAsString(
                  operation,
                  child.stderr,
                  operation === "generateOrganizationArchitectTurn"
                    ? ARCHITECT_STDERR_MAX_BYTES
                    : operation === "generateOrganizationPatchProposal"
                      ? PATCH_STDERR_MAX_BYTES
                      : undefined,
                ),
                child.exitCode.pipe(
                  Effect.mapError((cause) =>
                    normalizeCliError(
                      "claude",
                      operation,
                      cause,
                      "Failed to read Claude CLI exit code",
                    ),
                  ),
                ),
              ],
              { concurrency: "unbounded" },
            );
          }),
        (child) =>
          Effect.gen(function* () {
            if (yield* child.isRunning) yield* child.kill({ forceKillAfter: "2 seconds" });
            yield* Effect.exit(child.exitCode);
            if (yield* child.isRunning)
              return yield* new TextGenerationError({
                operation,
                detail: "Claude CLI process exit could not be verified.",
              });
            if (observer) yield* observer.exited(child);
          }).pipe(
            Effect.mapError((cause) =>
              Schema.is(TextGenerationError)(cause)
                ? cause
                : normalizeCliError("claude", operation, cause, "Failed to verify Claude CLI exit"),
            ),
          ),
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Claude CLI command failed: ${detail}`
              : `Claude CLI command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    });

    const rawStdout = yield* runClaudeCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(
        operation === "generateOrganizationArchitectTurn"
          ? ARCHITECT_TIMEOUT_MS
          : operation === "generateOrganizationPatchProposal"
            ? PATCH_TIMEOUT_MS
            : CLAUDE_TIMEOUT_MS,
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const output = yield* decodeClaudeOutput(rawStdout).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude CLI returned unexpected output format.",
              cause,
            }),
          ),
      }),
    );
    const envelope = isClaudeOutputEnvelope(output)
      ? output
      : output.findLast((message) => message.type === "result");

    const decodeOutput = Schema.decodeEffect(outputSchemaJson);
    return yield* decodeOutput(envelope?.structured_output).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Claude returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // TextGeneration service methods
  // ---------------------------------------------------------------------------

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("ClaudeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runClaudeJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("ClaudeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runClaudeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("ClaudeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        naming: input.naming,
      });

      const generated = yield* runClaudeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: formatGeneratedBranchName(generated.branch, input.naming),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("ClaudeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runClaudeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  const generateOrganizationArchitectTurn: NonNullable<
    TextGeneration.TextGeneration["Service"]["generateOrganizationArchitectTurn"]
  > = Effect.fn("ClaudeTextGeneration.generateOrganizationArchitectTurn")(function* (input) {
    const prompt = yield* buildOrganizationArchitectPrompt(input);
    const generated = yield* runClaudeJson({
      operation: "generateOrganizationArchitectTurn",
      cwd: process.cwd(),
      prompt,
      outputSchemaJson: OrganizationArchitectTurnOutput,
      modelSelection: input.modelSelection,
    });
    return yield* validateOrganizationArchitectOutput(generated, input.organization.draftRevision);
  });

  const generateOrganizationPatchProposal: NonNullable<
    TextGeneration.TextGeneration["Service"]["generateOrganizationPatchProposal"]
  > = Effect.fn("ClaudeTextGeneration.generateOrganizationPatchProposal")(function* (input) {
    const prompt = yield* buildOrganizationPatchPrompt(input);
    const generated = yield* runClaudeJson({
      operation: "generateOrganizationPatchProposal",
      cwd: process.cwd(),
      prompt,
      outputSchemaJson: OrganizationPatchProposalOutput,
      modelSelection: input.modelSelection,
    });
    return yield* validateOrganizationPatchProposal(generated, input);
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateOrganizationArchitectTurn,
    generateOrganizationPatchProposal,
  } satisfies TextGeneration.TextGeneration["Service"];
});
