/**
 * Zero-asset sound engine — everything is synthesized with WebAudio so the
 * build stays a single offline file. All motifs are original.
 *
 * Signal path: each sound → its bus (effects / music / ambience) → master.
 * A shared synthetic reverb (a generated impulse, no samples) takes a send
 * from the music and effects buses, so everything sits in the same space.
 */
import type { NpcId } from "./types";
import * as storage from "../storage";
let ctx: AudioContext | null = null;

export interface AudioSettings {
  muted: boolean;
  /** 0–1 each. Ambience follows the effects slider. */
  music: number;
  effects: number;
}

const SETTINGS_KEY = "forgebound-audio";
const DEFAULTS: AudioSettings = { muted: false, music: 0.55, effects: 0.8 };

function loadSettings(): AudioSettings {
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        muted: !!p.muted,
        music: typeof p.music === "number" ? Math.max(0, Math.min(1, p.music)) : DEFAULTS.music,
        effects: typeof p.effects === "number" ? Math.max(0, Math.min(1, p.effects)) : DEFAULTS.effects,
      };
    }
  } catch {
    // fall through
  }
  return { ...DEFAULTS };
}

let settings = loadSettings();

export interface Buses {
  c: AudioContext;
  master: GainNode;
  effects: GainNode;
  music: GainNode;
  ambience: GainNode;
  /** Send into the shared reverb. */
  reverb: GainNode;
}
let buses: Buses | null = null;

/** A stereo impulse of decaying noise: a cheap, sample-free hall. */
function makeImpulse(c: AudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function applyVolumes() {
  if (!buses) return;
  const t = buses.c.currentTime;
  buses.master.gain.setTargetAtTime(settings.muted ? 0 : 2, t, 0.05);
  // The score is dense and sustained, effects are short and sparse, so the
  // music sits well under the effects or it buries them in the compressor.
  buses.effects.gain.setTargetAtTime(settings.effects * 3, t, 0.05);
  buses.ambience.gain.setTargetAtTime(settings.effects * 2, t, 0.05);
  buses.music.gain.setTargetAtTime(settings.music * 0.18, t, 0.05);
}

/**
 * The audio graph, created on first use. Browsers only let audio start after
 * a click or key press, so nothing calls this until the player has interacted.
 */
export function audio(): Buses | null {
  try {
    if (!ctx && typeof window !== "undefined") {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (!ctx) return null;
    if (ctx.state === "suspended") void ctx.resume();
    if (!buses) {
      const c = ctx;
      const master = c.createGain();
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 3;
      master.connect(comp).connect(c.destination);
      const verb = c.createConvolver();
      verb.buffer = makeImpulse(c, 2.6, 2.4);
      const reverb = c.createGain();
      reverb.gain.value = 0.9;
      reverb.connect(verb).connect(master);
      const mk = () => { const g = c.createGain(); g.connect(master); return g; };
      buses = { c, master, effects: mk(), music: mk(), ambience: mk(), reverb };
      applyVolumes();
      if (import.meta.env.DEV) (window as unknown as { __fbAudio: Buses }).__fbAudio = buses;
    }
    return buses;
  } catch {
    return null;
  }
}

/** The audio graph if it already exists; never creates it (so music can't start before a click). */
export const peekAudio = (): Buses | null => buses;

/** True once the player has interacted and audio is running. */
export const audioReady = () => !!buses && buses.c.state === "running";

export const getAudioSettings = (): AudioSettings => ({ ...settings });

export function setAudioSettings(next: Partial<AudioSettings>) {
  settings = { ...settings, ...next };
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // just won't be remembered
  }
  applyVolumes();
}

// ------------------------------------------------------------ primitives --

interface ToneOpts {
  type?: OscillatorType;
  vol?: number;
  delay?: number;
  glide?: number;
  attack?: number;
  /** Reverb send, 0–1. */
  wet?: number;
}

function tone(freq: number, dur: number, opts: ToneOpts = {}) {
  const b = audio();
  if (!b) return;
  const { c } = b;
  const { type = "triangle", vol = 0.12, delay = 0, glide, attack = 0.012, wet = 0.12 } = opts;
  const t0 = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g);
  g.connect(b.effects);
  if (wet > 0) {
    const s = c.createGain();
    s.gain.value = wet;
    g.connect(s).connect(b.reverb);
  }
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

let noiseBuf: AudioBuffer | null = null;
/** Two seconds of white noise, made once and reused by every noisy sound. */
export function whiteNoise(c: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

interface NoiseOpts {
  vol?: number;
  delay?: number;
  freq?: number;
  q?: number;
  type?: BiquadFilterType;
  /** Filter sweep target over the duration. */
  sweep?: number;
  attack?: number;
  wet?: number;
}

function noise(dur: number, opts: NoiseOpts = {}) {
  const b = audio();
  if (!b) return;
  const { c } = b;
  const { vol = 0.08, delay = 0, freq = 1800, q = 1, type = "bandpass", sweep, attack = 0.004, wet = 0.08 } = opts;
  const t0 = c.currentTime + delay;
  const src = c.createBufferSource();
  src.buffer = whiteNoise(c);
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t0 + dur);
  f.Q.value = q;
  // Filtering white noise throws most of its energy away (a narrow band
  // most of all), so make it back up: vol means roughly the same loudness
  // whatever the filter.
  const makeup = type === "bandpass" ? 2 + Math.min(4, q * 1.2) : 2.2;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol * makeup, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g);
  g.connect(b.effects);
  if (wet > 0) {
    const s = c.createGain();
    s.gain.value = wet;
    g.connect(s).connect(b.reverb);
  }
  src.start(t0, Math.random() * 1.5);
  src.stop(t0 + dur + 0.05);
}

