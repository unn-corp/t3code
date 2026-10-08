// @vitest-environment jsdom
// @effect-diagnostics nodeBuiltinImport:off - Exercise the shipped stylesheet, bypassing Vitest's CSS import stub.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ComposerSurface } from "./ComposerSurface";
import { OpenWhisprVoiceInput, type VoiceInputPhase } from "./OpenWhisprVoiceInput";
import { VoiceInputWaveform } from "./VoiceInputWaveform";

const stylesheet = NodeFS.readFileSync(new NodeURL.URL("../../index.css", import.meta.url), "utf8");

const noop = () => {};
let container: HTMLDivElement;
let root: Root;
let style: HTMLStyleElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // jsdom does not implement SVG screen geometry; this test covers phase styles.
  Object.defineProperty(SVGSVGElement.prototype, "getScreenCTM", {
    configurable: true,
    value: () => null,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  style = document.createElement("style");
  // Use the actual voice rules without Tailwind's imports and build directives.
  style.textContent = stylesheet.slice(
    stylesheet.indexOf("/* Voice input motion system"),
    stylesheet.indexOf("@keyframes"),
  );
  document.head.append(style);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  style.remove();
  Reflect.deleteProperty(SVGSVGElement.prototype, "getScreenCTM");
  vi.unstubAllGlobals();
});

async function renderPhase(phase: VoiceInputPhase) {
  await act(async () => {
    root.render(
      <ComposerSurface.VoiceRoot phase={phase}>
        <ComposerSurface.Shell>
          <ComposerSurface.Host>
            <ComposerSurface.Main>
              <VoiceInputWaveform audioSource={null} simulateInputLevel={false} />
              <OpenWhisprVoiceInput
                environmentId={null}
                phase={phase}
                disabled={false}
                onTranscript={noop}
                onPhaseChange={noop}
                onRecordingAudioSourceChange={noop}
                simulateInputLevel={false}
                dictationMicrophoneDeviceId="default"
                dictationStartKeybinds={[]}
                dictationEndKeybinds={[]}
              />
            </ComposerSurface.Main>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </ComposerSurface.VoiceRoot>,
    );
  });
}

function feedbackStyle(selector: string) {
  const element = container.querySelector(selector);
  expect(element).not.toBeNull();
  return getComputedStyle(element!);
}

it("shows recording, wraps the waveform into the spinner, then shows success and resets", async () => {
  await renderPhase("recording");
  expect(feedbackStyle(".chat-voice-stop-icon").opacity).toBe("1");
  expect(feedbackStyle(".chat-voice-entry-waveform").opacity).toBe("0.22");

  await renderPhase("transcribing");
  expect(feedbackStyle(".chat-voice-stop-icon").opacity).toBe("0");
  expect(feedbackStyle(".chat-voice-spinner-mark").opacity).toBe("1");
  expect(feedbackStyle(".chat-voice-spinner-mark").animation).toContain(
    "chat-voice-spinner-radial-unmask",
  );
  expect(feedbackStyle(".chat-voice-entry-waveform").animation).toContain("chat-voice-wave-wipe");

  await renderPhase("success");
  expect(feedbackStyle(".chat-voice-spinner-mark").opacity).toBe("0");
  expect(feedbackStyle(".chat-voice-success-mark").opacity).toBe("1");
  expect(feedbackStyle(".chat-voice-entry-waveform").visibility).toBe("hidden");

  await renderPhase("idle");
  expect(feedbackStyle(".chat-voice-success-mark").opacity).toBe("0");
  expect(feedbackStyle(".chat-voice-spinner-mark").opacity).toBe("0");
  expect(feedbackStyle(".chat-voice-mic-icon").opacity || "1").toBe("1");
});

it("shows the error result and applies the glow to the actual rounded composer surface", async () => {
  await renderPhase("no-audio");
  expect(feedbackStyle(".chat-voice-error-mark").opacity).toBe("1");
  expect(feedbackStyle(".chat-voice-spinner-mark").opacity).toBe("0");
  expect(feedbackStyle(".chat-composer-voice-root").animation).toContain("chat-voice-error-shake");

  // jsdom cannot compute pseudo-element styles; check that the live surface
  // matches the shipped halo selector and supplies its visible opacity.
  const surface = container.querySelector('[data-chat-composer-main-surface="true"]')!;
  const haloRules = Array.from(style.sheet!.cssRules).filter(
    (rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.style.content === '""',
  );
  expect(
    haloRules.some((rule) => surface.matches(rule.selectorText.replaceAll("::before", ""))),
  ).toBe(true);
  expect(
    feedbackStyle(".chat-composer-voice-root").getPropertyValue("--chat-voice-halo-opacity").trim(),
  ).toBe("0.46");
});
