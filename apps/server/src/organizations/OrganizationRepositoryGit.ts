import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- bounded native Git subprocess
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- lstat checks untrusted clone entries
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- path comparison at Git boundary
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";
import {
  OrganizationRepositoryRecord,
  type OrganizationRepositoryRecord as RecordValue,
} from "@t3tools/contracts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeRecord = Schema.decodeUnknownSync(OrganizationRepositoryRecord);
export const MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_REPOSITORY_BYTES = 128 * 1024 * 1024;
export const MAX_RECORDS = 10_000;
const nameDigest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, current: unknown) =>
    current && typeof current === "object" && !Array.isArray(current)
      ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)))
      : current,
  );
export const recordJson = (record: RecordValue) => `${canonical(record)}\n`;
export const recordDigest = (record: RecordValue) =>
  NodeCrypto.createHash("sha256").update(recordJson(record)).digest("hex");
export const recordKey = (record: RecordValue) => `${record.kind}/${record.id}`;
export const recordPath = (record: RecordValue) =>
  `records/${record.kind}/${nameDigest(record.id)}.json`;

export function decodeRepositoryRecord(raw: string, organizationId: string): RecordValue {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES)
    throw new Error("Repository record is too large.");
  const parsed: unknown = JSON.parse(raw);
  const decoded = decodeRecord(parsed);
  if (decoded.organizationId !== organizationId)
    throw new Error("Repository belongs to another Organization.");
  return decoded;
}

export async function readRepositoryRecords(directory: string, organizationId: string) {
  const root = NodePath.join(directory, "records");
  const result = new Map<string, RecordValue>();
  let bytes = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    for (const entry of await NodeFSP.readdir(path, { withFileTypes: true })) {
      const target = NodePath.join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Repository record symlinks are not allowed.");
      if (entry.isDirectory()) {
        if (depth !== 0) throw new Error("Repository record directories are too deep.");
        await walk(target, depth + 1);
        continue;
      }
      if (depth !== 1) throw new Error("Repository records must be in a category directory.");
      if (!entry.isFile()) throw new Error("Repository contains an unsupported record entry.");
      const stat = await NodeFSP.lstat(target);
      bytes += stat.size;
      if (
        stat.size > MAX_RECORD_BYTES ||
        bytes > MAX_REPOSITORY_BYTES ||
        result.size >= MAX_RECORDS
      )
        throw new Error("Repository record limits were exceeded.");
      const raw = await NodeFSP.readFile(target, "utf8");
      const record = decodeRepositoryRecord(raw, organizationId);
      const expected = NodePath.resolve(directory, recordPath(record));
      if (
        expected !== NodePath.resolve(target) ||
        NodePath.relative(directory, target).startsWith(`..${NodePath.sep}`)
      )
        throw new Error("Repository record path does not match its identity.");
      const key = recordKey(record);
      if (result.has(key)) throw new Error("Repository has duplicate record identities.");
      result.set(key, record);
    }
  };
  try {
    const stat = await NodeFSP.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Repository records must be a regular directory.");
    await walk(root, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
}

export async function readRepositoryIdentity(directory: string): Promise<string | null> {
  let raw: string;
  try {
    const identityPath = NodePath.join(directory, "organization.json");
    const stat = await NodeFSP.lstat(identityPath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Repository identity must be a regular file.");
    raw = await NodeFSP.readFile(identityPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > 1024) throw new Error("Repository identity is too large.");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Repository identity is invalid.");
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.organizationId !== "string" ||
    !manifest.organizationId.trim() ||
    manifest.organizationId.length > 256
  )
    throw new Error("Repository identity is invalid.");
  return manifest.organizationId;
}

export async function writeRepositoryIdentity(directory: string, organizationId: string) {
  await NodeFSP.writeFile(
    NodePath.join(directory, "organization.json"),
    `${JSON.stringify({ schemaVersion: 1, organizationId })}\n`,
    { flag: "w" },
  );
}

export async function writeRepositoryRecord(directory: string, record: RecordValue) {
  const path = NodePath.join(directory, recordPath(record));
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, recordJson(record), { flag: "w" });
}

const command = async (
  program: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  maxBuffer = 1024 * 1024,
) => {
  const result = await exec(program, args, { cwd, env, timeout: 90_000, maxBuffer });
  return result.stdout.trim();
};

/** Match the account's GitHub host as well as the repository path after gh clone. */
export function matchesGitHubRepositoryOrigin(
  origin: string,
  repository: string,
  host: string,
): boolean {
  const normalizedHost = host.toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(normalizedHost) ||
    normalizedHost.includes("..") ||
    normalizedHost.endsWith(".") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
  )
    return false;
  const normalized = origin
    .trim()
    .replace(/\.git$/, "")
    .toLowerCase();
  const path = repository.toLowerCase();
  return (
    normalized === `https://${normalizedHost}/${path}` ||
    normalized === `git@${normalizedHost}:${path}` ||
    normalized === `ssh://git@${normalizedHost}/${path}`
  );
}