/** A struck metal partial set: a fundamental plus inharmonic overtones, like a bell or anvil. */
function ring(freq: number, dur: number, vol: number, partials: number[] = [1, 2.76, 5.4], delay = 0, wet = 0.25) {
  partials.forEach((p, i) => tone(freq * p, dur / (1 + i * 0.6), { type: "sine", vol: vol / (1 + i * 1.4), delay, attack: 0.003, wet }));
}

// ---------------------------------------------------------------- sounds --

export type Ground = "grass" | "path" | "stone" | "wood" | "sand";

/** Footsteps differ by what's underfoot. */
/**
 * A footstep: a short, low heel thud (felt more than heard) under a scuff of
 * filtered noise shaped like the surface. Every step varies a little in
 * pitch and level, and left and right feet alternate in weight.
 */
let foot = 0;
function footstep(ground: Ground) {
  const b = audio();
  if (!b) return;
  foot ^= 1;
  const w = (foot ? 1 : 0.75) * (0.85 + Math.random() * 0.3);
  const vary = 0.9 + Math.random() * 0.2;
  const thud = (freq: number, vol: number, dur = 0.09) =>
    tone(freq * vary, dur, { type: "sine", vol: vol * w, glide: freq * vary * 0.6, attack: 0.008, wet: 0.03 });
  switch (ground) {
    case "grass":
      thud(85, 0.1);
      noise(0.13, { vol: 0.045 * w, freq: 520 * vary, type: "lowpass", q: 0.6, attack: 0.015, wet: 0 });
      noise(0.07, { vol: 0.015 * w, freq: 4200, type: "highpass", q: 0.5, attack: 0.02, delay: 0.02, wet: 0 });
      break;
    case "path":
      thud(90, 0.1);
      noise(0.11, { vol: 0.035 * w, freq: 700 * vary, type: "lowpass", q: 0.6, attack: 0.012, wet: 0 });
      // a few grains of grit crunching underfoot
      for (let i = 0; i < 4; i++) noise(0.018, { vol: 0.008 * w * (0.4 + Math.random() * 0.6), freq: 1800 + Math.random() * 1600, q: 2, delay: 0.01 + i * 0.016 + Math.random() * 0.01, wet: 0 });
      break;
    case "stone":
      thud(130, 0.12, 0.07);
      noise(0.05, { vol: 0.07 * w, freq: 1100 * vary, q: 1.4, attack: 0.004, wet: 0.08 });
      noise(0.1, { vol: 0.025 * w, freq: 2400, q: 0.8, attack: 0.02, delay: 0.03, wet: 0.04 });
      break;
    case "wood":
      // hollow planks: a resonant knock with a little give
      tone(155 * vary, 0.16, { type: "triangle", vol: 0.07 * w, glide: 120 * vary, attack: 0.006, wet: 0.1 });
      tone(310 * vary, 0.07, { type: "sine", vol: 0.02 * w, attack: 0.004, wet: 0.05 });
      noise(0.07, { vol: 0.025 * w, freq: 650 * vary, q: 1.6, attack: 0.006, wet: 0.05 });
      break;
    case "sand":
      thud(75, 0.08);
      noise(0.16, { vol: 0.05 * w, freq: 1800 * vary, q: 0.6, attack: 0.04, wet: 0 });
      break;
  }
}

