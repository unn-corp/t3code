import type { EnvironmentId } from "@t3tools/contracts";
import { OpenWhisprLoader } from "@t3tools/client-runtime/state/openwhispr-http";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readPreparedConnection } from "../state/session";

/** Transcribe on the selected environment, using its cookie, bearer, or relay authorization. */
export async function transcribeWithOpenWhispr(
  environmentId: EnvironmentId | null,
  audio: Blob,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const prepared = environmentId === null ? null : readPreparedConnection(environmentId);
  if (!prepared) throw new Error("Connect to the Arcwright Code server before dictating.");
  const bytes = new Uint8Array(await audio.arrayBuffer());
  signal?.throwIfAborted();
  const atom = connectionAtomRuntime.atom(
    Effect.flatMap(OpenWhisprLoader, (loader) => loader.transcribe(prepared, bytes)),
  );
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    ...(signal ? { signal } : {}),
    reportFailure: false,
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value.text;
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
