// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Fixed-argv Git reads need raw bounded subprocess bytes and an OS kill timer.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class OrganizationSingleFileApprovalRevisionError extends Schema.TaggedError<OrganizationSingleFileApprovalRevisionError>()(
  "OrganizationSingleFileApprovalRevisionError",
  { code: Schema.Literals(["conflict", "unavailable"]), message: Schema.String },
) {}
const failure = (code: OrganizationSingleFileApprovalRevisionError["code"], message: string) =>
  new OrganizationSingleFileApprovalRevisionError({ code, message });
const isRevisionError = Schema.is(OrganizationSingleFileApprovalRevisionError);
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Opaque wire identity for a resolved Project root; never send its raw path. */
export const organizationSingleFileApprovalProjectRootDigest = (canonicalRoot: string): string =>
  NodeCrypto.createHash("sha256")
    .update("t3-org-project-root-v1\0", "utf8")
    .update(canonicalRoot, "utf8")
    .digest("hex");

const git = (root: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("/usr/bin/git", [...args], {
      cwd: root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/bin:/bin",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 4_096) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.stderr?.on("data", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      reject(failure("unavailable", "Current Project Git revision cannot be read."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut || bytes > 4_096)
        reject(failure("unavailable", "Current Project Git revision read exceeded its limit."));
      else if (code !== 0)
        reject(failure("conflict", "Current Project Git revision is unavailable."));
      else resolve(Buffer.concat(chunks, bytes).toString("utf8").trim());
    });
  });

export interface OrganizationSingleFileApprovalRevisionGuardShape {
  readonly verifyCurrent: (input: {
    readonly projectId: string;
    readonly baseCommit: string;
  }) => Effect.Effect<void, OrganizationSingleFileApprovalRevisionError>;
}
export class OrganizationSingleFileApprovalRevisionGuard extends Context.Service<
  OrganizationSingleFileApprovalRevisionGuard,
  OrganizationSingleFileApprovalRevisionGuardShape
>()(
  "t3/organizations/OrganizationSingleFileApprovalRevision/OrganizationSingleFileApprovalRevisionGuard",
) {}
export const OrganizationSingleFileApprovalRevisionGuardDisabled = Layer.succeed(
  OrganizationSingleFileApprovalRevisionGuard,
  {
    verifyCurrent: () =>
      Effect.fail(failure("unavailable", "Current Git revision guard is disabled.")),
  },
);

const revisionGuardLayer = (expectedCanonicalRoot?: string) =>
  Layer.effect(
    OrganizationSingleFileApprovalRevisionGuard,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        verifyCurrent: ({ projectId, baseCommit }) =>
          Effect.gen(function* () {
            if (!FULL_OID.test(baseCommit))
              return yield* failure("conflict", "Pinned base revision is invalid.");
            const project = (yield* sql<{ workspace_root: string }>`SELECT workspace_root
          FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL`)[0];
            if (!project || !NodePath.isAbsolute(project.workspace_root))
              return yield* failure("conflict", "Current Project root is unavailable.");
            const root = yield* Effect.tryPromise({
              try: () => NodeFSP.realpath(project.workspace_root),
              catch: () => failure("unavailable", "Current Project root cannot be resolved."),
            });
            if (expectedCanonicalRoot !== undefined && root !== expectedCanonicalRoot)
              return yield* failure("conflict", "Project root differs from the reviewed target.");
            const read = (args: readonly string[]) =>
              Effect.tryPromise({
                try: () => git(root, args),
                catch: (error) =>
                  isRevisionError(error)
                    ? error
                    : failure("unavailable", "Current Project Git revision cannot be read."),
              });
            const top = yield* read(["rev-parse", "--show-toplevel"]);
            if (!NodePath.isAbsolute(top))
              return yield* failure("conflict", "Project is not a Git repository root.");
            const canonicalTop = yield* Effect.tryPromise({
              try: () => NodeFSP.realpath(top),
              catch: () => failure("unavailable", "Git repository root cannot be resolved."),
            });
            if (canonicalTop !== root)
              return yield* failure("conflict", "Project is not the Git repository root.");
            const head = yield* read(["rev-parse", "--verify", "HEAD^{commit}"]);
            if (!FULL_OID.test(head) || head !== baseCommit)
              return yield* failure(
                "conflict",
                "Project HEAD differs from the reviewed base revision.",
              );
          }).pipe(
            Effect.mapError((error) =>
              isRevisionError(error)
                ? error
                : failure("unavailable", "Current Project revision check failed."),
            ),
          ),
      } satisfies OrganizationSingleFileApprovalRevisionGuardShape;
    }),
  );

export const OrganizationSingleFileApprovalRevisionGuardLive = revisionGuardLayer();

/** Pin the resolved Project root across both checks of one approval request. */
export const organizationSingleFileApprovalRevisionGuardForRoot = (canonicalRoot: string) =>
  revisionGuardLayer(canonicalRoot);