// Vowel formants (Hz) for the NPCs' babble: a, e, o, u
const VOWELS: [number, number][] = [[800, 1200], [450, 1900], [480, 820], [350, 700]];
const VOICE: Record<NpcId, { pitch: number; rate: number }> = {
  maro: { pitch: 118, rate: 0.13 }, // low, warm and unhurried
  roka: { pitch: 205, rate: 0.1 }, // brighter and quicker
  hesta: { pitch: 228, rate: 0.085 }, // crisp and businesslike
  cael: { pitch: 132, rate: 0.15 }, // soft, slow and careful
};

/**
 * A few syllables of made-up speech: a buzzy glottal tone through two vowel
 * formants, with a little pitch contour and a breathy consonant at the start
 * of each syllable. Not words, just the sound of someone talking.
 */
function voice(who: NpcId, syllables: number) {
  const b = audio();
  if (!b) return;
  const { c } = b;
  const v = VOICE[who];
  for (let i = 0; i < syllables; i++) {
    const t = c.currentTime + i * v.rate * (0.9 + Math.random() * 0.3);
    const dur = v.rate * (0.8 + Math.random() * 0.4);
    const p = v.pitch * (1 + (Math.random() - 0.5) * 0.18) * (i === syllables - 1 ? 0.92 : 1);
    const src = c.createOscillator();
    src.type = "sawtooth";
    src.frequency.setValueAtTime(p * 1.04, t);
    src.frequency.linearRampToValueAtTime(p, t + dur);
    const [f1, f2] = VOWELS[Math.floor(Math.random() * VOWELS.length)];
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.085, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // a little of the raw voice, softened, so it carries over the music
    const dry = c.createBiquadFilter();
    dry.type = "lowpass";
    dry.frequency.value = 1400;
    const dg = c.createGain();
    dg.gain.value = 0.18;
    src.connect(dry).connect(dg).connect(g);
    for (const [f, q, lvl] of [[f1, 3, 1], [f2, 4, 0.7]] as const) {
      const bp = c.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = f;
      bp.Q.value = q;
      const fg = c.createGain();
      fg.gain.value = lvl;
      src.connect(bp).connect(fg).connect(g);
    }
    g.connect(b.effects);
    const w = c.createGain();
    w.gain.value = 0.12;
    g.connect(w).connect(b.reverb);
    src.start(t);
    src.stop(t + dur + 0.05);
    if (Math.random() < 0.6) noise(0.035, { vol: 0.025, freq: 3500, q: 1.5, delay: i * v.rate });
  }
}

