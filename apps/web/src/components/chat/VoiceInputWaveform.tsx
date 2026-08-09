import { useId, useLayoutEffect, useRef } from "react";

const WAVE_LENGTH = 150;
const WAVE_SAMPLE_COUNT = 36;

export interface VoiceInputAudioSource {
  readonly analyser: AnalyserNode;
}

function roundPathValue(value: number): number {
  return Number(value.toFixed(2));
}

function simulatedSpeechLevel(timestamp: number): number {
  const phrase = Math.max(0, Math.sin(timestamp / 760) + 0.18);
  const syllables = 0.54 + 0.3 * Math.sin(timestamp / 92) + 0.16 * Math.sin(timestamp / 47);
  return Math.min(1, Math.max(0.025, phrase * syllables * 0.78));
}

function createTravelingWavePath({
  amplitude,
  cyclePhase,
  waveCenter,
  waveWidth,
}: {
  amplitude: number;
  cyclePhase: number;
  waveCenter: number;
  waveWidth: number;
}): string {
  const points = Array.from({ length: WAVE_SAMPLE_COUNT }, (_, index) => {
    const progress = index / (WAVE_SAMPLE_COUNT - 1);
    const x = waveWidth * progress;
    const envelope =
      index === 0 || index === WAVE_SAMPLE_COUNT - 1 ? 0 : Math.sin(Math.PI * progress) ** 0.34;
    const angle = Math.PI * 2 * (x / WAVE_LENGTH - cyclePhase);
    return [x, waveCenter - amplitude * envelope * Math.sin(angle)] as const;
  });

  const firstPoint = points[0];
  if (!firstPoint) return "";
  let path = `M${roundPathValue(firstPoint[0])} ${roundPathValue(firstPoint[1])}`;

  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const current = points[index];
    const next = points[index + 1];
    const afterNext = points[Math.min(points.length - 1, index + 2)];
    if (!previous || !current || !next || !afterNext) continue;

    const firstControl = [
      current[0] + (next[0] - previous[0]) / 6,
      current[1] + (next[1] - previous[1]) / 6,
    ] as const;
    const secondControl = [
      next[0] - (afterNext[0] - current[0]) / 6,
      next[1] - (afterNext[1] - current[1]) / 6,
    ] as const;

    path += ` C${roundPathValue(firstControl[0])} ${roundPathValue(firstControl[1])}`;
    path += ` ${roundPathValue(secondControl[0])} ${roundPathValue(secondControl[1])}`;
    path += ` ${roundPathValue(next[0])} ${roundPathValue(next[1])}`;
  }

  return path;
}

