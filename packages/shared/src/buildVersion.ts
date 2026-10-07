/** Presentation only. Installer/recovery identities and their ordering always retain the exact release version. */
export interface DisplayBuild {
  readonly version: string;
  readonly upstreamVersion?: string;
  readonly forkBuildNumber?: number;
}

const legacyFork = /^(\d+\.\d+\.\d+)-fork\.(\d+)$/;
const nightly = /^\d+\.\d+\.\d+-nightly\.\d{8}\.(\d+)$/;

/** An unlabelled release from the independent 1.x series does not prove its upstream base. */
export function includedUpstreamVersion(build: DisplayBuild): string | null {
  return build.upstreamVersion ?? legacyFork.exec(build.version)?.[1] ?? null;
}

export function formatBuildVersion(build: DisplayBuild): string {
  const legacy = legacyFork.exec(build.version);
  const preview = nightly.exec(build.version);
  const number =
    build.forkBuildNumber ?? (legacy ? Number(legacy[2]) : preview ? Number(preview[1]) : null);
  const upstream = includedUpstreamVersion(build);
  if (number !== null) {
    return [
      upstream,
      `Arcwright build ${number}`,
      legacy ? "Legacy" : preview ? "Nightly" : "Stable",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (upstream)
    return `${upstream} · Arcwright ${build.version === upstream ? "Development" : "Stable"}`;
  return build.version;
}
