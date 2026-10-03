import { expect, it } from "vite-plus/test";
import { ProjectId } from "@t3tools/contracts";
import type { LocalTeamFilesResult } from "@t3tools/contracts/teamFiles";
import { awaitTeamProjectReceipt } from "./teamProjectActions.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("returns only the real created/linked project after its checkout receipt", async () => {
  const entered = deferred<void>();
  const receipt = deferred<LocalTeamFilesResult>();
  let completed = false;
  const action = awaitTeamProjectReceipt({
    generation: "account-one",
    isCurrent: () => true,
    currentGeneration: async () => "account-one",
    execute: () => {
      entered.resolve();
      return receipt.promise;
    },
  }).then((projectId) => {
    completed = true;
    return projectId;
  });
  await entered.promise;
  expect(completed).toBe(false);
  const projectId = ProjectId.make("existing-row-preserved");
  receipt.resolve({ projectId, status: "disabled", policy: "tracked-and-explicitly-included" });
  expect(await action).toBe(projectId);
});
it.each(["account", "environment"] as const)(
  "discards a completed checkout after the captured %s changes",
  async (change) => {
    const entered = deferred<void>();
    const receipt = deferred<LocalTeamFilesResult>();
    let generation = "one";
    let current = true;
    const action = awaitTeamProjectReceipt({
      generation,
      isCurrent: () => current,
      currentGeneration: async () => generation,
      execute: () => {
        entered.resolve();
        return receipt.promise;
      },
    });
    await entered.promise;
    if (change === "account") generation = "two";
    else current = false;
    receipt.resolve({
      projectId: ProjectId.make("stale"),
      status: "disabled",
      policy: "tracked-and-explicitly-included",
    });
    expect(await action).toBeNull();
  },
);
it("does not execute with a stale account and reports a missing creation receipt", async () => {
  let calls = 0;
  expect(
    await awaitTeamProjectReceipt({
      generation: "one",
      isCurrent: () => true,
      currentGeneration: async () => "two",
      execute: async () => {
        calls++;
        return { status: "disabled", policy: "tracked-and-explicitly-included" };
      },
    }),
  ).toBeNull();
  expect(calls).toBe(0);
  await expect(
    awaitTeamProjectReceipt({
      generation: "one",
      isCurrent: () => true,
      currentGeneration: async () => "one",
      execute: async () => ({ status: "disabled", policy: "tracked-and-explicitly-included" }),
    }),
  ).rejects.toThrow("not finished linking");
});
