// @effect-diagnostics nodeBuiltinImport:off globalDate:off - fixtures write real files and track real timestamps.
// Shared fixtures for the fork release tests: real artifact trees on disk, manifests that satisfy
// the exact contract, and an in-memory GitHub that behaves like the REST API where it matters
// (duplicate refs are rejected, drafts publish into tags, deleted drafts disappear).
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  VALIDATION_CHECKS,
  VALIDATION_TARGETS,
  ANDROID_METADATA_FILE,
  ARTIFACT_DIRS,
  WSL_EMBEDDED_FILE,
  feedBaseName,
  sha256Bytes,
  type HelperAssetSpec,
  type VerifiedAndroidApk,
} from "./fork-release-assets.ts";
import { FORK_ANDROID_PACKAGE, type ForkReleaseManifest } from "./fork-release-contract.ts";
import { RECOVERY_HELPER_ASSETS } from "./fork-release-helper.ts";
import {
  PACKAGE_VALIDATION,
  SUITES,
  requiredSuiteRuns,
  suiteSpecDigest,
  type SuiteId,
} from "./fork-release-suites.ts";
import { assembleCandidate, composeFinalManifest } from "./fork-release.ts";
import type { CreateReleaseInput, GitHubApi, RawAsset, RawRelease } from "./fork-release-github.ts";
import {
  FORK_MANIFEST_ASSET,
  forkTagForVersion,
  type ForkChannel,
  type PlannedRelease,
  type ReleaseRecord,
} from "./fork-release-policy.ts";

export const SIGNER = "a".repeat(64);
export const sha = (seed: string): string =>
  NodeCrypto.createHash("sha1").update(seed).digest("hex");
const sha256Of = (seed: string): string =>
  NodeCrypto.createHash("sha256").update(seed).digest("hex");

// ---------------------------------------------------------------------------------------------
// Manifests and records
// ---------------------------------------------------------------------------------------------

export interface ManifestOptions {
  readonly version: string;
  readonly channel?: ForkChannel;
  readonly commit?: string;
  readonly releasedAt?: string;
  readonly normalCode?: number;
  readonly recoveryCode?: number;
  readonly recoveryCommit?: string;
  readonly recoveryVersion?: string;
  readonly checks?: Partial<ForkReleaseManifest["checks"]>;
}

export const makeManifest = (options: ManifestOptions): ForkReleaseManifest => {
  const commit = options.commit ?? sha(`commit-${options.version}`);
  const channel = options.channel ?? (options.version.includes("-nightly.") ? "nightly" : "stable");
  const normalName = `t3-code-android-${options.version}.apk`;
  const recoveryName = `t3-code-android-recovery-${options.version}.apk`;
  const asset = (
    name: string,
    kind: ForkReleaseManifest["assets"][number]["kind"],
    platform: ForkReleaseManifest["assets"][number]["platform"],
  ) => ({ name, sha256: sha256Of(name), bytes: 100 + name.length, kind, platform });
  const normalCode = options.normalCode ?? 29_853_679;
  return {
    format: 1,
    repository: "unn-corp/t3code",
    version: options.version,
    commit,
    channel,
    releasedAt: options.releasedAt ?? "2026-10-06T07:40:00.000Z",
    assets: [
      asset(`T3-Code-${options.version}-x64.exe`, "desktop", "windows-x64"),
      asset(`T3-Code-${options.version}-x86_64.AppImage`, "desktop", "linux-x64"),
      asset(normalName, "android", "android"),
      asset(recoveryName, "android-recovery", "android"),
      asset("SHA256SUMS", "feed", "shared"),
    ],
    android: {
      normal: {
        asset: normalName,
        versionCode: normalCode,
        sourceVersion: options.version,
        sourceCommit: commit,
        packageName: FORK_ANDROID_PACKAGE,
        signerSha256: SIGNER,
        updaterProtocol: 1,
      },
      recovery: {
        asset: recoveryName,
        versionCode: options.recoveryCode ?? normalCode + 1,
        sourceVersion: options.recoveryVersion ?? "0.9.0",
        sourceCommit: options.recoveryCommit ?? sha(`recovery-${options.version}`),
        packageName: FORK_ANDROID_PACKAGE,
        signerSha256: SIGNER,
        updaterProtocol: 1,
      },
    },
    checks: { build: true, install: true, update: true, recovery: true, ...options.checks },
  };
};

