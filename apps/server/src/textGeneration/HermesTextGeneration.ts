import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  OrganizationArchitectTurnOutput,
  type HermesSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import {
  applyHermesAcpModelSelection,
  currentHermesModelIdFromSessionSetup,
  makeHermesAcpRuntime,
  resolveHermesAcpBaseModelId,
} from "../provider/acp/HermesAcpSupport.ts";
import { denyArchitectAcpTools } from "./OrganizationArchitectAcp.ts";
import {
  buildOrganizationArchitectPrompt,
  validateOrganizationArchitectOutput,
} from "../organizations/OrganizationArchitectPrompt.ts";

const HERMES_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeHermesTextGeneration = Effect.fn("makeHermesTextGeneration")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;

  const runHermesJson = <S extends Schema.Top>({
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
      | "generateOrganizationArchitectTurn";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const resolvedModel = resolveHermesAcpBaseModelId(modelSelection.model);
      const outputRef = yield* Ref.make("");
      const toolAttempted = yield* Ref.make(false);
      const outputExceeded = yield* Ref.make(false);
      const workingDirectory =
        operation === "generateOrganizationArchitectTurn"
          ? yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-hermes-architect-" }).pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation,
                    detail: "Failed to create isolated Architect directory.",
                    cause,
                  }),
              ),
            )
          : cwd;
      const runtime = yield* makeHermesAcpRuntime({
        hermesSettings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd: workingDirectory,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      if (operation === "generateOrganizationArchitectTurn") {
        yield* denyArchitectAcpTools(runtime);
      }

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (
          operation === "generateOrganizationArchitectTurn" &&
          (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
        ) {
          return Ref.set(toolAttempted, true);
        }
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.modify(outputRef, (current) => {
          if (
            operation === "generateOrganizationArchitectTurn" &&
            Buffer.byteLength(current, "utf8") + Buffer.byteLength(content.text, "utf8") > 64_000
          ) {
            return [true, current] as const;
          }
          return [false, current + content.text] as const;
        }).pipe(
          Effect.flatMap((exceeded) => (exceeded ? Ref.set(outputExceeded, true) : Effect.void)),
        );
      });

      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: currentHermesModelIdFromSessionSetup(started.sessionSetupResult),
          requestedModelId: resolvedModel,
          mapError: (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to set Hermes ACP base model for text generation.",
              cause,
            }),
        });

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(
          operation === "generateOrganizationArchitectTurn" ? 60_000 : HERMES_TIMEOUT_MS,
        ),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Hermes ACP request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Hermes ACP request failed.",
                cause,
              }),
        ),
      );

      if (yield* Ref.get(toolAttempted)) {
        return yield* new TextGenerationError({
          operation,
          detail: "Hermes attempted tool work during Architect generation.",
        });
      }
      if (yield* Ref.get(outputExceeded)) {
        return yield* new TextGenerationError({
          operation,
          detail: "Hermes Architect output exceeded the structured output size limit.",
        });
      }

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Hermes ACP request was cancelled."
              : "Hermes Agent returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Hermes Agent returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Hermes ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("HermesTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runHermesJson({
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
    Effect.fn("HermesTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runHermesJson({
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
    Effect.fn("HermesTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runHermesJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("HermesTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runHermesJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  const generateOrganizationArchitectTurn: NonNullable<
    TextGeneration.TextGeneration["Service"]["generateOrganizationArchitectTurn"]
  > = Effect.fn("HermesTextGeneration.generateOrganizationArchitectTurn")(function* (input) {
    const prompt = yield* buildOrganizationArchitectPrompt(input);
    const generated = yield* runHermesJson({
      operation: "generateOrganizationArchitectTurn",
      cwd: process.cwd(),
      prompt,
      outputSchemaJson: OrganizationArchitectTurnOutput,
      modelSelection: input.modelSelection,
    });
    return yield* validateOrganizationArchitectOutput(generated, input.organization.draftRevision);
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateOrganizationArchitectTurn,
  } satisfies TextGeneration.TextGeneration["Service"];
});
