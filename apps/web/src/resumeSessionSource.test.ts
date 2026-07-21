import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveResumeSessionSource } from "./resumeSessionSource";

const driver = (value: string) => ProviderDriverKind.make(value);
const instance = (value: string) => ProviderInstanceId.make(value);

describe("resolveResumeSessionSource", () => {
  it("follows the selected provider and its account", () => {
    expect(
      resolveResumeSessionSource({
        selectedProvider: driver("claudeAgent"),
        selectedProviderInstanceId: instance("claudeAgent_work"),
      }),
    ).toEqual({ driver: "claudeAgent", providerInstanceId: "claudeAgent_work" });
  });

  // Codex has no `providerInstances` entry on this machine, so the picker must
  // still resolve an instance rather than falling through to another driver.
  it("falls back to the driver's canonical instance id", () => {
    expect(
      resolveResumeSessionSource({
        selectedProvider: driver("codex"),
        selectedProviderInstanceId: null,
      }),
    ).toEqual({ driver: "codex", providerInstanceId: "codex" });
  });

  // The regression this exists to prevent: a thread bound to codex by an earlier
  // resume must not drag the picker away from the provider the user selected.
  it("ignores whatever the thread happens to be bound to", () => {
    const selection = {
      selectedProvider: driver("grok"),
      selectedProviderInstanceId: null,
    } as const;
    // Called twice, as before and after a resume binds a session; the binding is
    // not an input here, so the answer cannot drift.
    expect(resolveResumeSessionSource(selection)).toEqual(resolveResumeSessionSource(selection));
    expect(resolveResumeSessionSource(selection).driver).toBe("grok");
  });
});
