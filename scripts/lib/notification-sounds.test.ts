import { describe, expect, it } from "vite-plus/test";

import {
  encodeWav,
  envelopeAt,
  note,
  renderTones,
  SAMPLE_RATE,
  SOUND_SPECS,
} from "./notification-sounds.ts";

/** Longest a notification sound may run; past this it stops being a cue. */
const MAX_DURATION_SECONDS = 1;

function peakOf(buffer: Float64Array): number {
  let peak = 0;
  for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
  return peak;
}

describe("envelopeAt", () => {
  it("starts and ends silent so a tone cannot click", () => {
    expect(envelopeAt(0, 0.5, 1)).toBe(0);
    expect(envelopeAt(0.5, 0.5, 1)).toBe(0);
  });

  it("is silent outside the tone", () => {
    expect(envelopeAt(-0.1, 0.5, 1)).toBe(0);
    expect(envelopeAt(0.6, 0.5, 1)).toBe(0);
  });

  it("decays monotonically after the attack", () => {
    const samples = [0.05, 0.1, 0.2, 0.3, 0.4].map((t) => envelopeAt(t, 0.5, 1));
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]).toBeLessThan(samples[i - 1] ?? 0);
    }
  });

  it("decays faster for higher partials", () => {
    expect(envelopeAt(0.2, 0.5, 2.4)).toBeLessThan(envelopeAt(0.2, 0.5, 1));
  });
});

describe("note", () => {
  it("anchors on A4 and rises an octave every twelve semitones", () => {
    expect(note(0)).toBeCloseTo(440, 6);
    expect(note(12)).toBeCloseTo(880, 6);
    expect(note(3)).toBeCloseTo(523.25, 1);
  });
});

describe("SOUND_SPECS", () => {
  it("has unique ids", () => {
    const ids = SOUND_SPECS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(SOUND_SPECS.map((spec) => [spec.id, spec] as const))(
    "%s renders as a short, normalised, click-free sound",
    (_id, spec) => {
      const rendered = renderTones(spec.tones, 1);
      const seconds = rendered.length / SAMPLE_RATE;
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(MAX_DURATION_SECONDS);
      // Peak-normalised, so no option is dramatically louder than another.
      expect(peakOf(rendered)).toBeCloseTo(0.82, 6);
      // Both ends must be inaudible or the sound clicks. -60 dBFS is the
      // audibility floor here; the release ramp lands several orders below it.
      expect(rendered[0]).toBe(0);
      expect(Math.abs(rendered.at(-1) ?? 1)).toBeLessThan(1e-3);
    },
  );

  it("renders deterministically, so regenerating is not a spurious diff", () => {
    const spec = SOUND_SPECS.find((candidate) => candidate.id === "pluck");
    expect(spec).toBeDefined();
    expect([...renderTones(spec!.tones, 7)]).toEqual([...renderTones(spec!.tones, 7)]);
  });
});

describe("encodeWav", () => {
  it("writes a mono 16-bit header matching the sample count", () => {
    const samples = renderTones(
      [{ at: 0, frequency: 440, duration: 0.1, gain: 1, timbre: "sine" }],
      1,
    );
    const wav = encodeWav(samples);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16); // bit depth
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(wav.length).toBe(44 + samples.length * 2);
  });
});
