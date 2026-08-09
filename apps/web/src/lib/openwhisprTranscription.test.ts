import { describe, expect, it, vi } from "vite-plus/test";
import { transcribeWithOpenWhispr } from "./openwhisprTranscription";

describe("transcribeWithOpenWhispr", () => {
  it("returns trimmed text from the local Whisper JSON response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ text: "  hello from voice  " }), { status: 200 }),
      );

    await expect(transcribeWithOpenWhispr(new Blob(["audio"]))).resolves.toBe("hello from voice");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8178/inference",
      expect.objectContaining({ method: "POST" }),
    );
    fetchMock.mockRestore();
  });

  it("reports a missing local service clearly", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));

    await expect(transcribeWithOpenWhispr(new Blob(["audio"]))).rejects.toThrow(
      "OpenWhispr returned HTTP 503.",
    );
    vi.restoreAllMocks();
  });

  it("turns Whisper blank-audio markers into a quiet no-op", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "[BLANK_AUDIO]" }), { status: 200 }),
    );

    await expect(transcribeWithOpenWhispr(new Blob(["audio"]))).resolves.toBe("");
    vi.restoreAllMocks();
  });
});
