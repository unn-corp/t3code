// Release scripts use the same wire contract as clients and native build metadata.
import * as Schema from "effect/Schema";
import {
  FORK_ANDROID_PACKAGE,
  FORK_RELEASE_MANIFEST_ASSET,
  FORK_RELEASE_REPOSITORY,
  ForkReleaseManifest,
} from "@t3tools/contracts";

export { FORK_ANDROID_PACKAGE, FORK_RELEASE_MANIFEST_ASSET, FORK_RELEASE_REPOSITORY };
export type { ForkReleaseManifest } from "@t3tools/contracts";

const decode = Schema.decodeUnknownSync(ForkReleaseManifest);

/** Decodes with the exact contract schema; throws a readable error when the shape differs. */
export const decodeForkReleaseManifest = (input: unknown): ForkReleaseManifest => decode(input);