let nextId = 1000;

export const makeRelease = (
  options: ManifestOptions & {
    readonly draft?: boolean;
    readonly body?: string;
    readonly publishedAt?: string | null;
    readonly noManifest?: boolean;
    readonly dropAsset?: boolean;
  },
): ReleaseRecord => {
  const manifest = makeManifest(options);
  const assets = [
    ...manifest.assets.map((entry) => ({ id: nextId++, name: entry.name, size: entry.bytes })),
    ...(options.noManifest ? [] : [{ id: nextId++, name: FORK_MANIFEST_ASSET, size: 900 }]),
  ];
  return {
    id: nextId++,
    tagName: forkTagForVersion(options.version),
    draft: options.draft ?? false,
    body: options.body ?? "",
    createdAt: options.releasedAt ?? manifest.releasedAt,
    publishedAt: options.publishedAt === undefined ? manifest.releasedAt : options.publishedAt,
    assets: options.dropAsset ? assets.slice(1) : assets,
    manifest: options.noManifest ? null : manifest,
  };
};

// ---------------------------------------------------------------------------------------------
// Artifact trees
// ---------------------------------------------------------------------------------------------

export const HELPERS: ReadonlyArray<HelperAssetSpec> = RECOVERY_HELPER_ASSETS;

const write = (file: string, data: string | Buffer): string => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, data);
  return file;
};