export function VoiceInputWaveform({
  audioSource: recordingAudioSource,
  simulateInputLevel,
}: {
  audioSource: VoiceInputAudioSource | null;
  simulateInputLevel: boolean;
}) {
  const waveformGradientId = `chat-voice-waveform-gradient-${useId().replaceAll(":", "")}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const primaryPathRef = useRef<SVGPathElement>(null);
  const secondaryPathRef = useRef<SVGPathElement>(null);
  const inputLevelRef = useRef(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const svg = svgRef.current;
    const primaryPath = primaryPathRef.current;
    const secondaryPath = secondaryPathRef.current;
    const entryArea = container?.parentElement;
    const voiceControl = entryArea?.querySelector<HTMLElement>(
      '[data-openwhispr-voice-input="true"]',
    );
    const spinnerMark = voiceControl?.querySelector<SVGSVGElement>(".chat-voice-spinner-mark");
    const regularSpinnerRing = voiceControl?.querySelector<SVGCircleElement>(
      ".chat-voice-spinner-regular-ring",
    );
    if (
      !container ||
      !svg ||
      !primaryPath ||
      !secondaryPath ||
      !entryArea ||
      !voiceControl ||
      !spinnerMark ||
      !regularSpinnerRing
    ) {
      return;
    }

    let waveWidth = 569.269;
    let waveCenter = 72.032;
    const analyser = recordingAudioSource?.analyser ?? null;
    let audioSamples: Uint8Array<ArrayBuffer> | null = null;

    if (analyser) audioSamples = new Uint8Array(analyser.fftSize);

    const syncWaveGeometry = () => {
      const screenMatrix = svg.getScreenCTM();
      if (!screenMatrix) return;

      const voiceControlBounds = voiceControl.getBoundingClientRect();
      const spinnerStyle = window.getComputedStyle(spinnerMark);
      const spinnerWidth = Number.parseFloat(spinnerStyle.width);
      const spinnerHeight = Number.parseFloat(spinnerStyle.height);
      const spinnerViewBox = spinnerMark.viewBox.baseVal;
      if (
        !Number.isFinite(spinnerWidth) ||
        !Number.isFinite(spinnerHeight) ||
        spinnerViewBox.width === 0 ||
        spinnerViewBox.height === 0
      ) {
        return;
      }

      const spinnerCenterX = voiceControlBounds.left + voiceControlBounds.width / 2;
      const spinnerCenterY = voiceControlBounds.top + voiceControlBounds.height / 2;
      const ringBottomX = regularSpinnerRing.cx.baseVal.value;
      const ringBottomY = regularSpinnerRing.cy.baseVal.value + regularSpinnerRing.r.baseVal.value;
      const attachmentPoint = svg.createSVGPoint();
      attachmentPoint.x =
        spinnerCenterX +
        ((ringBottomX - (spinnerViewBox.x + spinnerViewBox.width / 2)) / spinnerViewBox.width) *
          spinnerWidth;
      attachmentPoint.y =
        spinnerCenterY +
        ((ringBottomY - (spinnerViewBox.y + spinnerViewBox.height / 2)) / spinnerViewBox.height) *
          spinnerHeight;
      const localAttachment = attachmentPoint.matrixTransform(screenMatrix.inverse());
      waveWidth = localAttachment.x;
      waveCenter = localAttachment.y;
      primaryPath.style.transformOrigin = `${waveWidth}px ${waveCenter}px`;
      secondaryPath.style.transformOrigin = `${waveWidth}px ${waveCenter}px`;
    };

    const renderTravelingWaves = (timestamp: number) => {
      let normalizedLevel: number | null = null;
      if (analyser && audioSamples) {
        analyser.getByteTimeDomainData(audioSamples);
        let squareSum = 0;
        for (const sample of audioSamples) {
          const centeredSample = (sample - 128) / 128;
          squareSum += centeredSample * centeredSample;
        }
        const rms = Math.sqrt(squareSum / audioSamples.length);
        normalizedLevel = Math.min(1, Math.max(0, (rms - 0.012) / 0.16)) ** 0.65;
      } else if (simulateInputLevel) {
        normalizedLevel = simulatedSpeechLevel(timestamp);
      }

      if (normalizedLevel !== null) {
        const easing = normalizedLevel > inputLevelRef.current ? 0.42 : 0.12;
        inputLevelRef.current += (normalizedLevel - inputLevelRef.current) * easing;
      }

      const primaryAmplitude = 2 + inputLevelRef.current * 25;
      const secondaryAmplitude = 1 + inputLevelRef.current * 12;
      primaryPath.setAttribute(
        "d",
        createTravelingWavePath({
          amplitude: primaryAmplitude,
          cyclePhase: timestamp / 1650,
          waveCenter,
          waveWidth,
        }),
      );
      secondaryPath.setAttribute(
        "d",
        createTravelingWavePath({
          amplitude: secondaryAmplitude,
          cyclePhase: timestamp / 2450 + 0.28,
          waveCenter,
          waveWidth,
        }),
      );
    };

    syncWaveGeometry();
    renderTravelingWaves(performance.now());

    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let animationFrame = 0;
    const animateTravelingWaves = (timestamp: number) => {
      renderTravelingWaves(timestamp);
      animationFrame = window.requestAnimationFrame(animateTravelingWaves);
    };
    if (!prefersReducedMotion?.matches) {
      animationFrame = window.requestAnimationFrame(animateTravelingWaves);
    }

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            syncWaveGeometry();
            renderTravelingWaves(performance.now());
          });
    resizeObserver?.observe(entryArea);
    resizeObserver?.observe(voiceControl);
    resizeObserver?.observe(spinnerMark);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
    };
  }, [recordingAudioSource, simulateInputLevel]);

  return (
    <div ref={containerRef} className="chat-voice-entry-waveform" aria-hidden="true">
      <svg ref={svgRef} viewBox="0 0 600 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id={waveformGradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop
              className="chat-voice-waveform-gradient-stop chat-voice-waveform-gradient-stop-start"
              offset="0%"
            />
            <stop className="chat-voice-waveform-gradient-stop" offset="12%" />
            <stop className="chat-voice-waveform-gradient-stop" offset="100%" />
          </linearGradient>
        </defs>
        <path
          ref={primaryPathRef}
          className="chat-voice-waveform-line chat-voice-waveform-line-primary"
          d="M0 50 L600 50"
          style={{ stroke: `url(#${waveformGradientId})` }}
        />
        <path
          ref={secondaryPathRef}
          className="chat-voice-waveform-line chat-voice-waveform-line-secondary"
          d="M0 50 L600 50"
          style={{ stroke: `url(#${waveformGradientId})` }}
        />
      </svg>
    </div>
  );
}
