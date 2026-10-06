import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ capable: false }));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => ({ environment: { capabilities: { previewTemporarySharing: state.capable } } }),
  },
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: (id: string) => id } }));
import { phoneBrowserShareRequired, phoneBrowserTargetUrl } from "./temporaryBrowserShare";
const environmentId = EnvironmentId.make("phone-environment");
beforeEach(() => {
  state.capable = false;
});
it("keeps environment-port targets on the host loopback until the server shares them", () => {
  expect(
    phoneBrowserTargetUrl({
      kind: "environment-port",
      port: 5173,
      path: "/settings?tab=one#section",
    }),
  ).toBe("http://localhost:5173/settings?tab=one#section");
});
it("leaves directly reachable websites unchanged", () => {
  const url = phoneBrowserTargetUrl({ kind: "url", url: "https://example.com/page" });
  expect(url).toBe("https://example.com/page");
  expect(phoneBrowserShareRequired(environmentId, url)).toBe(false);
});
it("requires a capable environment before any phone localhost share is requested", () => {
  expect(() => phoneBrowserShareRequired(environmentId, "localhost:5173")).toThrow(
    "Update this environment",
  );
  state.capable = true;
  expect(phoneBrowserShareRequired(environmentId, "localhost:5173")).toBe(true);
  expect(phoneBrowserShareRequired(environmentId, "http://127.0.0.1:5173/")).toBe(true);
  expect(phoneBrowserShareRequired(environmentId, "http://[::1]:5173/")).toBe(true);
});
