// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { AndroidUpdateStatus } from "./updates";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_ANDROID_PWA", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  delete window.t3Updates;
});

const status = (over: Partial<AndroidUpdateStatus> = {}): AndroidUpdateStatus => ({
  protocol: 1,
  supported: true,
  unsupportedReason: null,
  phase: "waiting",
  current: {
    version: "1.0.0",
    commit: "a".repeat(40),
    versionCode: 100,
    channel: "nightly",
    artifactSha256: "b".repeat(64),
    installationSequence: 3,
  },
  policy: { channel: "nightly", automaticInstallation: true, pin: null },
  target: {
    version: "1.0.1",
    commit: "c".repeat(40),
    versionCode: 102,
    channel: "nightly",
    artifactSha256: "d".repeat(64),
  },
  blockers: [
    {
      reason: "idle-window",
      label: "Waiting for the app to stay in the background for 2 minutes.",
    },
    { reason: "uploads", label: "A file upload is in progress." },
  ],
  recovery: {
    ready: true,
    cached: [
      {
        versionCode: 103,
        version: "1.0.0",
        commit: "a".repeat(40),
        channel: "stable",
        sha256: "e".repeat(64),
        transactionId: "recovery-100-eeeeeeeeeeeeeeee",
      },
    ],
  },
  installPermission: "granted",
  silentInstall: false,
  lastCheckedAt: null,
  lastError: null,
  transactionId: null,
  confirmationPending: false,
  installRequest: null,
  ...over,
});

function native() {
  const sent: { id: string; action: string; payload?: unknown }[] = [];
  window.t3Updates = { postMessage: (raw) => sent.push(JSON.parse(raw)), onmessage: null };
  return {
    sent,
    reply: (id: string, result: unknown) =>
      window.t3Updates?.onmessage?.({ data: JSON.stringify({ id, result }) }),
    event: (event: unknown) => window.t3Updates?.onmessage?.({ data: JSON.stringify({ event }) }),
  };
}

it("matches concurrent replies to their requests and ignores unrelated messages", async () => {
  const bridge = native();
  const { getAndroidUpdateStatus, configureAndroidUpdates } = await import("./updates");
  const first = getAndroidUpdateStatus();
  const second = configureAndroidUpdates({ channel: "stable" });
  window.t3Updates?.onmessage?.({ data: "not json" });
  bridge.reply("unrelated", status());
  bridge.reply(bridge.sent[1]!.id, status({ phase: "idle" }));
  bridge.reply(bridge.sent[0]!.id, status());
  await expect(first).resolves.toMatchObject({ phase: "waiting" });
  await expect(second).resolves.toMatchObject({ phase: "idle" });
  expect(bridge.sent[1]).toMatchObject({ action: "configure", payload: { channel: "stable" } });
});

it("propagates native refusals", async () => {
  const bridge = native();
  const { installAndroidUpdate } = await import("./updates");
  const promise = installAndroidUpdate("d".repeat(64));
  window.t3Updates?.onmessage?.({
    data: JSON.stringify({ id: bridge.sent[0]!.id, error: "A phone browser command is running." }),
  });
  await expect(promise).rejects.toThrow("browser command");
});

it("delivers pushed status events to subscribers until they unsubscribe", async () => {
  const bridge = native();
  const { subscribeAndroidUpdates } = await import("./updates");
  const seen: string[] = [];
  const unsubscribe = subscribeAndroidUpdates((next) => seen.push(next.phase));
  bridge.event(status({ phase: "installing" }));
  unsubscribe();
  bridge.event(status({ phase: "completed" }));
  expect(seen).toEqual(["installing"]);
});

it("times out a lost reply and ignores its late arrival", async () => {
  vi.useFakeTimers();
  const bridge = native();
  const { checkAndroidUpdates } = await import("./updates");
  const promise = checkAndroidUpdates();
  const failure = expect(promise).rejects.toThrow("did not respond");
  await vi.advanceTimersByTimeAsync(120_000);
  await failure;
  bridge.reply(bridge.sent[0]!.id, status());
});

it("is unavailable outside the Android app even if a bridge object exists", async () => {
  native();
  vi.stubEnv("VITE_ANDROID_PWA", "0");
  const { androidUpdateRequest, supportsAndroidUpdates, beginAndroidUpload } =
    await import("./updates");
  expect(supportsAndroidUpdates()).toBe(false);
  await expect(androidUpdateRequest("check")).rejects.toThrow("unavailable");
  expect(await beginAndroidUpload()).toBeTypeOf("function");
});

it("holds installation for in-flight uploads and renews the lease until the last one ends", async () => {
  vi.useFakeTimers();
  const bridge = native();
  const { beginAndroidUpload, UPLOAD_HEARTBEAT_MS } = await import("./updates");
  const counts = () =>
    bridge.sent
      .filter((m) => m.action === "operations")
      .map((m) => (m.payload as { uploads: number }).uploads);
  const first = beginAndroidUpload();
  const second = beginAndroidUpload();
  bridge.reply(bridge.sent[0]!.id, status());
  bridge.reply(bridge.sent[1]!.id, status());
  const finishFirst = await first;
  const finishSecond = await second;
  expect(counts()).toEqual([1, 2]);
  await vi.advanceTimersByTimeAsync(UPLOAD_HEARTBEAT_MS);
  expect(counts().at(-1)).toBe(2);
  finishFirst();
  finishFirst();
  expect(counts().at(-1)).toBe(1);
  finishSecond();
  expect(counts().at(-1)).toBe(0);
  const settled = bridge.sent.length;
  await vi.advanceTimersByTimeAsync(UPLOAD_HEARTBEAT_MS * 3);
  expect(bridge.sent.length).toBe(settled);
});

