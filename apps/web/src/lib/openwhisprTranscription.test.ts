import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { transcribeWithOpenWhispr } from "./openwhisprTranscription";

const { prepared, execute, runtimeAtom } = vi.hoisted(() => ({
  prepared: vi.fn(),
  execute: vi.fn(),
  runtimeAtom: vi.fn((effect) => effect),
}));
vi.mock("../state/session", () => ({ readPreparedConnection: prepared }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: { atom: runtimeAtom } }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: execute,
  squashAtomCommandFailure: () => new Error("Transcription failed"),
}));
const environmentId = EnvironmentId.make("selected-server");
beforeEach(() => {
  prepared.mockReset().mockReturnValue({ environmentId });
  execute.mockReset().mockResolvedValue({ _tag: "Success", value: { text: "hello" } });
  runtimeAtom.mockClear();
});
describe("transcribeWithOpenWhispr", () => {
  it("requires the selected environment to be connected", async () => {
    prepared.mockReturnValue(null);
    await expect(transcribeWithOpenWhispr(environmentId, new Blob(["audio"]))).rejects.toThrow(
      "Connect to the T3 server",
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not upload an already cancelled recording", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      transcribeWithOpenWhispr(environmentId, new Blob(["audio"]), controller.signal),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("returns the environment transcription and passes cancellation to the runtime", async () => {
    const controller = new AbortController();
    await expect(
      transcribeWithOpenWhispr(environmentId, new Blob(["audio"]), controller.signal),
    ).resolves.toBe("hello");
    expect(prepared).toHaveBeenCalledWith(environmentId);
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
