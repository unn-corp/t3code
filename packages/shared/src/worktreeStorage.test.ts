import { describe, expect, it } from "@effect/vitest";
import { worktreeStorageUnavailableReason } from "./worktreeStorage.ts";

describe("worktree storage compatibility", () => {
  it("requires every selected server to advertise support", () => {
    expect(worktreeStorageUnavailableReason([{ supported: true, reason: null }])).toBeNull();
    expect(
      worktreeStorageUnavailableReason([
        { supported: true, reason: null },
        { supported: false, reason: "Filesystem does not support reflinks." },
      ]),
    ).toBe("Filesystem does not support reflinks.");
    expect(worktreeStorageUnavailableReason([undefined])).toContain("Update");
    expect(worktreeStorageUnavailableReason([])).toContain("Connect");
  });
});
