import type { BrowserNavigationTarget, EnvironmentId } from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";

export function phoneBrowserTargetUrl(target: BrowserNavigationTarget): string {
  if (target.kind === "url") return normalizePreviewUrl(target.url);
  const url = new URL(`${target.protocol ?? "http"}://localhost:${target.port}/`);
  const path = new URL(target.path?.replace(/^\/+/, "") ?? "", url);
  url.pathname = path.pathname;
  url.search = path.search;
  url.hash = path.hash;
  return url.toString();
}

export function phoneBrowserShareRequired(environmentId: EnvironmentId, url: string): boolean {
  if (!isLoopbackHost(new URL(normalizePreviewUrl(url)).hostname)) return false;
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
  if (config?.environment.capabilities.previewTemporarySharing !== true)
    throw new Error(
      "Update this environment to enable temporary localhost sharing for the phone browser.",
    );
  return true;
}
