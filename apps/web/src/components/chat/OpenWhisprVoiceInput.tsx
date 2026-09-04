import { useCallback, useEffect, useRef, useState } from "react";
import { requestDictationMicrophone } from "~/lib/dictationMicrophone";
import { convertRecordedAudioToWav, transcribeWithOpenWhispr } from "~/lib/openwhisprTranscription";
import { toastManager } from "../ui/toast";
import { ComposerControl } from "./ComposerControl";
import type { VoiceInputAudioSource } from "./VoiceInputWaveform";
import type { ClientSettings } from "@t3tools/contracts/settings";

export type VoiceInputPhase = "idle" | "recording" | "transcribing" | "success" | "no-audio";

type VoiceInputState =
  | { readonly status: "idle" }
  | { readonly status: "recording" }
  | { readonly status: "transcribing" };

interface OpenWhisprVoiceInputProps {
  phase: VoiceInputPhase;
  disabled: boolean;
  onTranscript: (transcript: string) => void;
  onPhaseChange: (phase: VoiceInputPhase) => void;
  onRecordingAudioSourceChange: (source: VoiceInputAudioSource | null) => void;
  simulateInputLevel: boolean;
  dictationMicrophoneDeviceId: ClientSettings["dictationMicrophoneDeviceId"];
  dictationStartKeybinds: ClientSettings["dictationStartKeybinds"];
  dictationEndKeybinds: ClientSettings["dictationEndKeybinds"];
}

function playDictationTone(kind: "start" | "end"): void {
  if (typeof AudioContext === "undefined") return;
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(kind === "start" ? 660 : 440, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.045, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.13);
  oscillator.addEventListener("ended", () => void context.close(), { once: true });
}

function fireDictationKeybinds(keybinds: readonly string[]): void {
  for (const keybinding of keybinds) {
    void window.desktopBridge?.sendKeybinding(keybinding).catch(() => false);
  }
}

function mediaRecordingIsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia !== undefined &&
    typeof MediaRecorder !== "undefined" &&
    typeof AudioContext !== "undefined"
  );
}

