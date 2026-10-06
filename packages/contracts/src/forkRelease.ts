import * as Schema from "effect/Schema";
import { ForkUpdateChannel } from "./maintenance.ts";

export const FORK_RELEASE_MANIFEST_ASSET = "fork-release.json";
export const FORK_RELEASE_REPOSITORY = "unn-corp/t3code";
export const FORK_ANDROID_PACKAGE = "com.devotek.t3code.pwa";
export const ForkArtifactDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const ForkSourceCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
export const ForkReleaseAsset = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]+$/)),
  sha256: ForkArtifactDigest,
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: Schema.Literals([
    "desktop",
    "server",
    "android",
    "android-recovery",
    "recovery-helper",
    "feed",
    "blockmap",
  ]),
  platform: Schema.Literals(["windows-x64", "linux-x64", "android", "shared"]),
});
export const ForkAndroidReleaseArtifact = Schema.Struct({
  asset: Schema.String,
  versionCode: Schema.Int.check(Schema.isGreaterThan(0)),
  sourceVersion: Schema.String,
  sourceCommit: ForkSourceCommit,
  packageName: Schema.Literal(FORK_ANDROID_PACKAGE),
  signerSha256: ForkArtifactDigest,
  updaterProtocol: Schema.Literal(1),
});
export const ForkReleaseManifest = Schema.Struct({
  format: Schema.Literal(1),
  repository: Schema.Literal(FORK_RELEASE_REPOSITORY),
  version: Schema.String,
  commit: ForkSourceCommit,
  channel: ForkUpdateChannel,
  releasedAt: Schema.String,
  assets: Schema.Array(ForkReleaseAsset),
  android: Schema.Struct({
    normal: ForkAndroidReleaseArtifact,
    recovery: ForkAndroidReleaseArtifact,
  }),
  checks: Schema.Struct({
    build: Schema.Boolean,
    install: Schema.Boolean,
    update: Schema.Boolean,
    recovery: Schema.Boolean,
  }),
});
export type ForkReleaseManifest = typeof ForkReleaseManifest.Type;
