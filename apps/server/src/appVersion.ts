import { buildIdentity } from "../../../scripts/lib/build-identity.ts";
import type { BuildIdentity } from "@t3tools/contracts";
import packageJson from "../package.json" with { type: "json" };

declare const __T3CODE_APP_VERSION__: string | undefined;

export function resolveAppVersion(
  buildVersion: string | undefined,
  packageVersion: string,
): string {
  return buildVersion ?? packageVersion;
}

const buildVersion =
  typeof __T3CODE_APP_VERSION__ === "undefined" ? undefined : __T3CODE_APP_VERSION__;

export const APP_VERSION = resolveAppVersion(buildVersion, packageJson.version);

declare const __T3CODE_BUILD_IDENTITY__: BuildIdentity | undefined;
export const BUILD_IDENTITY: BuildIdentity =
  typeof __T3CODE_BUILD_IDENTITY__ === "undefined"
    ? { ...buildIdentity(APP_VERSION), builtAt: null, label: "Source runtime" }
    : __T3CODE_BUILD_IDENTITY__;
