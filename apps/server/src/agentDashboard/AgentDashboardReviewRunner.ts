// @effect-diagnostics globalDate:off - review command timestamps are persisted as ISO strings.
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";

import * as AgentDashboardStore from "./AgentDashboardStore.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";

const REVIEW_MODEL = "gpt-5.6-luna";
const REVIEW_REASONING_EFFORT = "xhigh";

/** The migrated review keeps the former Luna/max-reasoning contract explicit. */
export const REVIEW_MODEL_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: REVIEW_MODEL,
  options: [{ id: "reasoningEffort", value: REVIEW_REASONING_EFFORT }],
};

export const REVIEW_INTERVAL_MINUTES = 120;

export interface AgentDashboardReviewRunResult {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly workspaceRoot: string;
  readonly githubRepo: string | null;
  readonly threadId: ThreadId;
  readonly startedAt: string;
}

export class AgentDashboardReviewRunnerError extends Schema.TaggedErrorClass<AgentDashboardReviewRunnerError>()(
  "AgentDashboardReviewRunnerError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AgentDashboardReviewRunnerService {
  /** Select one durable T3 project and start its native review thread. */
  readonly runRandomReview: Effect.Effect<
    AgentDashboardReviewRunResult,
    AgentDashboardReviewRunnerError
  >;
}

export class AgentDashboardReviewRunner extends Context.Service<
  AgentDashboardReviewRunner,
  AgentDashboardReviewRunnerService
>()("t3/agentDashboard/AgentDashboardReviewRunner") {}

const REVIEW_PROMPT = (project: OrchestrationProjectShell): string =>
  [
    "You are running a scheduled, read-only codebase review inside T3 Code.",
    "This is the T3-native replacement for the retired Hermes Random Codebase Review job.",
    "",
    "Review target:",
    `- Project: ${project.title}`,
    `- Main checkout: ${project.workspaceRoot}`,
    "",
    "Work only in the selected main checkout. Do not create, select, or depend on a linked Git worktree.",
    "First inspect and follow its top-level AGENTS.md, CLAUDE.md, .cursorrules, and README.md, then inspect the relevant source, tests, configuration, and recent history.",
    "Do not modify files, create files, commit, install dependencies, run destructive commands, or use network access.",
    "Look for high-signal findings in three categories: a confirmed bug with file and line evidence, a logically valuable feature expansion, or a bigger-picture architectural or product gap.",
    "Separate confirmed findings from hypotheses. Check the repository's recent review context in this run before deciding whether a finding is materially distinct; do not restate the same title and evidence twice.",
    "",
    "Emit one machine-readable line first, exactly in this shape, with valid single-line JSON:",
    'T3_REVIEW_METADATA: {"findings":[{"title":"...","category":"bug|feature|gap","summary":"...","impact":"...","confidence":"high|medium|low","evidence":["path:line and concrete evidence"],"next_step":"...","github_issue_title":"...","github_issue_body":"complete preformatted Markdown issue body","markdown":"optional Markdown finding"}]}',
    "Include at most three findings. Escape newlines inside github_issue_body and keep every JSON value on that one line.",
    "Then write the human-readable report beginning with a Markdown heading named Random Codebase Review.",
    "The report should explain each finding with exact paths and line references, evidence, impact, confidence, and a concrete next step.",
    "The GitHub issue title and body must be ready to publish without additional agent editing.",
    "If no defensible finding exists, return one clearly labeled opportunity rather than inventing a bug.",
    "Keep the report under 1200 words.",
    "If there is genuinely nothing new to report, respond with exactly [SILENT] and nothing else.",
  ].join("\n");

const githubRepositoryForProject = (project: OrchestrationProjectShell): string | null => {
  const identity = project.repositoryIdentity;
  const candidates = [
    identity?.canonicalKey,
    identity?.locator.source === "git-remote" ? identity.locator.remoteUrl : null,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = candidate.match(/github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/i);
    if (match?.[1] && match[2]) return `${match[1]}/${match[2]}`;
  }
  return null;
};

