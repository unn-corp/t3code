import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, OPENWHISPR_TIMEOUT_MS } from "@t3tools/contracts";
import { OpenWhisprVoiceInput, type VoiceInputPhase } from "./OpenWhisprVoiceInput";

const { microphone, convert, transcribe, toast } = vi.hoisted(() => ({
  microphone: vi.fn(),
  convert: vi.fn(),
  transcribe: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("~/lib/dictationMicrophone", () => ({ requestDictationMicrophone: microphone }));
vi.mock("~/lib/openwhisprTranscription", () => ({
  convertRecordedAudioToWav: convert,
  transcribeWithOpenWhispr: transcribe,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));
vi.mock("./ComposerControl", () => ({
  ComposerControl: (props: React.ComponentProps<"button">) => <button {...props} />,
}));

class Recorder extends EventTarget {
  static instances: Recorder[] = [];
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm";
  constructor(readonly stream: MediaStream) {
    super();
    Recorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["recorded"]) }));
    this.dispatchEvent(new Event("stop"));
  }
}
class Audio {
  static instances: Audio[] = [];
  currentTime = 0;
  destination = {};
  state = "running";
  close = vi.fn(async () => {
    this.state = "closed";
  });
  resume = vi.fn().mockResolvedValue(undefined);
  constructor() {
    Audio.instances.push(this);
  }
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createAnalyser() {
    return { disconnect: vi.fn(), fftSize: 0, smoothingTimeConstant: 0 };
  }
  createOscillator() {
    return {
      type: "",
      frequency: { setValueAtTime: vi.fn() },
      connect: () => ({ connect: vi.fn() }),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
    };
  }
  createGain() {
    return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } };
  }
}
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let renderer: ReactTestRenderer;
let stopTrack: ReturnType<typeof vi.fn>;
let stream: MediaStream;
let onTranscript: ReturnType<typeof vi.fn<(transcript: string) => void>>;
let onPhaseChange: ReturnType<typeof vi.fn<(phase: VoiceInputPhase) => void>>;
const environmentId = EnvironmentId.make("selected-server");
const button = () => renderer.root.findByType("button");
const click = async () =>
  act(async () => {
    button().props.onClick();
  });

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("AudioContext", Audio);
  Recorder.instances = [];
  Audio.instances = [];
  stopTrack = vi.fn();
  stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  microphone.mockReset().mockResolvedValue({ stream, usedSystemDefaultFallback: false });
  convert.mockReset().mockResolvedValue(new Blob(["wav"]));
  transcribe.mockReset().mockResolvedValue("hello");
  toast.mockReset();
  onTranscript = vi.fn();
  onPhaseChange = vi.fn();
  await act(async () => {
    renderer = create(
      <OpenWhisprVoiceInput
        environmentId={environmentId}
        phase="idle"
        disabled={false}
        onTranscript={onTranscript}
        onPhaseChange={onPhaseChange}
        onRecordingAudioSourceChange={() => {}}
        simulateInputLevel={false}
        dictationMicrophoneDeviceId="default"
        dictationStartKeybinds={[]}
        dictationEndKeybinds={[]}
      />,
    );
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("allows only one microphone request for repeated taps before render", async () => {
  const pending = deferred<{ stream: MediaStream; usedSystemDefaultFallback: boolean }>();
  microphone.mockReturnValue(pending.promise);
  const handler = button().props.onClick;
  await act(async () => {
    handler();
    handler();
  });
  expect(microphone).toHaveBeenCalledOnce();
  await act(async () => pending.resolve({ stream, usedSystemDefaultFallback: false }));
  expect(Recorder.instances).toHaveLength(1);
  expect(Recorder.instances[0]?.state).toBe("recording");
});
it("stops a microphone granted after unmount without recording", async () => {
  const pending = deferred<{ stream: MediaStream; usedSystemDefaultFallback: boolean }>();
  microphone.mockReturnValue(pending.promise);
  await click();
  act(() => renderer.unmount());
  expect(Audio.instances[0]?.close).toHaveBeenCalledOnce();
  await act(async () => pending.resolve({ stream, usedSystemDefaultFallback: false }));
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(Recorder.instances).toHaveLength(0);
  expect(Audio.instances[0]?.close).toHaveBeenCalledOnce();
  expect(onPhaseChange).not.toHaveBeenCalledWith("recording");
});
it("cancels pending microphone startup and discards a late grant", async () => {
  const pending = deferred<{ stream: MediaStream; usedSystemDefaultFallback: boolean }>();
  microphone.mockReturnValue(pending.promise);
  await click();
  await click();
  await act(async () => pending.resolve({ stream, usedSystemDefaultFallback: false }));
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(Recorder.instances).toHaveLength(0);
  expect(onPhaseChange).toHaveBeenLastCalledWith("idle");
});
it("transcribes on the selected server and releases the microphone", async () => {
  await click();
  await click();
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(transcribe).toHaveBeenCalledWith(environmentId, expect.any(Blob), expect.any(AbortSignal));
  expect(onTranscript).toHaveBeenCalledWith("hello");
  expect(onPhaseChange).toHaveBeenLastCalledWith("success");
});
it("cancels transcription without applying a late response", async () => {
  const pending = deferred<string>();
  transcribe.mockReturnValue(pending.promise);
  await click();
  await click();
  const signal = transcribe.mock.calls[0]![2] as AbortSignal;
  await click();
  expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve("late transcript"));
  expect(onTranscript).not.toHaveBeenCalled();
  expect(onPhaseChange).toHaveBeenLastCalledWith("idle");
});
it("cancels audio conversion before any upload starts", async () => {
  const pending = deferred<Blob>();
  convert.mockReturnValue(pending.promise);
  await click();
  await click();
  await click();
  await act(async () => pending.resolve(new Blob(["wav"])));
  expect(transcribe).not.toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
});
it("times out stalled audio conversion and lets the user record again", async () => {
  const pending = deferred<Blob>();
  convert.mockReturnValue(pending.promise);
  await click();
  await click();
  await act(async () => vi.advanceTimersByTime(OPENWHISPR_TIMEOUT_MS + 5_000));
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "OpenWhispr transcription timed out" }),
  );
  await click();
  expect(microphone).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve(new Blob(["late wav"])));
  expect(transcribe).not.toHaveBeenCalled();
});
it("recovers from denied microphone permission", async () => {
  microphone.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  await click();
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Microphone permission was denied" }),
  );
  await click();
  expect(Recorder.instances[0]?.state).toBe("recording");
});
it("does not transcribe after a recorder error also fires stop", async () => {
  await click();
  await act(async () => Recorder.instances[0]!.dispatchEvent(new Event("error")));
  expect(convert).not.toHaveBeenCalled();
  expect(onPhaseChange).toHaveBeenLastCalledWith("idle");
});

it("pairs recording start and end keybinds when leaving the composer", async () => {
  const sendKeybinding = vi.fn().mockResolvedValue(true);
  Object.assign(window, { desktopBridge: { sendKeybinding } });
  const props = renderer.root.findByType(OpenWhisprVoiceInput).props as React.ComponentProps<
    typeof OpenWhisprVoiceInput
  >;
  await act(async () =>
    renderer.update(
      <OpenWhisprVoiceInput
        {...props}
        dictationStartKeybinds={["Ctrl+Shift+A"]}
        dictationEndKeybinds={["Ctrl+Shift+B"]}
      />,
    ),
  );
  await click();
  act(() => renderer.unmount());
  expect(sendKeybinding.mock.calls.map(([keybinding]) => keybinding)).toEqual([
    "Ctrl+Shift+A",
    "Ctrl+Shift+B",
  ]);
  Reflect.deleteProperty(window, "desktopBridge");
});