const feedFor = (version: string, installer: string, data: Buffer): string => {
  const sha512 = NodeCrypto.createHash("sha512").update(data).digest("base64");
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${installer}`,
    `    sha512: ${sha512}`,
    `    size: ${data.length}`,
    `path: ${installer}`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-10-06T07:30:00.000Z'",
    "",
  ].join("\n");
};

export interface FixtureTree {
  readonly inputDir: string;
  readonly plan: PlannedRelease;
  readonly helperAssets: ReadonlyArray<HelperAssetSpec>;
  readonly linuxArchive: { readonly name: string; readonly sha256: string };
}

export interface FixtureOptions {
  readonly version?: string;
  readonly channel?: ForkChannel;
  readonly commit?: string;
  readonly predecessorCommit?: string;
  readonly predecessorVersion?: string;
  readonly normalCode?: number;
  /** Mutate the tree after it is written, to model a corrupted or incomplete build. */
  readonly tamper?: (inputDir: string) => void;
}

/** Writes every artifact directory the build jobs upload, with real digests and feeds. */
export const writeFixtureTree = (inputDir: string, options: FixtureOptions = {}): FixtureTree => {
  const version = options.version ?? "1.0.1-nightly.20261006.7";
  const channel = options.channel ?? "nightly";
  const commit = options.commit ?? sha("source");
  const predecessorCommit = options.predecessorCommit ?? sha("predecessor");
  const predecessorVersion = options.predecessorVersion ?? "1.0.0";
  const normalCode = options.normalCode ?? 29_853_679;
  const feed = feedBaseName(channel);

  const exe = Buffer.from(`windows-installer-${version}`);
  const exeName = `T3-Code-${version}-x64.exe`;
  write(NodePath.join(inputDir, ARTIFACT_DIRS.windowsDesktop, exeName), exe);
  write(
    NodePath.join(inputDir, ARTIFACT_DIRS.windowsDesktop, `${exeName}.blockmap`),
    "blockmap-win",
  );
  write(
    NodePath.join(inputDir, ARTIFACT_DIRS.windowsDesktop, `${feed}-win-x64.yml`),
    feedFor(version, exeName, exe),
  );
  write(
    NodePath.join(inputDir, ARTIFACT_DIRS.windowsDesktop, "builder-debug.yml"),
    "debug: true\n",
  );

  const appImage = Buffer.from(`appimage-${version}`);
  const appImageName = `T3-Code-${version}-x86_64.AppImage`;
  write(NodePath.join(inputDir, ARTIFACT_DIRS.linuxDesktop, appImageName), appImage);
  write(
    NodePath.join(inputDir, ARTIFACT_DIRS.linuxDesktop, `${appImageName}.blockmap`),
    "blockmap-linux",
  );
  write(
    NodePath.join(inputDir, ARTIFACT_DIRS.linuxDesktop, `T3-Code-${version}-amd64.deb`),
    "deb-package",
  );
  write(
    NodePath.join(inputDir, ARTIFACT_DIRS.linuxDesktop, `${feed}-linux.yml`),
    feedFor(version, appImageName, appImage),
  );

  const archive = Buffer.from(`linux-server-archive-${version}`);
  const archiveName = `t3-${version}-linux-x64.tar.gz`;
  write(NodePath.join(inputDir, ARTIFACT_DIRS.linuxServer, archiveName), archive);
  write(
    NodePath.join(inputDir, ARTIFACT_DIRS.windowsServer, `t3-${version}-win32-x64.zip`),
    "windows-server-zip",
  );
  write(
    NodePath.join(inputDir, ARTIFACT_DIRS.wslEmbedded, WSL_EMBEDDED_FILE),
    JSON.stringify({ archive: archiveName, sha256: sha256Bytes(archive) }),
  );

  const apk = (
    name: string,
    seed: string,
    code: number,
    versionName: string,
    source: string,
    dir: string,
  ) => {
    const bytes = Buffer.from(`apk-${seed}`);
    write(NodePath.join(inputDir, dir, name), bytes);
    const verified: VerifiedAndroidApk = {
      asset: name,
      versionCode: code,
      sourceVersion: versionName,
      sourceCommit: source,
      packageName: FORK_ANDROID_PACKAGE,
      signerSha256: SIGNER,
      updaterProtocol: 1,
      apkSha256: sha256Bytes(bytes),
    };
    write(NodePath.join(inputDir, dir, ANDROID_METADATA_FILE), JSON.stringify(verified));
  };
  apk(
    `t3-code-android-${version}.apk`,
    "normal",
    normalCode,
    version,
    commit,
    ARTIFACT_DIRS.androidNormal,
  );
  apk(
    `t3-code-android-recovery-${version}.apk`,
    "recovery",
    normalCode + 1,
    predecessorVersion,
    predecessorCommit,
    ARTIFACT_DIRS.androidRecovery,
  );

  for (const helper of HELPERS) {
    write(
      NodePath.join(inputDir, `recovery-helper-${helper.platform}`, helper.name),
      `helper-${helper.name}`,
    );
  }

  options.tamper?.(inputDir);
  return {
    inputDir,
    helperAssets: HELPERS,
    linuxArchive: { name: archiveName, sha256: sha256Bytes(archive) },
    plan: {
      channel,
      version,
      tag: forkTagForVersion(version),
      commit,
      source: null,
      predecessor: {
        tag: forkTagForVersion(predecessorVersion),
        version: predecessorVersion,
        commit: predecessorCommit,
      },
      recoverySources: [
        {
          tag: forkTagForVersion(predecessorVersion),
          version: predecessorVersion,
          commit: predecessorCommit,
          channel: "stable",
          asset: `t3-code-android-recovery-${version}.apk`,
        },
      ],
    },
  };
};

// ---------------------------------------------------------------------------------------------
// In-memory GitHub
// ---------------------------------------------------------------------------------------------

interface StoredRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  body: string;
  created_at: string;
  published_at: string | null;
  assets: Map<number, { name: string; data: Uint8Array }>;
}

/** Behaves like the REST API where the pipeline depends on it; hooks let tests inject races. */
export class FakeGitHub implements GitHubApi {
  readonly releases = new Map<number, StoredRelease>();
  readonly tags = new Map<string, string>();
  /** Runs before each tag creation, so a test can slip another run's reservation in first. */
  beforeCreateTag: ((name: string) => void) | null = null;
  /** Fails the n-th upload (1-based) to model an interrupted draft. */
  failUploadNumber: number | null = null;
  private uploads = 0;
  private counter = 1;
  private clock = Date.parse("2026-10-06T07:00:00.000Z");

  private tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  private toRaw(release: StoredRelease): RawRelease {
    return {
      id: release.id,
      tag_name: release.tag_name,
      draft: release.draft,
      prerelease: release.prerelease,
      body: release.body,
      created_at: release.created_at,
      published_at: release.published_at,
      assets: [...release.assets].map(([id, asset]): RawAsset => ({
        id,
        name: asset.name,
        size: asset.data.length,
      })),
    };
  }

  /** Seeds a published release with a real manifest and filler bytes of the recorded sizes. */
  seedPublished(
    manifest: ForkReleaseManifest,
    options: { body?: string; draft?: boolean } = {},
  ): StoredRelease {
    const release: StoredRelease = {
      id: this.counter++,
      tag_name: forkTagForVersion(manifest.version),
      draft: options.draft ?? false,
      prerelease: manifest.channel === "nightly",
      body: options.body ?? "",
      created_at: manifest.releasedAt,
      published_at: options.draft ? null : manifest.releasedAt,
      assets: new Map(),
    };
    for (const asset of manifest.assets) {
      release.assets.set(this.counter++, { name: asset.name, data: new Uint8Array(asset.bytes) });
    }
    release.assets.set(this.counter++, {
      name: FORK_MANIFEST_ASSET,
      data: new TextEncoder().encode(JSON.stringify(manifest)),
    });
    this.releases.set(release.id, release);
    if (!release.draft) this.tags.set(release.tag_name, manifest.commit);
    return release;
  }

  async listReleases() {
    return [...this.releases.values()].map((release) => this.toRaw(release));
  }

  async getRelease(id: number) {
    const release = this.releases.get(id);
    if (!release) throw new Error(`No release ${id}`);
    return this.toRaw(release);
  }

  async downloadAsset(id: number) {
    for (const release of this.releases.values()) {
      const asset = release.assets.get(id);
      if (asset) return asset.data;
    }
    throw new Error(`No asset ${id}`);
  }

  async listTags(prefix: string) {
    return [...this.tags.keys()].filter((name) => name.startsWith(prefix));
  }

  async createTag(name: string, commit: string) {
    this.beforeCreateTag?.(name);
    if (this.tags.has(name)) return false;
    this.tags.set(name, commit);
    return true;
  }

  async tagExists(name: string) {
    return this.tags.has(name);
  }

  async createDraftRelease(input: CreateReleaseInput) {
    const release: StoredRelease = {
      id: this.counter++,
      tag_name: input.tagName,
      draft: true,
      prerelease: input.prerelease,
      body: input.body,
      created_at: this.tick(),
      published_at: null,
      assets: new Map(),
    };
    this.releases.set(release.id, release);
    return this.toRaw(release);
  }

  async uploadAsset(releaseId: number, name: string, data: Uint8Array) {
    this.uploads += 1;
    if (this.failUploadNumber === this.uploads) throw new Error("upload interrupted");
    const release = this.releases.get(releaseId);
    if (!release) throw new Error(`No release ${releaseId}`);
    if ([...release.assets.values()].some((asset) => asset.name === name)) {
      throw new Error(`Asset ${name} already exists`);
    }
    const id = this.counter++;
    release.assets.set(id, { name, data: new Uint8Array(data) });
    return { id, name, size: data.length };
  }

  async updateRelease(
    id: number,
    patch: { body?: string; draft?: false; prerelease?: boolean; makeLatest?: boolean },
  ) {
    const release = this.releases.get(id);
    if (!release) throw new Error(`No release ${id}`);
    if (patch.body !== undefined) release.body = patch.body;
    if (patch.prerelease !== undefined) release.prerelease = patch.prerelease;
    if (patch.draft === false && release.draft) {
      release.draft = false;
      release.published_at = this.tick();
      this.tags.set(release.tag_name, "published");
    }
    return this.toRaw(release);
  }

  async deleteRelease(id: number) {
    this.releases.delete(id);
  }

  /** Test helper: corrupt one stored asset the way a bad upload would. */
  corruptAsset(releaseId: number, name: string): void {
    const release = this.releases.get(releaseId)!;
    for (const asset of release.assets.values()) {
      if (asset.name === name) asset.data = new Uint8Array(asset.data.map((byte) => byte ^ 0xff));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// A whole publishable candidate
// ---------------------------------------------------------------------------------------------

export const PREDECESSOR_DIGEST = "8".repeat(64);

export interface PreparedCandidate {
  readonly plan: PlannedRelease;
  readonly candidateDir: string;
  readonly receiptsDir: string;
  readonly manifest: ForkReleaseManifest;
  readonly checks: ForkReleaseManifest["checks"];
}

/**
 * Runs the real assemble and manifest steps over a fixture tree. Receipts are written for every
 * check except `failing`, which gets a non-zero exit, so tests exercise both outcomes.
 */
export const prepareCandidate = (
  root: string,
  options: FixtureOptions & {
    readonly failing?: ReadonlyArray<(typeof VALIDATION_CHECKS)[number]>;
    /** Suites that get no receipt at all, or a failing one, to model a skipped or red safety suite. */
    readonly omitSuites?: ReadonlyArray<SuiteId>;
    readonly failSuites?: ReadonlyArray<SuiteId>;
    readonly now?: Date;
  } = {},
): PreparedCandidate => {
  const inputDir = NodePath.join(root, "input");
  const candidateDir = NodePath.join(root, "candidate");
  const receiptsDir = NodePath.join(root, "receipts");
  const tree = writeFixtureTree(inputDir, options);
  const { problems, record } = assembleCandidate({
    plan: tree.plan,
    inputDir,
    outDir: candidateDir,
  });
  if (!record) throw new Error(`The fixture candidate did not assemble: ${problems.join("; ")}`);
  NodeFS.mkdirSync(receiptsDir, { recursive: true });
  for (const check of VALIDATION_CHECKS) {
    for (const target of VALIDATION_TARGETS) {
      const failed = options.failing?.includes(check) ?? false;
      write(
        NodePath.join(receiptsDir, `${check}-${target}.json`),
        JSON.stringify({
          format: 1,
          check,
          target,
          version: record.version,
          commit: record.commit,
          channel: record.channel,
          candidateDigest: record.candidateDigest,
          predecessorDigest: PREDECESSOR_DIGEST,
          command: [...PACKAGE_VALIDATION.run],
          exitCode: failed ? 1 : 0,
          passed: !failed,
          startedAt: "2026-10-06T07:50:00.000Z",
          finishedAt: "2026-10-06T07:55:00.000Z",
          runner: "Linux-X64",
          runUrl: "https://example.test/run",
        }),
      );
    }
  }
  for (const { suite, target } of requiredSuiteRuns()) {
    if (options.omitSuites?.includes(suite)) continue;
    const failed = options.failSuites?.includes(suite) ?? false;
    write(
      NodePath.join(receiptsDir, `suite-${suite}-${target}.json`),
      JSON.stringify(suiteReceiptFor(record, suite, target, failed)),
    );
  }
  const { checks, manifest } = composeFinalManifest({
    candidateDir,
    receiptsDir,
    predecessorDigest: PREDECESSOR_DIGEST,
    now: options.now ?? new Date("2026-10-06T08:00:00.000Z"),
  });
  return { plan: tree.plan, candidateDir, receiptsDir, manifest, checks };
};

/** A suite receipt exactly as the runner would write it for a clean (or failing) run. */
export const suiteReceiptFor = (
  record: { version: string; commit: string; channel: ForkChannel; candidateDigest: string },
  suite: SuiteId,
  target: (typeof VALIDATION_TARGETS)[number],
  failed = false,
) => ({
  format: 1,
  suite,
  target,
  version: record.version,
  commit: record.commit,
  channel: record.channel,
  candidateDigest: record.candidateDigest,
  specDigest: suiteSpecDigest(SUITES[suite]),
  testedCommit: record.commit,
  command: [...SUITES[suite].command],
  files: SUITES[suite].required.map((name) => ({ name, tests: 3 })),
  problems: failed ? ["a test failed"] : [],
  exitCode: failed ? 1 : 0,
  passed: !failed,
  startedAt: "2026-10-06T07:50:00.000Z",
  finishedAt: "2026-10-06T07:55:00.000Z",
  runner: "Linux-X64",
  runUrl: "https://example.test/run",
});
