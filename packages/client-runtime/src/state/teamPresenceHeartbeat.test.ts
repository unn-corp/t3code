import { expect, it } from "vite-plus/test";
import { createTeamPresenceHeartbeat } from "./teamPresenceHeartbeat.ts";
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("reports failed presence separately and clears it on the next successful receipt", async () => {
  const statuses: Array<string | null> = [];
  let failure: string | null = "Presence connection unavailable";
  const reporter = createTeamPresenceHeartbeat({
    execute: async () => failure,
    report: (value) => statuses.push(value),
  });
  await reporter.send({ threadId: null, typing: false });
  failure = null;
  await reporter.send({ threadId: null, typing: false });
  expect(statuses).toEqual(["Presence connection unavailable", null]);
});
it("ignores out-of-order heartbeat failures and responses from a closed account/thread scope", async () => {
  const requests = [
    deferred<string | null>(),
    deferred<string | null>(),
    deferred<string | null>(),
  ];
  const statuses: Array<string | null> = [];
  let count = 0;
  const reporter = createTeamPresenceHeartbeat({
    execute: () => requests[count++]!.promise,
    report: (value) => statuses.push(value),
  });
  const stale = reporter.send({ threadId: null, typing: true });
  const latest = reporter.send({ threadId: null, typing: false });
  requests[1]!.resolve(null);
  await latest;
  requests[0]!.resolve("Late old failure");
  await stale;
  expect(statuses).toEqual([null]);
  const closing = reporter.send({ threadId: null, typing: true });
  reporter.close();
  requests[2]!.resolve("Old account failure");
  await closing;
  expect(statuses).toEqual([null]);
});
