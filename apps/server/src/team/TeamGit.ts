import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
// @effect-diagnostics nodeBuiltinImport:off - restricted Git and no-follow file handles require native process/filesystem primitives.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import {
  TeamFileError,
  TEAM_BUNDLE_BYTES,
  TEAM_FILE_BYTES,
  type TeamFileEntry,
} from "@t3tools/contracts/teamFiles";

export const fileError = (
  reason: TeamFileError["reason"],
  message = "Shared project files are unavailable or require review.",
) => new TeamFileError({ reason, message });
export const TEAM_TREE_METADATA_BYTES = 4 * 1024 * 1024;
/** Conservative serialized-entry budget also leaves room for delta removals and RPC framing. */
export function validateSharedTree(entries: readonly { path: string; size: number }[]) {
  if (
    entries.length > 10000 ||
    entries.reduce((sum, entry) => sum + entry.size, 0) > 64 * 1024 * 1024
  )
    throw fileError(
      "limit",
      "The shared working tree exceeds 10,000 files or 64 MiB. Reduce the selected tree before sharing.",
    );
  const names = new Set<string>();
  let metadata = 0;
  for (const entry of entries) {
    sharedPath(entry.path);
    const name = entry.path.normalize("NFC").toLowerCase();
    if (names.has(name))
      throw fileError(
        "conflict",
        "The shared tree contains names that collide after Unicode or case normalization.",
      );
    names.add(name);
    metadata += Buffer.byteLength(entry.path) * 2 + 192;
  }
  if (metadata > TEAM_TREE_METADATA_BYTES)
    throw fileError(
      "limit",
      "The shared tree exceeds the 4 MiB path-metadata budget. Shorten names or reduce the selected tree.",
    );
  for (const name of names) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index++)
      if (names.has(parts.slice(0, index).join("/")))
        throw fileError(
          "conflict",
          "A shared file conflicts with a directory needed by another file. Resolve the paths before publishing.",
        );
  }
}
export const contentHash = (value: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
export function sharedPath(name: string) {
  const parts = name.split("/");
  if (
    !name ||
    Buffer.byteLength(name) > 1024 ||
    /[\\:\p{Cc}]/u.test(name) ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.toLowerCase() === ".git" ||
        /[. ]$/.test(part),
    )
  )
    throw fileError("invalid");
  return parts;
}
export function privatePath(name: string) {
  return sharedPath(name).some(
    (part) =>
      /^(?:\.env(?:\..*)?|\.t3(?:-team-sync)?|\.ssh|\.aws|\.claude|\.codex|node_modules|dist|build|coverage|\.next|\.cache|\.DS_Store)$/i.test(
        part,
      ) || /\.(?:pem|key|p12|pfx)$/i.test(part),
  );
}
export async function checkedRoot(root: string) {
  if (HostProcessPlatform.defaultValue() !== "linux")
    throw new TeamFileError({
      reason: "unsupported_platform",
      message:
        "Shared file operations currently require a Linux T3 host. Personal projects are unaffected.",
    });
  const stat = await NodeFSP.lstat(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await NodeFSP.realpath(root)) !== NodePath.resolve(root)
  )
    throw fileError("root_changed");
  return `${stat.dev}:${stat.ino}`;
}
/** Linux procfs directory descriptors anchor every lookup; final-component NOFOLLOW alone is insufficient. */
export async function withSharedParent<A>(
  root: string,
  name: string,
  create: boolean,
  use: (target: string, rootFd: string) => Promise<A>,
  expectedIdentity?: string,
): Promise<A> {
  const parts = sharedPath(name);
  const identity = await checkedRoot(root);
  if (expectedIdentity !== undefined && identity !== expectedIdentity)
    throw fileError("root_changed");
  const handles: Array<NodeFSP.FileHandle> = [];
  try {
    const rootHandle = await NodeFSP.open(
      root,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
    );
    handles.push(rootHandle);
    const stat = await rootHandle.stat();
    if (`${stat.dev}:${stat.ino}` !== identity) throw fileError("root_changed");
    const rootFd = `/proc/self/fd/${rootHandle.fd}`;
    if ((await NodeFSP.realpath(rootFd)) !== root) throw fileError("root_changed");
    let directory = rootFd;
    for (const part of parts.slice(0, -1)) {
      const next = `${directory}/${part}`;
      if (create)
        await NodeFSP.mkdir(next).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      const handle = await NodeFSP.open(
        next,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
      );
      handles.push(handle);
      directory = `/proc/self/fd/${handle.fd}`;
      const canonical = await NodeFSP.realpath(directory);
      if (!canonical.startsWith(`${root}/`)) throw fileError("root_changed");
    }
    return await use(`${directory}/${parts.at(-1)!}`, rootFd);
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}
export async function readSafeHandle(handle: NodeFSP.FileHandle) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > TEAM_FILE_BYTES) throw fileError("limit");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
    size += chunk.length;
    if (size > TEAM_FILE_BYTES) throw fileError("limit");
    chunks.push(chunk);
  }
  const after = await handle.stat();
  if (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.size !== stat.size)
    throw fileError("conflict");
  return { bytes: Buffer.concat(chunks), executable: (stat.mode & 0o111) !== 0 };
}
export async function safeFile(
  root: string,
  name: string,
  expectedIdentity?: string,
): Promise<{ bytes: Buffer; executable: boolean } | null> {
  return withSharedParent(
    root,
    name,
    false,
    async (target) => {
      const handle = await NodeFSP.open(
        target,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
      );
      try {
        return await readSafeHandle(handle);
      } finally {
        await handle.close();
      }
    },
    expectedIdentity,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}
export async function safeRead(
  root: string,
  name: string,
  expectedIdentity?: string,
): Promise<Buffer | null> {
  return (await safeFile(root, name, expectedIdentity))?.bytes ?? null;
}

/** No ambient credentials, Git configuration, helpers, hooks or network protocols enter this process. */
export function restrictedGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  maxBuffer = 16 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "/usr/bin/prlimit",
      [
        "--core=0",
        "--as=805306368",
        "--fsize=805306368",
        "--cpu=120",
        "--",
        "/usr/bin/git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=always",
        "-c",
        "fetch.fsckObjects=true",
        "-c",
        "transfer.fsckObjects=true",
        "-c",
        "core.logAllRefUpdates=false",
        "-c",
        "pack.threads=1",
        "-c",
        "fetch.unpackLimit=0",
        "-c",
        "transfer.unpackLimit=0",
        "-c",
        "pack.windowMemory=32m",
        "-c",
        "pack.deltaCacheSize=16m",
        "-c",
        "core.bigFileThreshold=1m",
        "-c",
        "submodule.recurse=false",
        ...args,
      ],
      {
        cwd,
        detached: true,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          LANG: "C",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_NO_LAZY_FETCH: "1",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let errorBytes = 0;
    let failed: "limit" | "invalid" | undefined;
    // This process owns the detached group, including index-pack/pack-objects children.
    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    };
    const abort = () => {
      failed = "invalid";
      killGroup();
    };
    // @effect-diagnostics-next-line globalTimers:off - native process timeout must also kill its owned children.
    const timer = setTimeout(() => {
      failed = "limit";
      killGroup();
    }, 120000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) {
        failed = "limit";
        killGroup();
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > maxBuffer) {
        failed = "limit";
        killGroup();
      }
    });
    child.on("error", () => {
      failed = "invalid";
      killGroup();
    });
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (code !== 0 || failed)
        reject(
          fileError(
            failed ??
              (exitSignal === "SIGKILL" || exitSignal === "SIGXCPU" || exitSignal === "SIGXFSZ"
                ? "limit"
                : "invalid"),
            "Restricted Git failed or exceeded its process resource budget; the selected history may be unsupported.",
          ),
        );
      else resolve(Buffer.concat(chunks));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export async function gitIdentity(root: string, signal?: AbortSignal, includeStatus = true) {
  await checkedRoot(root);
  await NodeFSP.access("/usr/bin/prlimit", NodeFS.constants.X_OK).catch(() => {
    throw fileError(
      "unsupported_platform",
      "Shared Git operations require the Linux util-linux prlimit utility at /usr/bin/prlimit.",
    );
  });
  const git = (args: readonly string[]) => restrictedGit(root, args, signal);
  const top = (await git(["rev-parse", "--show-toplevel"])).toString().trim();
  if ((await NodeFSP.realpath(top)) !== root) throw fileError("invalid");
  const gitdir = (await git(["rev-parse", "--absolute-git-dir"])).toString().trim();
  // Linked worktrees, alternate stores and partial/shallow repositories need an explicit separate design.
  if (gitdir !== NodePath.join(root, ".git") || !(await NodeFSP.lstat(gitdir)).isDirectory())
    throw fileError("invalid");
  for (const name of [
    "objects/info/alternates",
    "objects/info/http-alternates",
    "shallow",
    "info/grafts",
  ])
    if (
      await NodeFSP.stat(NodePath.join(gitdir, name)).then(
        () => true,
        () => false,
      )
    )
      throw fileError("invalid");
  const config = (await git(["config", "--local", "--list"])).toString();
  if (/^(?:extensions\.partialclone|remote\..*\.promisor|extensions\.objectformat)=/im.test(config))
    throw fileError("invalid");
  const branch = (await git(["symbolic-ref", "--short", "HEAD"])).toString().trim();
  await git(["check-ref-format", `refs/heads/${branch}`]);
  const commit = await git(["rev-parse", "--verify", "HEAD"]).then(
    (out) => out.toString().trim(),
    () => null,
  );
  if (commit !== null && !/^[a-f0-9]{40}$/.test(commit)) throw fileError("invalid");
  // status/diff against the working tree can execute clean/process filters. Compare raw
  // index objects ourselves; ls-files only enumerates names and never converts content.
  const excluded = new Set<string>();
  if (includeStatus) {
    for (const record of (await git(["ls-files", "--stage", "-z"]))
      .toString()
      .split("\0")
      .filter(Boolean)) {
      const match = /^(\d+) ([a-f0-9]{40}) (\d)\t(.+)$/.exec(record);
      if (!match) throw fileError("invalid");
      const name = match[4]!;
      const file = await safeFile(root, name).catch(() => null);
      const hash = file
        ? NodeCrypto.createHash("sha1")
            .update(`blob ${file.bytes.length}\0`)
            .update(file.bytes)
            .digest("hex")
        : null;
      if (match[3] !== "0" || hash !== match[2] || file?.executable !== (match[1] === "100755"))
        excluded.add(name);
    }
    const lists = [
      ["ls-files", "--others", "--exclude-standard", "-z"],
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      ...(commit
        ? [["diff", "--cached", "--name-only", "--no-ext-diff", "--no-textconv", "-z", commit]]
        : []),
    ];
    for (const args of lists)
      for (const name of (await git(args)).toString().split("\0").filter(Boolean))
        excluded.add(name);
  }
  const excludedChanges = excluded.size;
  return { branch, commit, excludedChanges };
}
export async function exportBundle(root: string, destination: string, signal?: AbortSignal) {
  const identity = await gitIdentity(root, signal);
  if (identity.commit)
    await restrictedGit(
      root,
      ["bundle", "create", destination, `refs/heads/${identity.branch}`],
      signal,
    );
  else await NodeFSP.writeFile(destination, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  const stat = await NodeFSP.stat(destination);
  if (stat.size > TEAM_BUNDLE_BYTES) throw fileError("limit");
  const hash = await hashFile(destination);
  const after = await gitIdentity(root, signal);
  if (after.commit !== identity.commit || after.branch !== identity.branch)
    throw fileError("branch_changed");
  return { ...identity, bytes: stat.size, hash };
}
export async function hashFile(file: string) {
  const hash = NodeCrypto.createHash("sha256");
  const handle = await NodeFSP.open(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}
export async function verifyBundle(
  directory: string,
  bundle: string,
  branch: string,
  commit: string | null,
  signal?: AbortSignal,
  expandedByteLimit = 1024 * 1024 * 1024,
) {
  const deadline = process.hrtime.bigint() + 120_000_000_000n;
  const timeout = AbortSignal.timeout(120000);
  const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  await NodeFSP.mkdir(directory, { mode: 0o700 });
  await restrictedGit(
    directory,
    ["init", "--bare", "--template=", "--initial-branch", branch],
    boundedSignal,
  );
  const git = (args: readonly string[], maxBuffer?: number) =>
    restrictedGit(directory, args, boundedSignal, maxBuffer);
  await git(["check-ref-format", `refs/heads/${branch}`]);
  if (!commit) {
    if ((await NodeFSP.stat(bundle)).size !== 0) throw fileError("invalid");
    return [] as Array<TeamFileEntry & { content: string }>;
  }
  const heads = (await git(["bundle", "list-heads", bundle])).toString().trim();
  if (heads !== `${commit} refs/heads/${branch}`) throw fileError("invalid");
  await git(["bundle", "verify", bundle]);
  const handle = await NodeFSP.open(bundle, "r");
  try {
    if ((await handle.stat()).size > TEAM_BUNDLE_BYTES) throw fileError("limit");
    const header = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const end = header.subarray(0, bytesRead).indexOf("\n\n");
    const offset = end + 2;
    if (
      end < 0 ||
      offset + 12 > bytesRead ||
      header.toString("ascii", offset, offset + 4) !== "PACK" ||
      ![2, 3].includes(header.readUInt32BE(offset + 4))
    )
      throw fileError("invalid", "The bundle header or pack format is unsupported.");
    if (header.readUInt32BE(offset + 8) > 250000)
      throw fileError("limit", "Selected history exceeds the 250,000-object import limit.");
  } finally {
    await handle.close();
  }
  await git([
    "-c",
    "fetch.fsckObjects=false",
    "-c",
    "transfer.fsckObjects=false",
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    bundle,
    `refs/heads/${branch}:refs/heads/${branch}`,
  ]);

  const objects = (await git(["rev-list", "--objects", "--no-object-names", commit]))
    .toString()
    .trim()
    .split("\n");
  if (objects.length > 250000)
    throw fileError("limit", "Selected history exceeds 250,000 reachable objects.");
  const reachable = new Set(objects);
  const inventory = (
    await git([
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname) %(objecttype) %(objectsize)",
    ])
  )
    .toString()
    .trim()
    .split("\n");
  let expanded = 0;
  for (const record of inventory) {
    const match = /^([a-f0-9]{40}) (blob|tree|commit|tag) (\d+)$/.exec(record);
    if (!match || !reachable.delete(match[1]!))
      throw fileError(
        "invalid",
        "The bundle contains objects outside the selected branch history.",
      );
    expanded += Number(match[3]);
    if (
      expanded > Math.min(expandedByteLimit, 1024 * 1024 * 1024) ||
      (match[2] === "blob" && Number(match[3]) > 64 * 1024 * 1024)
    )
      throw fileError(
        "limit",
        "Selected history exceeds 1 GiB of expanded objects or a 64 MiB historical blob. Reduce the history before sharing.",
      );
  }
  if (reachable.size) throw fileError("invalid");
  await git(["fsck", "--strict", "--no-reflogs"]);
  const trees = [
    ...new Set((await git(["log", "--format=%T", commit])).toString().trim().split("\n")),
  ];
  if (trees.length > 10000) throw fileError("limit");
  let historicalEntries = 0;
  for (const rootTree of trees) {
    if (process.hrtime.bigint() > deadline) throw fileError("limit");
    const historicalTree: Array<{ path: string; size: number }> = [];
    for (const entry of (await git(["ls-tree", "-rz", rootTree]))
      .toString()
      .split("\0")
      .filter(Boolean)) {
      if (++historicalEntries > 500000) throw fileError("limit");
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
      if (!match)
        throw fileError(
          "invalid",
          "Selected history contains unsupported Git entries; symlinks and submodules cannot be shared.",
        );
      if (privatePath(match[3]!))
        throw fileError(
          "invalid",
          "Selected history contains a protected environment, credential, runtime, dependency, or build path. It was not excluded from the bundle. Select sanitized history before sharing; retrying unchanged history will not help.",
        );
      historicalTree.push({ path: match[3]!, size: 0 });
    }
    validateSharedTree(historicalTree);
  }
  const tree = await git(["ls-tree", "-rz", "--full-tree", commit]);
  const entries = tree.toString().split("\0").filter(Boolean);
  if (entries.length > 10000) throw fileError("limit");
  const files: Array<TeamFileEntry & { content: string }> = [];
  let total = 0;
  for (const entry of entries) {
    if (process.hrtime.bigint() > deadline) throw fileError("limit");
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match) throw fileError("invalid");
    const name = match[3]!;
    sharedPath(name);
    if (privatePath(name)) throw fileError("invalid");
    const size = Number((await git(["cat-file", "-s", match[2]!])).toString());
    total += size;
    if (size > TEAM_FILE_BYTES || total > 64 * 1024 * 1024)
      throw fileError(
        "limit",
        "Selected Git history has a working file over 1 MiB or a current tree over 64 MiB. Reduce the selected files or use sanitized history before sharing.",
      );
    const content = await git(["cat-file", "blob", match[2]!], TEAM_FILE_BYTES + 1);
    files.push({
      path: name,
      hash: contentHash(content),
      size: content.length,
      executable: match[1] === "100755",
      content: content.toString("base64"),
    });
  }
  validateSharedTree(files);
  return files;
}
export async function validateDestination(destination: string) {
  if (!NodePath.isAbsolute(destination) || NodePath.resolve(destination) !== destination)
    throw fileError("destination");
  const parent = NodePath.dirname(destination);
  await checkedRoot(parent);
  const stat = await NodeFSP.lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (
    stat &&
    (!stat.isDirectory() || stat.isSymbolicLink() || (await NodeFSP.readdir(destination)).length)
  )
    throw fileError("destination");
  return stat ? `${stat.dev}:${stat.ino}` : null;
}
export async function installCheckout(
  staging: string,
  destination: string,
  identity: string | null,
) {
  if ((await validateDestination(destination)) !== identity) throw fileError("destination");
  if (identity) await NodeFSP.rmdir(destination); // rmdir refuses a concurrently populated directory.
  // Rename never targets an existing directory; final identity check above preserves nonempty destinations.
  await NodeFSP.rename(staging, destination);
}
export async function checkoutBundle(
  bundle: string,
  destination: string,
  branch: string,
  commit: string | null,
  signal?: AbortSignal,
) {
  await NodeFSP.mkdir(destination, { mode: 0o700 });
  await restrictedGit(destination, ["init", "--template=", "--initial-branch", branch], signal);
  if (commit) {
    await restrictedGit(
      destination,
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        bundle,
        `refs/heads/${branch}:refs/teams/bootstrap`,
      ],
      signal,
    );
    await restrictedGit(destination, ["update-ref", `refs/heads/${branch}`, commit], signal);
    await restrictedGit(destination, ["read-tree", "HEAD"], signal);
    // No checkout filters are run: materialize validated blobs ourselves.
    const scratch = `${destination}-verify-${NodeCrypto.randomBytes(8).toString("hex")}`;
    try {
      for (const entry of await verifyBundle(scratch, bundle, branch, commit, signal)) {
        const file = NodePath.join(destination, ...sharedPath(entry.path));
        await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
        await NodeFSP.writeFile(file, Buffer.from(entry.content, "base64"), {
          flag: "wx",
          mode: entry.executable ? 0o755 : 0o644,
        });
      }
    } finally {
      await NodeFSP.rm(scratch, { recursive: true, force: true });
    }
  }
}

/** Same quarantine verifier as cloud publication, before any shared metadata is created. */
export async function preflightRepository(root: string, signal?: AbortSignal) {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(root), ".t3-team-preflight-"),
  );
  try {
    const bundle = NodePath.join(directory, "source.bundle");
    const identity = await exportBundle(root, bundle, signal);
    await verifyBundle(
      NodePath.join(directory, "verify"),
      bundle,
      identity.branch,
      identity.commit,
      signal,
    );
    const after = await gitIdentity(root, signal, false);
    if (identity.branch !== after.branch || identity.commit !== after.commit)
      throw fileError("branch_changed");
    return identity;
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
