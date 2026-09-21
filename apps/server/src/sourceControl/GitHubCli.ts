import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  type SourceControlProjectPullRequest,
  type SourceControlPullRequestMergeMethod,
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
  type GitHubAccountId,
  type ServerSettingsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";
import {
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestListJson,
  type NormalizedGitHubPullRequestRecord,
} from "./gitHubPullRequests.ts";
import { decodeGitHubProjectPullRequestListJson } from "./gitHubProjectPullRequests.ts";
import { type GitHubAuthStatusAccount, parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Server-local credential scope; never put its value in RPC payloads or cache keys. */
export const PinnedGitHubCredential = Context.Reference<{
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly credentialFingerprint: string;
} | null>("t3/sourceControl/PinnedGitHubCredential", { defaultValue: () => null });

export const AllowGitHubReserve = Context.Reference<boolean>(
  "t3/sourceControl/AllowGitHubReserve",
  { defaultValue: () => false },
);

function commandHosts(args: ReadonlyArray<string>): Array<string | null> {
  const hosts: Array<string | null> = [];
  const repositoryHost = (repository: string | undefined) => {
    if (repository === undefined) return null;
    if (/^https?:\/\//i.test(repository)) {
      try {
        return new URL(repository).host.toLowerCase();
      } catch {
        return null;
      }
    }
    const parts = repository.split("/");
    return parts.length === 3 ? parts[0]!.toLowerCase() : null;
  };
  if (args[0] === "repo" && args[1] === "view") hosts.push(repositoryHost(args[2]));
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--hostname") hosts.push(args[++index]?.toLowerCase() ?? null);
    else if (arg.startsWith("--hostname=")) hosts.push(arg.slice(11).toLowerCase());
    else if (arg === "--repo" || arg === "-R") hosts.push(repositoryHost(args[++index]));
    else if (arg.startsWith("--repo=")) hosts.push(repositoryHost(arg.slice(7)));
    else if (arg.startsWith("-R")) hosts.push(repositoryHost(arg.slice(2)));
    else if (/^https?:\/\//i.test(arg)) hosts.push(repositoryHost(arg));
  }
  return hosts;
}

function targetsVerifiedHost(args: ReadonlyArray<string>, host: string): boolean {
  const hosts = commandHosts(args);
  return hosts.length > 0 && hosts.every((target) => target === host);
}

const gitHubCliFailureFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubCliUnavailableError extends Schema.TaggedError<GitHubCliUnavailableError>()(
  "GitHubCliUnavailableError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI (`gh`) is required but not available on PATH.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliAuthenticationError extends Schema.TaggedError<GitHubCliAuthenticationError>()(
  "GitHubCliAuthenticationError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI is not authenticated. Run `gh auth login` and retry.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliRateLimitError extends Schema.TaggedError<GitHubCliRateLimitError>()(
  "GitHubCliRateLimitError",
  { ...gitHubCliFailureFields, retryAt: Schema.optionalKey(Schema.Finite) },
) {
  get detail(): string {
    return "GitHub API rate limit exceeded. Run `gh api rate_limit` to inspect the quota and reset time.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubPullRequestNotFoundError extends Schema.TaggedError<GitHubPullRequestNotFoundError>()(
  "GitHubPullRequestNotFoundError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "Pull request not found. Check the PR number or URL and try again.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubRepositoryAccessError extends Schema.TaggedError<GitHubRepositoryAccessError>()(
  "GitHubRepositoryAccessError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "No authenticated GitHub account can access this repository. Sign in with an account that has access, then refresh.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

export class GitHubCliCommandError extends Schema.TaggedError<GitHubCliCommandError>()(
  "GitHubCliCommandError",
  gitHubCliFailureFields,
) {
  get detail(): string {
    return "GitHub CLI command failed.";
  }

  override get message(): string {
    return `GitHub CLI failed in execute: ${this.detail}`;
  }
}

const gitHubCliDecodeFields = {
  command: Schema.Literal("gh"),
  cwd: Schema.String,
  cause: Schema.Defect(),
} as const;

export class GitHubPullRequestListDecodeError extends Schema.TaggedError<GitHubPullRequestListDecodeError>()(
  "GitHubPullRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid PR list JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listOpenPullRequests: ${this.detail}`;
  }
}

export class GitHubChangeRequestListDecodeError extends Schema.TaggedError<GitHubChangeRequestListDecodeError>()(
  "GitHubChangeRequestListDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid change request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in listChangeRequests: ${this.detail}`;
  }
}

export class GitHubPullRequestDecodeError extends Schema.TaggedError<GitHubPullRequestDecodeError>()(
  "GitHubPullRequestDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getPullRequest: ${this.detail}`;
  }
}

export class GitHubRepositoryDecodeError extends Schema.TaggedError<GitHubRepositoryDecodeError>()(
  "GitHubRepositoryDecodeError",
  gitHubCliDecodeFields,
) {
  get detail(): string {
    return "GitHub CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `GitHub CLI failed in getRepositoryCloneUrls: ${this.detail}`;
  }
}

export const GitHubCliError = Schema.Union([
  GitHubCliUnavailableError,
  GitHubCliAuthenticationError,
  GitHubCliRateLimitError,
  GitHubPullRequestNotFoundError,
  GitHubRepositoryAccessError,
  GitHubCliCommandError,
  GitHubPullRequestListDecodeError,
  GitHubChangeRequestListDecodeError,
  GitHubPullRequestDecodeError,
  GitHubRepositoryDecodeError,
]);
export type GitHubCliError = typeof GitHubCliError.Type;

export const isGitHubCliError = Schema.is(GitHubCliError);

export function fromVcsError(
  context: {
    readonly command: "gh";
    readonly cwd: string;
  },
  error: VcsError,
): GitHubCliError {
  if (
    error._tag === "VcsProcessSpawnError" &&
    error.cause instanceof PlatformError.PlatformError &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess" &&
    error.cause.reason.method === "spawn"
  ) {
    return new GitHubCliUnavailableError({ ...context, cause: error });
  }

  if (error._tag === "VcsProcessExitError") {
    if (error.failureKind === "authentication") {
      return new GitHubCliAuthenticationError({ ...context, cause: error });
    }
    if (error.failureKind === "rate-limited") {
      return new GitHubCliRateLimitError({ ...context, cause: error });
    }
    if (error.failureKind === "not-found") {
      return new GitHubPullRequestNotFoundError({ ...context, cause: error });
    }
    if (error.failureKind === "repository-not-found") {
      return new GitHubRepositoryAccessError({ ...context, cause: error });
    }
  }

  return new GitHubCliCommandError({ ...context, cause: error });
}

export interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly isDraft?: boolean;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt?: string;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

function pullRequestSummary(input: NormalizedGitHubPullRequestRecord): GitHubPullRequestSummary {
  const { updatedAt, ...summary } = input;
  return {
    ...summary,
    ...(Option.isSome(updatedAt) ? { updatedAt: DateTime.formatIso(updatedAt.value) } : {}),
  };
}

export interface GitHubRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export interface GitHubCliAccountContext {
  readonly githubAccountId?: GitHubAccountId;
}

export class GitHubCli extends Context.Service<
  GitHubCli,
  {
    readonly execute: (
      input: GitHubCliAccountContext & {
        readonly cwd: string;
        readonly args: ReadonlyArray<string>;
        readonly timeoutMs?: number;
        /** Piped to the child's stdin, for payloads that must never appear in argv. */
        readonly stdin?: string;
        readonly env?: NodeJS.ProcessEnv;
        readonly maxOutputBytes?: number;
        readonly rateLimitHost?: string;
        readonly allowReserve?: boolean;
      },
    ) => Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError>;

    readonly listOpenPullRequests: (
      input: GitHubCliAccountContext & {
        readonly cwd: string;
        readonly headSelector: string;
        readonly limit?: number;
        readonly rateLimitHost?: string;
      },
    ) => Effect.Effect<ReadonlyArray<GitHubPullRequestSummary>, GitHubCliError>;

    readonly listProjectPullRequests: (
      input: GitHubCliAccountContext & {
        readonly cwd: string;
        readonly repository: string;
        readonly limit?: number;
      },
    ) => Effect.Effect<ReadonlyArray<SourceControlProjectPullRequest>, GitHubCliError>;

    readonly mergePullRequest: (
      input: GitHubCliAccountContext & {
        readonly cwd: string;
        readonly repository: string;
        readonly number: number;
        readonly expectedHeadOid: string;
        readonly method: SourceControlPullRequestMergeMethod;
      },
    ) => Effect.Effect<void, GitHubCliError>;

    readonly getPullRequest: (
      input: GitHubCliAccountContext & {
        readonly cwd: string;
        readonly reference: string;
        readonly rateLimitHost?: string;
      },
    ) => Effect.Effect<GitHubPullRequestSummary, GitHubCliError>;

    readonly getRepositoryCloneUrls: (
      input: GitHubCliAccountContext & {
        readonly cwd: string;
        readonly repository: string;
      },
    ) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createRepository: (
      input: GitHubCliAccountContext & {
        readonly cwd: string;
        readonly repository: string;
        readonly visibility: SourceControlRepositoryVisibility;
      },
    ) => Effect.Effect<GitHubRepositoryCloneUrls, GitHubCliError>;

    readonly createPullRequest: (
      input: GitHubCliAccountContext & {
        readonly cwd: string;
        readonly baseBranch: string;
        readonly headSelector: string;
        readonly title: string;
        readonly bodyFile: string;
      },
    ) => Effect.Effect<void, GitHubCliError>;

    readonly getDefaultBranch: (
      input: GitHubCliAccountContext & {
        readonly cwd: string;
        readonly rateLimitHost?: string;
      },
    ) => Effect.Effect<string | null, GitHubCliError>;

    readonly checkoutPullRequest: (
      input: GitHubCliAccountContext & {
        readonly cwd: string;
        readonly reference: string;
        readonly force?: boolean;
      },
    ) => Effect.Effect<void, GitHubCliError>;
  }
>()("t3/sourceControl/GitHubCli") {}

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
const decodeRawGitHubRepositoryCloneUrls = Schema.decodeEffect(
  Schema.fromJsonString(RawGitHubRepositoryCloneUrlsSchema),
);

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

/**
 * `gh repo create` prints the canonical URL of the new repository on stdout
 * (e.g. `https://github.com/owner/repo`). Reading it back here avoids a
 * follow-up `gh repo view`, which can race GitHub's GraphQL eventual
 * consistency window and falsely report the just-created repo as missing.
 */
function deriveRepositoryCloneUrlsFromCreateOutput(
  stdout: string,
  repository: string,
): GitHubRepositoryCloneUrls {
  const fallbackHost = "github.com";
  const match = stdout.match(/https?:\/\/[^\s]+/);
  if (match) {
    const cleaned = match[0].replace(/\.git$/, "");
    try {
      const parsed = new URL(cleaned);
      const pathname = parsed.pathname.replace(/^\/+|\/+$/g, "");
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length === 2) {
        const nameWithOwner = `${segments[0]}/${segments[1]}`;
        return {
          nameWithOwner,
          url: `${parsed.origin}/${nameWithOwner}`,
          sshUrl: `git@${parsed.host}:${nameWithOwner}.git`,
        };
      }
    } catch {
      // Fall through to the input-derived defaults below.
    }
  }
  return {
    nameWithOwner: repository,
    url: `https://${fallbackHost}/${repository}`,
    sshUrl: `git@${fallbackHost}:${repository}.git`,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  // GitHubCli is also constructed directly by source-control integrations and
  // tests that intentionally do not load the full server-settings service.
  // Production composition still supplies it so configured GitHub accounts
  // work, while standalone use safely falls back to ambient gh credentials.
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;

  const resolveGitHubAccountEnvironment = (
    input: GitHubCliAccountContext & { readonly cwd: string },
  ): Effect.Effect<ServerSettings.GitHubAccountEnvironment, GitHubCliCommandError> => {
    const accountEnvironment: Effect.Effect<
      ServerSettings.GitHubAccountEnvironment,
      ServerSettingsError
    > = Option.isNone(serverSettings)
      ? Effect.succeed({ configured: false } satisfies ServerSettings.GitHubAccountEnvironment)
      : input.githubAccountId === undefined
        ? serverSettings.value.getGitHubAccountEnvironmentForWorkspaceRoot(input.cwd)
        : serverSettings.value.getGitHubAccountEnvironment(input.githubAccountId);
    return accountEnvironment.pipe(
      Effect.mapError(
        (cause) =>
          new GitHubCliCommandError({
            command: "gh",
            cwd: input.cwd,
            cause,
          }),
      ),
    );
  };

  const executeRaw: GitHubCli["Service"]["execute"] = Effect.fn("GitHubCli.executeRaw")(
    function* (input) {
      const account = yield* resolveGitHubAccountEnvironment(input);
      if ((input.githubAccountId !== undefined || account.configured) && !account.environment) {
        return yield* new GitHubCliAuthenticationError({
          command: "gh",
          cwd: input.cwd,
          cause: new Error("The selected GitHub account is not configured with a PAT."),
        });
      }
      const credential = yield* PinnedGitHubCredential;
      if (credential !== null && !targetsVerifiedHost(input.args, credential.host)) {
        return yield* new GitHubCliCommandError({
          command: "gh",
          cwd: input.cwd,
          cause: new Error("The GitHub command does not target the verified credential's host."),
        });
      }
      const token = credential === null ? undefined : Redacted.value(credential.token);
      const env =
        credential === null
          ? input.env === undefined && account.environment === undefined
            ? undefined
            : { ...(input.env ?? globalThis.process.env), ...account.environment }
          : {
              ...(input.env ?? globalThis.process.env),
              ...account.environment,
              GH_HOST: credential.host,
              GH_TOKEN: token,
              GITHUB_TOKEN: token,
              GH_ENTERPRISE_TOKEN: token,
              GITHUB_ENTERPRISE_TOKEN: token,
              GH_DEBUG: "",
            };
      return yield* process
        .run({
          operation: "GitHubCli.execute",
          command: "gh",
          args: input.args,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
          ...(env !== undefined ? { env } : {}),
          ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
        })
        .pipe(Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)));
    },
  );

  const quota = yield* Cache.makeWith(
    (key: string) => {
      const host = key.split("\0")[0]!;
      return executeRaw({
        cwd: globalThis.process.cwd(),
        args: [
          "api",
          "rate_limit",
          "--hostname",
          host,
          "--jq",
          ".resources.graphql | {data:{rateLimit:{cost:1,limit:.limit,remaining:.remaining,resetAt:(.reset|todateiso8601)}}}",
        ],
      }).pipe(
        Effect.tap((result) => budget.observe(host, result.stdout)),
        Effect.asVoid,
      );
    },
    {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.seconds(30) : Duration.zero),
    },
  );
  const execute: GitHubCli["Service"]["execute"] = Effect.fn("GitHubCli.execute")(
    function* (input) {
      const [command, action] = input.args;
      if (
        !(
          (command === "pr" && (action === "list" || action === "view")) ||
          (command === "repo" && action === "view")
        )
      )
        return yield* executeRaw(input);
      const credential = yield* PinnedGitHubCredential;
      if (credential !== null && !targetsVerifiedHost(input.args, credential.host))
        return yield* executeRaw(input);
      const account = yield* resolveGitHubAccountEnvironment(input);
      const allowReserve = input.allowReserve ?? (yield* AllowGitHubReserve);
      const host = (
        credential?.host ??
        commandHosts(input.args).find((host) => host !== null) ??
        input.rateLimitHost ??
        account.environment?.GH_HOST ??
        input.env?.GH_HOST ??
        globalThis.process.env.GH_HOST ??
        "github.com"
      ).toLowerCase();
      const key = { provider: "github" as const, host };
      const guarded = Effect.gen(function* () {
        const lease = yield* limits.check(key, allowReserve ? { allowPaused: true } : undefined);
        return yield* Effect.gen(function* () {
          yield* Cache.get(quota, `${host}\0${credential?.credentialFingerprint ?? ""}`);
          yield* budget.query(host, "query {}", allowReserve ? { allowReserve: true } : undefined);
          return yield* executeRaw(input);
        }).pipe(
          Effect.tap(() => limits.recordSuccess({ ...key, lease })),
          Effect.tapError((error) =>
            error._tag === "GitHubCliRateLimitError"
              ? limits.recordRateLimit({ ...key, lease })
              : Effect.void,
          ),
        );
      });
      return yield* guarded.pipe(
        Effect.provideService(
          SourceControlRateLimit.CredentialScope,
          credential?.credentialFingerprint ?? (yield* SourceControlRateLimit.CredentialScope),
        ),
        Effect.catchTags({
          SourceControlRateLimitPausedError: (cause) =>
            Effect.fail(
              new GitHubCliRateLimitError({
                command: "gh",
                cwd: input.cwd,
                retryAt: cause.retryAt,
                cause,
              }),
            ),
        }),
      );
    },
  );

  const orderFallbackAccounts = (
    accounts: ReadonlyArray<GitHubAuthStatusAccount>,
    host: string,
    repository: string,
  ): ReadonlyArray<GitHubAuthStatusAccount> => {
    const repositoryOwner = repository.split("/", 1)[0]?.toLowerCase() ?? "";
    return accounts
      .filter((account) => account.host === host && account.authenticated && !account.active)
      .toSorted((left, right) => {
        const leftMatchesOwner = left.account.toLowerCase() === repositoryOwner;
        const rightMatchesOwner = right.account.toLowerCase() === repositoryOwner;
        return Number(rightMatchesOwner) - Number(leftMatchesOwner);
      });
  };

  const executeForRepository = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly args: ReadonlyArray<string>;
    readonly githubAccountId?: GitHubAccountId;
  }): Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError> => {
    const repositoryArgs = [...input.args, "--repo", input.repository];
    const host = commandHosts(repositoryArgs).find((value) => value !== null) ?? "github.com";
    const executeTarget = (env?: NodeJS.ProcessEnv) =>
      execute({
        cwd: input.cwd,
        args: repositoryArgs,
        ...(input.githubAccountId === undefined ? {} : { githubAccountId: input.githubAccountId }),
        rateLimitHost: host,
        allowReserve: true,
        ...(env === undefined ? {} : { env }),
      });

    const executeWithFallback = executeTarget().pipe(
      Effect.catchTag("GitHubRepositoryAccessError", (repositoryAccessError) =>
        execute({
          cwd: input.cwd,
          args: ["auth", "status", "--hostname", host, "--json", "hosts"],
        }).pipe(
          Effect.map((result) =>
            orderFallbackAccounts(
              parseGitHubAuthStatus(result.stdout).accounts,
              host,
              input.repository,
            ),
          ),
          Effect.flatMap((accounts) => {
            const tryAccount = (
              index: number,
            ): Effect.Effect<VcsProcess.VcsProcessOutput, GitHubCliError> => {
              const account = accounts[index];
              if (account === undefined) return Effect.fail(repositoryAccessError);

              return Effect.result(
                execute({
                  cwd: input.cwd,
                  args: ["auth", "token", "--hostname", host, "--user", account.account],
                }),
              ).pipe(
                Effect.flatMap((tokenResult) => {
                  if (!Result.isSuccess(tokenResult)) return tryAccount(index + 1);
                  const token = tokenResult.success.stdout.trim();
                  if (token.length === 0) return tryAccount(index + 1);
                  return Effect.result(executeTarget({ GH_HOST: host, GH_TOKEN: token })).pipe(
                    Effect.flatMap((targetResult) =>
                      Result.isSuccess(targetResult)
                        ? Effect.succeed(targetResult.success)
                        : tryAccount(index + 1),
                    ),
                  );
                }),
              );
            };
            return tryAccount(0);
          }),
          Effect.mapError(() => repositoryAccessError),
        ),
      ),
    );
    return resolveGitHubAccountEnvironment(input).pipe(
      Effect.flatMap((account) =>
        input.githubAccountId !== undefined || account.configured
          ? executeTarget()
          : executeWithFallback,
      ),
    );
  };

  return GitHubCli.of({
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        ...(input.githubAccountId === undefined ? {} : { githubAccountId: input.githubAccountId }),
        ...(input.rateLimitHost === undefined ? {} : { rateLimitHost: input.rateLimitHost }),
        allowReserve: true,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GitHubPullRequestListDecodeError({
                        command: "gh",
                        cwd: input.cwd,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(decoded.success.map(pullRequestSummary));
                }),
              ),
        ),
      ),
    listProjectPullRequests: (input) =>
      executeForRepository({
        cwd: input.cwd,
        repository: input.repository,
        ...(input.githubAccountId === undefined ? {} : { githubAccountId: input.githubAccountId }),
        args: [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 50),
          "--json",
          "number,title,url,baseRefName,headRefName,headRefOid,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,author,updatedAt",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitHubProjectPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) =>
                  Result.isSuccess(decoded)
                    ? Effect.succeed(decoded.success)
                    : Effect.fail(
                        new GitHubPullRequestListDecodeError({
                          command: "gh",
                          cwd: input.cwd,
                          cause: decoded.failure,
                        }),
                      ),
                ),
              ),
        ),
      ),
    mergePullRequest: (input) =>
      executeForRepository({
        cwd: input.cwd,
        repository: input.repository,
        ...(input.githubAccountId === undefined ? {} : { githubAccountId: input.githubAccountId }),
        args: [
          "pr",
          "merge",
          String(input.number),
          `--${input.method}`,
          "--match-head-commit",
          input.expectedHeadOid,
        ],
      }).pipe(Effect.asVoid),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        ...(input.githubAccountId === undefined ? {} : { githubAccountId: input.githubAccountId }),
        ...(input.rateLimitHost === undefined ? {} : { rateLimitHost: input.rateLimitHost }),
        allowReserve: true,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeGitHubPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new GitHubPullRequestDecodeError({
                    command: "gh",
                    cwd: input.cwd,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(pullRequestSummary(decoded.success));
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        ...(input.githubAccountId === undefined ? {} : { githubAccountId: input.githubAccountId }),
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeRawGitHubRepositoryCloneUrls(raw).pipe(
            Effect.mapError(
              (cause) =>
                new GitHubRepositoryDecodeError({
                  command: "gh",
                  cwd: input.cwd,
                  cause,
                }),
            ),
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createRepository: (input) =>
      execute({
        cwd: input.cwd,
        ...(input.githubAccountId === undefined ? {} : { githubAccountId: input.githubAccountId }),
        args: ["repo", "create", input.repository, `--${input.visibility}`],
      }).pipe(
        Effect.map((result) =>
          deriveRepositoryCloneUrlsFromCreateOutput(result.stdout, input.repository),
        ),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        ...(input.githubAccountId === undefined ? {} : { githubAccountId: input.githubAccountId }),
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        ...(input.githubAccountId === undefined ? {} : { githubAccountId: input.githubAccountId }),
        ...(input.rateLimitHost === undefined ? {} : { rateLimitHost: input.rateLimitHost }),
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        ...(input.githubAccountId === undefined ? {} : { githubAccountId: input.githubAccountId }),
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(GitHubCli, make).pipe(
  Layer.provideMerge(GitHubGraphQlBudget.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
);
