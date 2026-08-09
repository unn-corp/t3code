const OPENWHISPR_WHISPER_URL = "http://127.0.0.1:8178/inference";

type WhisperJsonResponse = {
  readonly text?: unknown;
};

function isWhisperJsonResponse(value: unknown): value is WhisperJsonResponse {
  return typeof value === "object" && value !== null && "text" in value;
}

/** Transcribe audio through the user's local OpenWhispr whisper.cpp service. */
export async function transcribeWithOpenWhispr(audio: Blob, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("file", audio, "t3-voice.wav");
  form.append("response_format", "json");

  const response = await fetch(OPENWHISPR_WHISPER_URL, {
    method: "POST",
    body: form,
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`OpenWhispr returned HTTP ${response.status}.`);
  }

  const payload: unknown = await response.json();
  if (!isWhisperJsonResponse(payload) || typeof payload.text !== "string") {
    throw new Error("OpenWhispr returned an invalid transcription response.");
  }

  const transcript = payload.text.trim();
  return transcript === "[BLANK_AUDIO]" ? "" : transcript;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

/** Convert MediaRecorder output into the WAV format accepted by whisper.cpp. */
export async function convertRecordedAudioToWav(audio: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await audio.arrayBuffer());
    const frameCount = decoded.length;
    const wav = new ArrayBuffer(44 + frameCount * 2);
    const view = new DataView(wav);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + frameCount * 2, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, decoded.sampleRate, true);
    view.setUint32(28, decoded.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, frameCount * 2, true);

    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) =>
      decoded.getChannelData(index),
    );
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sample =
        channels.reduce((sum, channel) => sum + (channel[frame] ?? 0), 0) / channels.length;
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + frame * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    }
    return new Blob([wav], { type: "audio/wav" });
  } finally {
    await context.close();
  }
}
