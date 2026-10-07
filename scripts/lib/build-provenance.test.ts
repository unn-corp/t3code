// @effect-diagnostics nodeBuiltinImport:off — fixtures exercise the synchronous build bootstrap without an Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, expect, it } from "vite-plus/test";
import { forkUpstreamIdentity } from "./build-identity.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});
function fixture(text?: string) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provenance-"));
  directories.push(dir);
  const file = NodePath.join(dir, "fork-upstream.json");
  if (text !== undefined) NodeFS.writeFileSync(file, text);
  return NodeURL.pathToFileURL(file);
}
it("records the included upstream source independently from installer versions", () => {
  expect(
    forkUpstreamIdentity(
      fixture(JSON.stringify({ upstreamVersion: "0.0.45", upstreamCommit: "a".repeat(40) })),
    ),
  ).toEqual({ upstreamVersion: "0.0.45", upstreamCommit: "a".repeat(40) });
});
it("leaves legacy provenance unknown rather than guessing from the latest upstream", () => {
  expect(forkUpstreamIdentity(fixture())).toEqual({});
});
it.each(["{}", "null", '{"upstreamVersion":"1.0-fake","upstreamCommit":"bad"}'])(
  "rejects malformed provenance %s",
  (text) => {
    expect(() => forkUpstreamIdentity(fixture(text))).toThrow("Invalid included upstream identity");
  },
);