export const sfx = {
  setMuted(m: boolean) { setAudioSettings({ muted: m }); },
  isMuted() { return settings.muted; },

  // UI
  click() { tone(880, 0.05, { type: "sine", vol: 0.05, wet: 0.04 }); noise(0.025, { vol: 0.03, freq: 3000 }); },
  error() { tone(196, 0.16, { type: "sawtooth", vol: 0.05, glide: 150, wet: 0.05 }); tone(185, 0.16, { type: "square", vol: 0.02, wet: 0 }); },
  /** Dialogue: a soft page-turn as a conversation opens or moves on. */
  page() { noise(0.1, { vol: 0.03, freq: 2400, sweep: 900, q: 0.8, attack: 0.02 }); },
  /** An NPC speaking a line: a few syllables of their voice. */
  voice(who: NpcId, syllables = 4) { voice(who, syllables); },
  open(what: "bank" | "shop" | "station") {
    if (what === "bank") {
      // a heavy chest lid creaks open, then coins settle
      tone(140, 0.35, { type: "sawtooth", vol: 0.02, glide: 210, attack: 0.05, wet: 0.1 });
      noise(0.3, { vol: 0.025, freq: 600, q: 4, sweep: 900 });
      [0.22, 0.3].forEach((d, i) => tone(2200 + i * 500, 0.12, { type: "sine", vol: 0.025, delay: d, wet: 0.3 }));
    } else if (what === "shop") {
      // a shop bell: two rings
      ring(1320, 0.7, 0.05, [1, 2.4, 4.1]);
      ring(1320, 0.6, 0.035, [1, 2.4, 4.1], 0.16);
    } else {
      noise(0.12, { vol: 0.03, freq: 400, type: "lowpass" });
    }
  },
  close() { noise(0.08, { vol: 0.03, freq: 500, type: "lowpass" }); tone(110, 0.08, { type: "sine", vol: 0.03 }); },

  // Movement
  step(ground: Ground = "grass") { footstep(ground); },
  swing() { noise(0.12, { vol: 0.05, freq: 3000, sweep: 900, q: 0.8, attack: 0.03 }); },

  // Items
  gather() { tone(587, 0.08, { type: "sine", vol: 0.06 }); tone(880, 0.12, { type: "sine", vol: 0.05, delay: 0.06, wet: 0.2 }); },
  coin() {
    ring(2100, 0.25, 0.04, [1, 2.7]);
    ring(2650, 0.3, 0.035, [1, 2.7], 0.06);
  },
  pickup() { tone(420, 0.08, { type: "sine", vol: 0.05, glide: 640 }); noise(0.05, { vol: 0.02, freq: 1400 }); },
  drop() { tone(140, 0.12, { type: "sine", vol: 0.06, glide: 90, wet: 0.05 }); noise(0.07, { vol: 0.03, freq: 500, type: "lowpass" }); },
  eat() {
    for (let i = 0; i < 3; i++) noise(0.06, { vol: 0.04, freq: 1200 + i * 300, q: 1.5, delay: i * 0.13 });
    tone(330, 0.1, { type: "sine", vol: 0.02, delay: 0.42, glide: 260 });
  },
  pour() {
    noise(0.6, { vol: 0.03, freq: 900, sweep: 2600, q: 2, attack: 0.1, wet: 0.2 });
    [784, 988, 1319].forEach((f, i) => tone(f, 0.5, { type: "sine", vol: 0.035, delay: 0.25 + i * 0.09, wet: 0.5 }));
  },

  // Work, each blow timed to its animation
  chop() {
    noise(0.09, { vol: 0.09, freq: 900, q: 1.2, wet: 0.06 });
    tone(118, 0.12, { type: "triangle", vol: 0.08, glide: 80, wet: 0.06 });
    tone(230, 0.06, { type: "sine", vol: 0.03, wet: 0 });
  },
  clink() {
    ring(1850, 0.22, 0.04, [1, 2.4, 3.9]);
    noise(0.05, { vol: 0.05, freq: 4200, q: 1.5 });
    noise(0.08, { vol: 0.03, freq: 700, type: "lowpass", delay: 0.02 });
  },
  tap() { ring(1480, 0.55, 0.05, [1, 2.64, 4.2, 6.1]); noise(0.03, { vol: 0.04, freq: 5200, q: 2 }); },
  smith() { ring(990, 0.9, 0.04, [1, 2.4, 3.9]); noise(0.25, { vol: 0.03, freq: 1500, sweep: 400, q: 0.8, attack: 0.02 }); },
  splash() {
    noise(0.35, { vol: 0.08, freq: 1600, sweep: 500, q: 0.9, wet: 0.15 });
    tone(520, 0.12, { type: "sine", vol: 0.03, glide: 220, delay: 0.05 });
    tone(780, 0.1, { type: "sine", vol: 0.02, glide: 300, delay: 0.12 });
  },
  sizzle() { noise(0.4, { vol: 0.03, freq: 6000, type: "highpass", q: 0.4, attack: 0.05, wet: 0.02 }); },

  // Creatures
  moo() {
    // two detuned saws through a vowel-ish formant, falling in pitch
    tone(150, 0.6, { type: "sawtooth", vol: 0.04, glide: 105, attack: 0.08, wet: 0.2 });
    tone(152, 0.6, { type: "sawtooth", vol: 0.035, glide: 103, attack: 0.1, delay: 0.02, wet: 0.2 });
    noise(0.5, { vol: 0.02, freq: 450, q: 3, attack: 0.08 });
  },
  cluck() {
    for (let i = 0; i < 3; i++) tone(720 + i * 60, 0.06, { type: "square", vol: 0.025, glide: 520, delay: i * 0.09, wet: 0.1 });
  },
  /** The restless dead: a dry clatter of bones and a hollow moan. */
  rattle() {
    for (let i = 0; i < 5; i++) noise(0.03, { vol: 0.04, freq: 1800 + i * 300, q: 4, delay: i * 0.05 });
    tone(150, 0.7, { type: "triangle", vol: 0.035, glide: 110, attack: 0.15, delay: 0.1, wet: 0.6 });
  },
  grunt() {
    tone(95, 0.3, { type: "sawtooth", vol: 0.05, glide: 70, attack: 0.03, wet: 0.15 });
    noise(0.25, { vol: 0.03, freq: 350, q: 2.5, attack: 0.03 });
  },

  // Combat
  hit() { noise(0.07, { vol: 0.09, freq: 2600, q: 1 }); tone(130, 0.12, { type: "square", vol: 0.05, glide: 80 }); },
  hurt() { tone(300, 0.18, { type: "sawtooth", vol: 0.06, glide: 150, wet: 0.1 }); noise(0.08, { vol: 0.05, freq: 700 }); },
  miss() { noise(0.1, { vol: 0.04, freq: 2600, sweep: 1200, q: 0.8, attack: 0.02 }); },
  kill() {
    [392, 523.25, 659.25].forEach((f, i) => tone(f, 0.22, { type: "triangle", vol: 0.07, delay: i * 0.08, wet: 0.3 }));
  },

  // Prayer
  bury() {
    noise(0.25, { vol: 0.04, freq: 500, q: 1, type: "lowpass", attack: 0.03 });
    tone(660, 0.4, { type: "sine", vol: 0.05, delay: 0.2, wet: 0.5 });
    tone(990, 0.5, { type: "sine", vol: 0.04, delay: 0.3, wet: 0.5 });
  },
  bless() {
    tone(587.33, 0.5, { type: "sine", vol: 0.05, wet: 0.6 });
    tone(880, 0.6, { type: "sine", vol: 0.045, delay: 0.07, wet: 0.6 });
    tone(1174.7, 0.7, { type: "sine", vol: 0.03, delay: 0.14, wet: 0.7 });
  },
  unbless() { tone(660, 0.35, { type: "sine", vol: 0.045, glide: 392, wet: 0.5 }); },
  pray() {
    [392, 493.88, 587.33, 783.99].forEach((n, i) => tone(n, 1.2, { type: "sine", vol: 0.045, delay: i * 0.14, attack: 0.08, wet: 0.7 }));
  },

  // Moments: these are fuller stingers now (see music.ts), kept here for callers
  // Waygates & the crypt
  /** Stepping up to a waygate: a low hum and a shimmer. */
  gate() {
    tone(110, 0.9, { type: "sine", vol: 0.05, attack: 0.2, wet: 0.5 });
    [660, 990, 1320].forEach((f, i) => tone(f, 0.5, { type: "sine", vol: 0.02, delay: 0.1 + i * 0.07, wet: 0.7 }));
  },
  attune() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.6, { type: "sine", vol: 0.035, delay: i * 0.09, wet: 0.7 }));
  },
  teleport() {
    tone(220, 0.8, { type: "sine", vol: 0.06, glide: 880, attack: 0.05, wet: 0.6 });
    noise(0.7, { vol: 0.04, freq: 800, sweep: 5000, q: 1, attack: 0.1, wet: 0.5 });
  },
  door() {
    tone(90, 0.5, { type: "sawtooth", vol: 0.03, glide: 70, attack: 0.05, wet: 0.4 });
    noise(0.45, { vol: 0.04, freq: 400, q: 2, attack: 0.08, wet: 0.4 });
  },

  levelUp() { stinger("level"); },
  death() { stinger("death"); },
  quest() { stinger("quest"); },
};

/** Set by music.ts: plays a stinger and ducks the score under it. */
let stingerImpl: (kind: "level" | "quest" | "death") => void = () => {};
export const registerStinger = (fn: typeof stingerImpl) => { stingerImpl = fn; };
const stinger = (kind: "level" | "quest" | "death") => stingerImpl(kind);
