/**
 * Synthesis for the selectable agent-notification sound set.
 *
 * These are generated rather than sampled so the shipped set is an original
 * work with no third-party licensing, and so the character of a sound can be
 * tuned by editing a spec instead of sourcing a new recording.
 *
 * Rendering is fully deterministic: the one noise-driven timbre uses a seeded
 * PRNG, so regenerating the assets from an unchanged spec reproduces the same
 * bytes and a rebuild never shows up as a spurious binary diff.
 */

export const SAMPLE_RATE = 48_000;

/** Headroom below full scale; every sound is peak-normalised to this. */
const PEAK = 0.82;

/** Attack ramp. Long enough to avoid a click, short enough to stay percussive. */
const ATTACK_SECONDS = 0.004;

/** Final ramp to silence, so a truncated decay cannot click. */
const RELEASE_SECONDS = 0.008;

/**
 * Amplitude at the end of a tone's nominal duration. Decay is exponential, so
 * this fixes the time constant rather than leaving each spec to guess one.
 */
const END_OF_DECAY_AMPLITUDE = 0.011;

export type Timbre = "bell" | "wood" | "sine" | "string" | "thump";

export type Tone = {
  /** Offset from the start of the sound, in seconds. */
  readonly at: number;
  readonly frequency: number;
  /** Nominal ring-out length; the tone is inaudible by the end of it. */
  readonly duration: number;
  readonly gain: number;
  readonly timbre: Timbre;
};

type Partial = { readonly ratio: number; readonly gain: number; readonly decay: number };

/**
 * Partial stacks per timbre. `decay` is a multiplier on the fundamental's decay
 * rate, so higher partials die away first the way a struck body behaves.
 */
const PARTIALS: Record<"bell" | "wood" | "sine", readonly Partial[]> = {
  // Inharmonic ratios: this reads as a struck bell rather than a sawtooth.
  bell: [
    { ratio: 1, gain: 1, decay: 1 },
    { ratio: 2.0, gain: 0.5, decay: 1.4 },
    { ratio: 3.01, gain: 0.28, decay: 1.9 },
    { ratio: 4.17, gain: 0.14, decay: 2.4 },
  ],
  // A marimba bar is tuned so its overtones land near the 4th and 10th harmonics.
  wood: [
    { ratio: 1, gain: 1, decay: 1 },
    { ratio: 3.93, gain: 0.38, decay: 2.6 },
    { ratio: 9.4, gain: 0.12, decay: 4.0 },
  ],
  sine: [
    { ratio: 1, gain: 1, decay: 1 },
    { ratio: 2, gain: 0.06, decay: 2 },
  ],
};

/** A4-relative semitone offset to frequency. */
export function note(semitonesFromA4: number): number {
  return 440 * 2 ** (semitonesFromA4 / 12);
}

export const NOTE = {
  C5: note(3),
  E5: note(7),
  G5: note(10),
  A5: note(12),
  C6: note(15),
  E6: note(19),
  G6: note(22),
} as const;

/** Deterministic PRNG, so noise-seeded timbres render identically every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Attack/decay envelope. Exponential decay reaching END_OF_DECAY_AMPLITUDE at
 * `duration`, with linear ramps at both ends to keep the waveform click-free.
 */
export function envelopeAt(elapsed: number, duration: number, decayRate: number): number {
  if (elapsed < 0 || elapsed > duration) return 0;
  const tau = duration / (-Math.log(END_OF_DECAY_AMPLITUDE) * decayRate);
  let amplitude = Math.exp(-elapsed / tau);
  if (elapsed < ATTACK_SECONDS) amplitude *= elapsed / ATTACK_SECONDS;
  const untilEnd = duration - elapsed;
  if (untilEnd < RELEASE_SECONDS) amplitude *= untilEnd / RELEASE_SECONDS;
  return amplitude;
}

function renderPartialTone(buffer: Float64Array, tone: Tone, partials: readonly Partial[]): void {
  const start = Math.round(tone.at * SAMPLE_RATE);
  const length = Math.round(tone.duration * SAMPLE_RATE);
  for (let i = 0; i < length; i += 1) {
    const index = start + i;
    if (index >= buffer.length) break;
    const elapsed = i / SAMPLE_RATE;
    let sample = 0;
    for (const partial of partials) {
      sample +=
        partial.gain *
        envelopeAt(elapsed, tone.duration, partial.decay) *
        Math.sin(2 * Math.PI * tone.frequency * partial.ratio * elapsed);
    }
    buffer[index] = (buffer[index] ?? 0) + sample * tone.gain;
  }
}

/**
 * Karplus-Strong: a noise burst circulated through a delay line with a
 * one-pole average. Cheap, and it reads as a plucked string far better than
 * any additive stack.
 */
function renderStringTone(buffer: Float64Array, tone: Tone, seed: number): void {
  const start = Math.round(tone.at * SAMPLE_RATE);
  const length = Math.round(tone.duration * SAMPLE_RATE);
  const delay = Math.max(2, Math.round(SAMPLE_RATE / tone.frequency));
  const random = mulberry32(seed);
  const line = new Float64Array(delay);
  for (let i = 0; i < delay; i += 1) line[i] = random() * 2 - 1;

  // Chosen so the string's own damping lands close to the nominal duration.
  const damping = 0.5 * Math.exp((Math.log(END_OF_DECAY_AMPLITUDE) * delay) / (length || 1));
  let cursor = 0;
  for (let i = 0; i < length; i += 1) {
    const index = start + i;
    if (index >= buffer.length) break;
    const current = line[cursor] ?? 0;
    const next = line[(cursor + 1) % delay] ?? 0;
    const value = (current + next) * damping;
    line[cursor] = value;
    cursor = (cursor + 1) % delay;
    const elapsed = i / SAMPLE_RATE;
    buffer[index] =
      (buffer[index] ?? 0) + current * tone.gain * envelopeAt(elapsed, tone.duration, 0.55);
  }
}

