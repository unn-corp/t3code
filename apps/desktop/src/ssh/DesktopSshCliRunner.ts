import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";

// Local preview artifacts have no published CLI archive. An explicit pin lets
// them use an available remote runtime while retaining their own build identity.
export function resolveDesktopSshCliRunner(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
  readonly nodeScriptPath?: string | undefined;
  readonly nodeEngineRange: string;
  readonly archiveVersion?: string | undefined;
}): RemoteT3RunnerOptions {
  if (input.isDevelopment && input.nodeScriptPath !== undefined) {
    return { nodeScriptPath: input.nodeScriptPath, nodeEngineRange: input.nodeEngineRange };
  }
  return { archiveVersion: input.archiveVersion ?? input.appVersion };
}