async function checkRepositoryTree(directory: string, env: NodeJS.ProcessEnv) {
  const tree = await command(
    "git",
    ["ls-tree", "-r", "-l", "-z", "HEAD"],
    directory,
    env,
    4 * 1024 * 1024,
  );
  let bytes = 0;
  let entries = 0;
  for (const line of tree.split("\0")) {
    if (!line) continue;
    const match = /^(\d{6}) blob (?:[a-f0-9]{40}|[a-f0-9]{64})\s+(\d+)\t(.+)$/.exec(line);
    if (!match) throw new Error("Repository contains unsupported Git objects.");
    const [, mode, sizeText, path] = match;
    if (mode !== "100644" && mode !== "100755")
      throw new Error("Repository contains a symlink or unsupported file.");
    if (
      path !== "organization.json" &&
      path !== "README.md" &&
      path !== "LICENSE" &&
      !path?.startsWith("records/")
    )
      throw new Error("Organization repository contains unrelated files.");
    if (path.split("/").some((part) => part === "." || part === ".."))
      throw new Error("Repository path is invalid.");
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Repository size is invalid.");
    bytes += size;
    entries++;
    if (bytes > MAX_REPOSITORY_BYTES || entries > MAX_RECORDS + 3)
      throw new Error("Repository exceeds its size or file limit.");
  }
}

/** A disposable clone keeps checkout state away from Project repositories. */
export async function withRepositoryClone<A>(
  repository: string,
  env: NodeJS.ProcessEnv,
  fn: (directory: string, head: string | null) => Promise<A>,
  verifyOrigin = true,
): Promise<A> {
  const parent = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-organization-repository-"),
  );
  await NodeFSP.chmod(parent, 0o700);
  const directory = NodePath.join(parent, "repo");
  try {
    await command(
      "gh",
      [
        "repo",
        "clone",
        repository,
        directory,
        "--no-upstream",
        "--",
        "--no-checkout",
        "--filter=blob:none",
        "--depth=1",
      ],
      parent,
      env,
    );
    if (verifyOrigin) {
      const origin = await command("git", ["remote", "get-url", "origin"], directory, env);
      if (!matchesGitHubRepositoryOrigin(origin, repository, env.GH_HOST ?? "github.com"))
        throw new Error("Git origin does not match the selected GitHub repository.");
    }
    const head = await command("git", ["rev-parse", "HEAD"], directory, env).catch(() => null);
    if (head) await checkRepositoryTree(directory, env);
    await command(
      "git",
      ["-c", "core.hooksPath=/dev/null", "checkout", "-B", "t3-organization-sync"],
      directory,
      env,
    );
    return await fn(directory, head);
  } finally {
    await NodeFSP.rm(parent, { recursive: true, force: true });
  }
}

export async function commitAndPush(directory: string, env: NodeJS.ProcessEnv, message: string) {
  await command("git", ["add", "--", "organization.json", "records"], directory, env);
  const changed = await command("git", ["diff", "--cached", "--name-only"], directory, env);
  if (!changed)
    return await command("git", ["rev-parse", "HEAD"], directory, env).catch(() => null);
  await command(
    "git",
    [
      "-c",
      "user.name=T3 Code",
      "-c",
      "user.email=t3-code@users.noreply.github.com",
      "commit",
      "-m",
      message,
    ],
    directory,
    env,
  );
  const branch = await command(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    directory,
    env,
  )
    .then((value) => value.replace(/^origin\//, ""))
    .catch(async () => {
      const remoteHeads = await command(
        "git",
        ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"],
        directory,
        env,
      );
      if (remoteHeads)
        throw new Error("GitHub default branch could not be determined; sync was not pushed.");
      return "main";
    });
  // A normal fast-forward push refuses a concurrent remote update and leaves SQLite pending.
  await command(
    "git",
    [
      "-c",
      "credential.helper=!gh auth git-credential",
      "push",
      "origin",
      `HEAD:refs/heads/${branch}`,
    ],
    directory,
    env,
  );
  return command("git", ["rev-parse", "HEAD"], directory, env);
}

export async function createGitHubRepository(
  repository: string,
  visibility: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  await command("gh", ["repo", "create", repository, `--${visibility}`], cwd, env);
}

export async function inspectGitHubRepository(
  repository: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const raw = await command(
    "gh",
    ["repo", "view", repository, "--json", "nameWithOwner,visibility"],
    cwd,
    env,
  );
  const value = JSON.parse(raw) as { nameWithOwner?: unknown; visibility?: unknown };
  if (
    value.nameWithOwner !== repository ||
    !["PRIVATE", "PUBLIC", "INTERNAL"].includes(String(value.visibility))
  )
    throw new Error("GitHub repository identity or visibility did not match.");
  return String(value.visibility).toLowerCase() as "private" | "public" | "internal";
}