const stableProjects = Effect.fn("AgentDashboardReviewRunner.stableProjects")(function* (
  projects: ReadonlyArray<OrchestrationProjectShell>,
) {
  return yield* Effect.forEach(
    projects,
    (project) =>
      Effect.tryPromise({
        try: () => AgentDashboardStore.isStableRepositoryPath(project.workspaceRoot),
        catch: () => false,
      }).pipe(
        Effect.catch(() => Effect.succeed(false)),
        Effect.map((isStable) => (isStable ? project : null)),
      ),
    { concurrency: 4 },
  ).pipe(
    Effect.map((projects) =>
      projects.filter((project): project is OrchestrationProjectShell => project !== null),
    ),
  );
});

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;

  const randomUuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new AgentDashboardReviewRunnerError({
          operation: "generate identifier",
          message: "T3 could not generate an identifier for the repository review.",
          cause,
        }),
    ),
  );
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const makeCommandId = (tag: string) =>
    randomUuid.pipe(Effect.map((uuid) => CommandId.make(`server:agent-dashboard:${tag}:${uuid}`)));

  const dispatch = (command: Parameters<typeof orchestrationEngine.dispatch>[0]) =>
    startup.enqueueCommand(orchestrationEngine.dispatch(command)).pipe(
      Effect.mapError(
        (cause) =>
          new AgentDashboardReviewRunnerError({
            operation: `dispatch ${command.type}`,
            message: cause instanceof Error ? cause.message : "Failed to dispatch review command.",
            cause,
          }),
      ),
    );

  const runRandomReview: AgentDashboardReviewRunnerService["runRandomReview"] = Effect.gen(
    function* () {
      const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.mapError(
          (cause) =>
            new AgentDashboardReviewRunnerError({
              operation: "load projects",
              message: "Failed to load T3 projects for the scheduled review.",
              cause,
            }),
        ),
      );
      const projects = yield* stableProjects(shellSnapshot.projects);
      if (projects.length === 0) {
        return yield* Effect.fail(
          new AgentDashboardReviewRunnerError({
            operation: "select project",
            message: "No stable T3 repository checkout is available for review.",
          }),
        );
      }

      const randomValue = yield* randomUuid;
      const randomIndex = Number.parseInt(randomValue.slice(0, 8), 16) % projects.length;
      const project = projects[randomIndex] ?? null;
      if (project === null) {
        return yield* Effect.fail(
          new AgentDashboardReviewRunnerError({
            operation: "select project",
            message: "The T3 repository review candidate list changed before selection.",
          }),
        );
      }
      const startedAt = yield* nowIso;
      const threadId = ThreadId.make(yield* randomUuid);
      const title = `Repository review: ${project.title}`.slice(0, 80);

      yield* dispatch({
        type: "thread.create",
        commandId: yield* makeCommandId("review-thread-create"),
        threadId,
        projectId: project.id,
        title,
        modelSelection: REVIEW_MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: startedAt,
      });

      const turnDispatch = dispatch({
        type: "thread.turn.start",
        commandId: yield* makeCommandId("review-turn-start"),
        threadId,
        message: {
          messageId: MessageId.make(yield* randomUuid),
          role: "user",
          text: REVIEW_PROMPT(project),
          attachments: [],
        },
        modelSelection: REVIEW_MODEL_SELECTION,
        titleSeed: title,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: startedAt,
      });

      yield* turnDispatch.pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const cleanupCommandId = yield* makeCommandId("review-thread-cleanup");
            yield* dispatch({
              type: "thread.delete",
              commandId: cleanupCommandId,
              threadId,
            }).pipe(Effect.ignore);
            return yield* Effect.fail(cause);
          }),
        ),
      );

      return {
        projectId: project.id,
        projectName: project.title,
        workspaceRoot: project.workspaceRoot,
        githubRepo: githubRepositoryForProject(project),
        threadId,
        startedAt,
      } satisfies AgentDashboardReviewRunResult;
    },
  );

  return { runRandomReview } satisfies AgentDashboardReviewRunnerService;
});

export const layer = Layer.effect(AgentDashboardReviewRunner, make);