/**
 * A soft body-hit: the pitch drops fast from a strike transient down to the
 * nominal frequency, which is what makes a thump read as a knock and not a
 * bass note.
 */
function renderThumpTone(buffer: Float64Array, tone: Tone): void {
  const start = Math.round(tone.at * SAMPLE_RATE);
  const length = Math.round(tone.duration * SAMPLE_RATE);
  const sweepSeconds = 0.04;
  let phase = 0;
  for (let i = 0; i < length; i += 1) {
    const index = start + i;
    if (index >= buffer.length) break;
    const elapsed = i / SAMPLE_RATE;
    const sweep = Math.exp(-elapsed / sweepSeconds);
    const frequency = tone.frequency * (1 + 0.9 * sweep);
    phase += (2 * Math.PI * frequency) / SAMPLE_RATE;
    buffer[index] =
      (buffer[index] ?? 0) + Math.sin(phase) * tone.gain * envelopeAt(elapsed, tone.duration, 1.5);
  }
}

export function renderTones(tones: readonly Tone[], seed: number): Float64Array {
  const totalSeconds = tones.reduce(
    (longest, tone) => Math.max(longest, tone.at + tone.duration),
    0,
  );
  const buffer = new Float64Array(Math.ceil(totalSeconds * SAMPLE_RATE));
  tones.forEach((tone, index) => {
    switch (tone.timbre) {
      case "string":
        renderStringTone(buffer, tone, seed + index);
        break;
      case "thump":
        renderThumpTone(buffer, tone);
        break;
      default:
        renderPartialTone(buffer, tone, PARTIALS[tone.timbre]);
    }
  });
  return normalize(buffer);
}

/** Peak-normalise, so every sound in the picker sits at a comparable level. */
export function normalize(buffer: Float64Array): Float64Array {
  let peak = 0;
  for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
  if (peak === 0) return buffer;
  const scale = PEAK / peak;
  for (let i = 0; i < buffer.length; i += 1) buffer[i] = (buffer[i] ?? 0) * scale;
  return buffer;
}

export function encodeWav(buffer: Float64Array): Uint8Array {
  const bytes = new Uint8Array(44 + buffer.length * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + buffer.length * 2, true);
  writeAscii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, buffer.length * 2, true);
  for (let i = 0; i < buffer.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, buffer[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

export type SoundSpec = {
  readonly id: string;
  readonly tones: readonly Tone[];
};

/**
 * The generated half of the picker. Kept deliberately short and quiet: these
 * fire while the user is working in another window, so every one of them is
 * under a second and decays to silence on its own.
 */
export const SOUND_SPECS: readonly SoundSpec[] = [
  {
    id: "chime-soft",
    tones: [
      { at: 0, frequency: NOTE.C6, duration: 0.55, gain: 0.9, timbre: "bell" },
      { at: 0.085, frequency: NOTE.G6, duration: 0.6, gain: 0.75, timbre: "bell" },
    ],
  },
  {
    id: "marimba",
    tones: [
      { at: 0, frequency: NOTE.C5, duration: 0.34, gain: 1, timbre: "wood" },
      { at: 0.07, frequency: NOTE.E5, duration: 0.34, gain: 0.95, timbre: "wood" },
      { at: 0.14, frequency: NOTE.G5, duration: 0.42, gain: 0.9, timbre: "wood" },
    ],
  },
  {
    id: "ping",
    tones: [{ at: 0, frequency: NOTE.C6, duration: 0.25, gain: 1, timbre: "sine" }],
  },
  {
    id: "bloom",
    tones: [
      { at: 0, frequency: NOTE.C5, duration: 0.75, gain: 0.8, timbre: "bell" },
      { at: 0.09, frequency: NOTE.G5, duration: 0.7, gain: 0.7, timbre: "bell" },
      { at: 0.18, frequency: NOTE.E6, duration: 0.62, gain: 0.55, timbre: "bell" },
    ],
  },
  {
    id: "pluck",
    tones: [{ at: 0, frequency: NOTE.A5, duration: 0.4, gain: 1, timbre: "string" }],
  },
  {
    id: "knock",
    tones: [
      { at: 0, frequency: 140, duration: 0.18, gain: 1, timbre: "thump" },
      { at: 0.11, frequency: 140, duration: 0.2, gain: 0.8, timbre: "thump" },
    ],
  },
  {
    id: "descend",
    tones: [
      { at: 0, frequency: NOTE.G5, duration: 0.5, gain: 0.9, timbre: "bell" },
      { at: 0.09, frequency: NOTE.C5, duration: 0.6, gain: 0.85, timbre: "bell" },
    ],
  },
  {
    id: "alert",
    tones: [
      { at: 0, frequency: NOTE.E6, duration: 0.12, gain: 1, timbre: "sine" },
      { at: 0.11, frequency: NOTE.E6, duration: 0.12, gain: 1, timbre: "sine" },
      { at: 0.22, frequency: NOTE.E6, duration: 0.16, gain: 1, timbre: "sine" },
    ],
  },
];