export function OpenWhisprVoiceInput({
  phase,
  disabled,
  onTranscript,
  onPhaseChange,
  onRecordingAudioSourceChange,
  simulateInputLevel,
  dictationMicrophoneDeviceId,
  dictationStartKeybinds,
  dictationEndKeybinds,
}: OpenWhisprVoiceInputProps) {
  const [state, setState] = useState<VoiceInputState>({ status: "idle" });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingAudioContextRef = useRef<AudioContext | null>(null);
  const recordingAudioInputRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recordingAudioAnalyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const simulatedRecordingRef = useRef(false);
  const phaseResetTimerRef = useRef<number | null>(null);
  const available = mediaRecordingIsAvailable();
  const releaseRecordingAudioSource = useCallback(() => {
    const audioContext = recordingAudioContextRef.current;
    recordingAudioContextRef.current = null;
    recordingAudioInputRef.current?.disconnect();
    recordingAudioInputRef.current = null;
    recordingAudioAnalyserRef.current?.disconnect();
    recordingAudioAnalyserRef.current = null;
    onRecordingAudioSourceChange(null);
    if (audioContext) void audioContext.close();
  }, [onRecordingAudioSourceChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (phaseResetTimerRef.current !== null) {
        window.clearTimeout(phaseResetTimerRef.current);
      }
      recorderRef.current?.stop();
      simulatedRecordingRef.current = false;
      abortControllerRef.current?.abort();
      releaseRecordingAudioSource();
    };
  }, [releaseRecordingAudioSource]);

  const stopRecording = useCallback(() => {
    if (simulatedRecordingRef.current) {
      simulatedRecordingRef.current = false;
      playDictationTone("end");
      setState({ status: "transcribing" });
      onPhaseChange("transcribing");
      phaseResetTimerRef.current = window.setTimeout(() => {
        phaseResetTimerRef.current = null;
        if (!mountedRef.current) return;
        setState({ status: "idle" });
        onPhaseChange("success");
        phaseResetTimerRef.current = window.setTimeout(() => {
          phaseResetTimerRef.current = null;
          if (mountedRef.current) onPhaseChange("idle");
        }, 1200);
      }, 900);
      return;
    }
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  }, [onPhaseChange]);

  const startRecording = useCallback(async () => {
    if (phaseResetTimerRef.current !== null) {
      window.clearTimeout(phaseResetTimerRef.current);
      phaseResetTimerRef.current = null;
    }
    if (simulateInputLevel) {
      simulatedRecordingRef.current = true;
      setState({ status: "recording" });
      onRecordingAudioSourceChange(null);
      onPhaseChange("recording");
      playDictationTone("start");
      return;
    }
    if (!available) {
      toastManager.add({
        type: "error",
        title: "Microphone recording is unavailable",
        description: "Use a browser with microphone access to dictate into T3.",
      });
      return;
    }

    let requestedStream: MediaStream | null = null;
    let requestedAudioContext: AudioContext | null = null;
    try {
      requestedAudioContext = new AudioContext();
      await requestedAudioContext.resume();
      const microphone = await requestDictationMicrophone(
        navigator.mediaDevices,
        dictationMicrophoneDeviceId,
      );
      const stream = microphone.stream;
      if (microphone.usedSystemDefaultFallback) {
        toastManager.add({
          type: "warning",
          title: "Selected microphone is unavailable",
          description: "T3 is using the system default microphone for this recording.",
        });
      }
      requestedStream = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorderRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("error", () => {
        for (const track of stream.getTracks()) track.stop();
        recorderRef.current = null;
        releaseRecordingAudioSource();
        playDictationTone("end");
        fireDictationKeybinds(dictationEndKeybinds);
        if (mountedRef.current) {
          setState({ status: "idle" });
          onPhaseChange("idle");
          toastManager.add({
            type: "error",
            title: "Could not record microphone audio",
          });
        }
      });
      recorder.addEventListener("stop", () => {
        for (const track of stream.getTracks()) track.stop();
        recorderRef.current = null;
        releaseRecordingAudioSource();
        const audio = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        playDictationTone("end");
        fireDictationKeybinds(dictationEndKeybinds);
        if (!mountedRef.current) return;
        setState({ status: "transcribing" });
        onPhaseChange("transcribing");
        const abortController = new AbortController();
        abortControllerRef.current = abortController;
        void convertRecordedAudioToWav(audio)
          .then((wav) => transcribeWithOpenWhispr(wav, abortController.signal))
          .then((transcript) => {
            if (!mountedRef.current) return;
            if (transcript.length > 0) {
              onTranscript(transcript);
              onPhaseChange("success");
              phaseResetTimerRef.current = window.setTimeout(() => {
                phaseResetTimerRef.current = null;
                if (mountedRef.current) onPhaseChange("idle");
              }, 1200);
            } else {
              onPhaseChange("no-audio");
              phaseResetTimerRef.current = window.setTimeout(() => {
                phaseResetTimerRef.current = null;
                if (mountedRef.current) onPhaseChange("idle");
              }, 2200);
            }
            setState({ status: "idle" });
          })
          .catch((error: unknown) => {
            if (!mountedRef.current || abortController.signal.aborted) return;
            setState({ status: "idle" });
            onPhaseChange("idle");
            toastManager.add({
              type: "error",
              title: "OpenWhispr transcription failed",
              description: error instanceof Error ? error.message : "Try again.",
            });
          })
          .finally(() => {
            if (abortControllerRef.current === abortController) {
              abortControllerRef.current = null;
            }
          });
      });
      const audioInput = requestedAudioContext.createMediaStreamSource(stream);
      const analyser = requestedAudioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.68;
      audioInput.connect(analyser);
      recordingAudioContextRef.current = requestedAudioContext;
      recordingAudioInputRef.current = audioInput;
      recordingAudioAnalyserRef.current = analyser;
      recorder.start();
      setState({ status: "recording" });
      onRecordingAudioSourceChange({ analyser });
      onPhaseChange("recording");
      playDictationTone("start");
      fireDictationKeybinds(dictationStartKeybinds);
    } catch (error: unknown) {
      for (const track of requestedStream?.getTracks() ?? []) track.stop();
      recorderRef.current = null;
      if (recordingAudioContextRef.current === requestedAudioContext) {
        releaseRecordingAudioSource();
      } else if (requestedAudioContext) {
        void requestedAudioContext.close();
      }
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        toastManager.add({
          type: "error",
          title: "Microphone permission was denied",
          description:
            "Allow microphone access in your browser or desktop settings, then try again.",
        });
      } else {
        toastManager.add({
          type: "error",
          title: "Could not start microphone recording",
          description: error instanceof Error ? error.message : "Try again.",
        });
      }
    }
  }, [
    available,
    dictationEndKeybinds,
    dictationMicrophoneDeviceId,
    dictationStartKeybinds,
    onPhaseChange,
    onRecordingAudioSourceChange,
    onTranscript,
    releaseRecordingAudioSource,
    simulateInputLevel,
  ]);

  const isRecording = state.status === "recording";
  const isTranscribing = state.status === "transcribing";
  const label =
    phase === "recording"
      ? "Stop voice input"
      : phase === "transcribing"
        ? "Transcribing with OpenWhispr"
        : phase === "success"
          ? "Transcription complete"
          : phase === "no-audio"
            ? "No audio detected. Retry voice input"
            : simulateInputLevel
              ? "Preview simulated microphone"
              : "Dictate with OpenWhispr";

  return (
    <ComposerControl
      type="button"
      size="sm"
      variant="ghost"
      className="chat-voice-control size-14 overflow-visible rounded-full"
      disabled={
        disabled || isTranscribing || phase === "success" || (!available && !simulateInputLevel)
      }
      aria-label={label}
      title={label}
      onClick={isRecording ? stopRecording : startRecording}
      data-openwhispr-voice-input="true"
    >
      <svg className="chat-voice-mic-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Zm-7 9v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
      </svg>
      <svg className="chat-voice-stop-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
      </svg>
      <svg className="chat-voice-spinner-mark" viewBox="0 0 88 88" aria-hidden="true">
        <g className="chat-voice-spinner-wave">
          <path
            className="chat-voice-spinner-wave-ring"
            d="M44 17 C45.17 17.7 46.21 18.7 47.25 19.33 C48.28 19.97 49.17 20.54 50.21 20.82 C51.26 21.1 52.31 21.05 53.52 21.02 C54.74 20.98 56.13 20.64 57.5 20.62 C58.87 20.6 60.44 20.53 61.73 20.9 C63.01 21.26 64.32 21.89 65.21 22.79 C66.11 23.68 66.74 24.99 67.1 26.27 C67.47 27.56 67.4 29.13 67.38 30.5 C67.36 31.87 67.02 33.26 66.98 34.48 C66.95 35.69 66.9 36.74 67.18 37.79 C67.46 38.83 68.03 39.72 68.67 40.75 C69.3 41.79 70.3 42.83 71 44 C71.7 45.17 72.54 46.51 72.87 47.8 C73.2 49.1 73.31 50.54 72.98 51.76 C72.65 52.99 71.84 54.19 70.9 55.14 C69.97 56.1 68.58 56.83 67.38 57.5 C66.19 58.17 64.81 58.57 63.74 59.15 C62.67 59.72 61.74 60.21 60.97 60.97 C60.21 61.74 59.72 62.67 59.15 63.74 C58.57 64.81 58.17 66.19 57.5 67.38 C56.83 68.58 56.1 69.97 55.14 70.9 C54.19 71.84 52.99 72.65 51.76 72.98 C50.54 73.31 49.1 73.2 47.8 72.87 C46.51 72.54 45.17 71.7 44 71 C42.83 70.3 41.79 69.3 40.75 68.67 C39.72 68.03 38.83 67.46 37.79 67.18 C36.74 66.9 35.69 66.95 34.48 66.98 C33.26 67.02 31.87 67.36 30.5 67.38 C29.13 67.4 27.56 67.47 26.27 67.1 C24.99 66.74 23.68 66.11 22.79 65.21 C21.89 64.32 21.26 63.01 20.9 61.73 C20.53 60.44 20.6 58.87 20.62 57.5 C20.64 56.13 20.98 54.74 21.02 53.52 C21.05 52.31 21.1 51.26 20.82 50.21 C20.54 49.17 19.97 48.28 19.33 47.25 C18.7 46.21 17.7 45.17 17 44 C16.3 42.83 15.46 41.49 15.13 40.2 C14.8 38.9 14.69 37.46 15.02 36.24 C15.35 35.01 16.16 33.81 17.1 32.86 C18.03 31.9 19.42 31.17 20.62 30.5 C21.81 29.83 23.19 29.43 24.26 28.85 C25.33 28.28 26.26 27.79 27.03 27.03 C27.79 26.26 28.28 25.33 28.85 24.26 C29.43 23.19 29.83 21.81 30.5 20.62 C31.17 19.42 31.9 18.03 32.86 17.1 C33.81 16.16 35.01 15.35 36.24 15.02 C37.46 14.69 38.9 14.8 40.2 15.13 C41.49 15.46 42.83 16.3 44 17 Z"
          />
        </g>
        <circle className="chat-voice-spinner-regular-ring" cx="44" cy="44" r="27" />
        <circle
          className="chat-voice-spinner-regular-orbit"
          cx="44"
          cy="44"
          r="27"
          pathLength="100"
        />
      </svg>
      <svg className="chat-voice-success-mark" viewBox="0 0 88 88" aria-hidden="true">
        <circle cx="44" cy="44" r="27" />
        <path d="M29 44.5 39.5 55 60 33" />
      </svg>
      <svg className="chat-voice-error-mark" viewBox="0 0 88 88" aria-hidden="true">
        <circle cx="44" cy="44" r="27" />
        <path d="M34 34 54 54" />
        <path d="M54 34 34 54" />
      </svg>
    </ComposerControl>
  );
}
