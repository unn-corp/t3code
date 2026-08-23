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
