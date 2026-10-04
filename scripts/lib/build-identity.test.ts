import * as NodeModule from "node:module";
import * as NodeCrypto from "node:crypto";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { fileHookTransform } = require("../../apps/mobile/fingerprint.config.js") as {
  fileHookTransform: (
    source: { type: "contents"; id: string },
    chunk: string,
    final: boolean,
    encoding: string,
  ) => string;
};
function fingerprint(config: unknown) {
  const contents = fileHookTransform(
    { type: "contents", id: "expoConfig" },
    JSON.stringify(config),
    true,
    "utf8",
  );
  return NodeCrypto.createHash("sha256").update(contents!).digest("hex");
}
it("keeps native compatibility stable when only fork diagnostic metadata changes", () => {
  const native = {
    android: { package: "com.t3tools.app" },
    extra: { relay: { url: "https://relay.example" } },
  };
  expect(fingerprint(native)).toBe(
    fingerprint({
      ...native,
      extra: {
        ...native.extra,
        buildIdentity: { commit: "first", dirty: true, builtAt: "first date" },
      },
    }),
  );
  expect(fingerprint(native)).toBe(
    fingerprint({
      ...native,
      extra: {
        ...native.extra,
        buildIdentity: { commit: "second", dirty: false, builtAt: "second date" },
      },
    }),
  );
  expect(fingerprint(native)).not.toBe(
    fingerprint({ ...native, android: { package: "com.t3tools.other" } }),
  );
  expect(fingerprint(native)).not.toBe(
    fingerprint({ ...native, extra: { relay: { url: "https://other.example" } } }),
  );
});
