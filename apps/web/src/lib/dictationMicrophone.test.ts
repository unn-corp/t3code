import { describe, expect, it, vi } from "vite-plus/test";
import { requestDictationMicrophone } from "./dictationMicrophone";

describe("requestDictationMicrophone", () => {
  it("requests the selected microphone by exact device id", async () => {
    const stream = {} as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);

    await expect(requestDictationMicrophone({ getUserMedia }, "studio-mic")).resolves.toEqual({
      stream,
      usedSystemDefaultFallback: false,
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "studio-mic" } },
    });
  });

  it("falls back to the system default when the selected microphone disappears", async () => {
    const stream = {} as MediaStream;
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Missing device", "OverconstrainedError"))
      .mockResolvedValueOnce(stream);

    await expect(requestDictationMicrophone({ getUserMedia }, "unplugged-mic")).resolves.toEqual({
      stream,
      usedSystemDefaultFallback: true,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: { deviceId: { exact: "unplugged-mic" } },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: true });
  });

  it("does not hide permission failures behind a fallback request", async () => {
    const permissionError = new DOMException("Denied", "NotAllowedError");
    const getUserMedia = vi.fn().mockRejectedValue(permissionError);

    await expect(requestDictationMicrophone({ getUserMedia }, "studio-mic")).rejects.toBe(
      permissionError,
    );
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
