import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  beginUpload: vi.fn(),
  runCycle: vi.fn(),
  remove: vi.fn(),
  events: [] as string[],
}));

vi.mock("../state/updateInteraction", () => ({
  beginClientUpdateUpload: mocks.beginUpload,
}));
vi.mock("@t3tools/client-runtime/state/attachments", () => ({
  deletePendingAttachmentUpload: mocks.remove,
  runAttachmentUploadCycle: mocks.runCycle,
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/attachments", () => ({
  attachmentEnvironment: { createUploadUrl: Symbol("create-upload"), remove: Symbol("remove") },
}));
vi.mock("~/state/session", () => ({
  readPreparedConnection: () => ({ httpBaseUrl: "https://environment.test/" }),
}));

import { uploadBrowserRecording } from "./browserRecordingUpload";

const scope = { environmentId: "environment-1", threadId: "thread-1" } as never;
const artifact = {
  id: "recording-1",
  path: "/recordings/capture.webm",
  mimeType: "audio/webm",
} as never;

describe("uploadBrowserRecording", () => {
  beforeEach(() => {
    mocks.events.length = 0;
    mocks.beginUpload.mockReset();
    mocks.runCycle.mockReset();
    mocks.remove.mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  it("admits before the upload cycle starts and holds through its completion", async () => {
    mocks.beginUpload.mockImplementation(async () => {
      mocks.events.push("admitted");
      return () => mocks.events.push("released");
    });
    mocks.runCycle.mockImplementation(async () => {
      mocks.events.push("mint-and-transfer");
      return { status: "uploaded", attachmentId: "attachment-1" };
    });

    await expect(
      uploadBrowserRecording(scope, artifact, new Blob(["audio"]), Date.now() + 60_000),
    ).resolves.toBe("attachment-1");
    expect(mocks.events).toEqual(["admitted", "mint-and-transfer", "released"]);
  });

  it("does not mint an upload when admission is denied", async () => {
    mocks.beginUpload.mockRejectedValue(new Error("installation is in progress"));

    await expect(
      uploadBrowserRecording(scope, artifact, new Blob(["audio"]), Date.now() + 60_000),
    ).rejects.toThrow("installation is in progress");
    expect(mocks.runCycle).not.toHaveBeenCalled();
  });

  it("releases admission when the upload cycle fails", async () => {
    mocks.beginUpload.mockResolvedValue(() => mocks.events.push("released"));
    mocks.runCycle.mockRejectedValue(new Error("network failure"));

    await expect(
      uploadBrowserRecording(scope, artifact, new Blob(["audio"]), Date.now() + 60_000),
    ).rejects.toThrow("network failure");
    expect(mocks.events).toEqual(["released"]);
  });
});