it("maps native state into the shared maintenance status", async () => {
  const { toForkUpdateStatus, ANDROID_UPDATER_COORDINATOR_ID } = await import("./updates");
  const mapped = toForkUpdateStatus(
    status({
      current: {
        ...status().current,
        upstreamVersion: "0.0.45",
        upstreamCommit: "f".repeat(40),
        forkBuildNumber: 35,
      },
      policy: {
        channel: "stable",
        automaticInstallation: false,
        pin: {
          versionCode: 103,
          version: "1.0.0",
          commit: "a".repeat(40),
          reason: "rollback",
          artifactSha256: "e".repeat(64),
        },
      },
    }),
  );
  expect(mapped).toMatchObject({
    coordinatorId: ANDROID_UPDATER_COORDINATOR_ID,
    phase: "waiting",
    policy: { channel: "stable", automaticInstallation: false, pinnedBuild: "e".repeat(64) },
    currentBuild: {
      version: "1.0.0",
      installationSequence: 3,
      upstreamVersion: "0.0.45",
      upstreamCommit: "f".repeat(40),
      forkBuildNumber: 35,
    },
    targetBuild: { version: "1.0.1", commit: "c".repeat(40) },
    automationReviewRequired: false,
  });
  expect(mapped.blockers.map((b) => b.reason)).toEqual(["idle-window", "uploads"]);
  expect(mapped.recoveryOptions).toHaveLength(1);
  expect(mapped.recoveryOptions[0]).toMatchObject({
    id: "e".repeat(64),
    transactionId: "recovery-100-eeeeeeeeeeeeeeee",
    requiresDataRestore: false,
    build: { artifactSha256: "e".repeat(64), channel: "stable" },
  });
});

it("preserves the native storage blocker in the shared status", async () => {
  const { toForkUpdateStatus } = await import("./updates");
  const mapped = toForkUpdateStatus(
    status({
      blockers: [{ reason: "storage", label: "Not enough free storage; free space and retry." }],
    }),
  );
  expect(mapped.blockers).toEqual([
    {
      participantId: "android-phone",
      reason: "storage",
      label: "Not enough free storage; free space and retry.",
    },
  ]);
});

it("binds Install to the reviewed digest and Recovery to the recorded option", async () => {
  const bridge = native();
  const {
    installAndroidUpdate,
    requestAndroidRecovery,
    cancelAndroidInstallRequest,
    openAndroidRecovery,
  } = await import("./updates");
  const requests = [
    installAndroidUpdate("d".repeat(64)),
    requestAndroidRecovery("e".repeat(64), "recovery-100-eeeeeeeeeeeeeeee"),
    cancelAndroidInstallRequest(),
    openAndroidRecovery(),
  ];
  expect(bridge.sent.map(({ action, payload }) => ({ action, payload }))).toEqual([
    { action: "install", payload: { action: "install", targetArtifactSha256: "d".repeat(64) } },
    {
      action: "recovery",
      payload: { optionId: "e".repeat(64), transactionId: "recovery-100-eeeeeeeeeeeeeeee" },
    },
    { action: "cancel", payload: {} },
    { action: "openRecovery", payload: {} },
  ]);
  for (const request of bridge.sent) bridge.reply(request.id, status({ phase: "waiting" }));
  await expect(Promise.all(requests)).resolves.toHaveLength(4);
});

it("keeps an upload hold across any number of missed heartbeat replies", async () => {
  vi.useFakeTimers();
  const bridge = native();
  const { beginAndroidUpload, UPLOAD_HEARTBEAT_MS } = await import("./updates");
  const hold = beginAndroidUpload();
  bridge.reply(bridge.sent[0]!.id, status());
  const release = await hold;
  const sentBefore = bridge.sent.length;
  await vi.advanceTimersByTimeAsync(UPLOAD_HEARTBEAT_MS * 10);
  const heartbeats = bridge.sent
    .slice(sentBefore)
    .map((m) => (m.payload as { uploads: number }).uploads);
  expect(heartbeats.length).toBeGreaterThan(0);
  expect(heartbeats.every((uploads) => uploads === 1)).toBe(true);
  release();
  expect((bridge.sent.at(-1)!.payload as { uploads: number }).uploads).toBe(0);
});

it("does not admit an upload when native installation has fenced new work", async () => {
  const bridge = native();
  const { beginAndroidUpload } = await import("./updates");
  const hold = beginAndroidUpload();
  const rejected = expect(hold).rejects.toThrow("installation is in progress");
  window.t3Updates?.onmessage?.({
    data: JSON.stringify({ id: bridge.sent[0]!.id, error: "An app installation is in progress." }),
  });
  await rejected;
  expect((bridge.sent.at(-1)!.payload as { uploads: number }).uploads).toBe(0);
});
