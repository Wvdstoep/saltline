/**
 * Saltline — procedural sound engine (WebAudio only: no assets, no imports, no three.js).
 *
 *   const snd = new SoundEngine({ autoUnlock: true });
 *   snd.unlock();                       // on the first user gesture (also auto-installed)
 *   snd.update(state, dt);              // every frame
 *   snd.horn('long'); snd.bell(); snd.radio('chatter'); snd.ui('click');
 *   snd.event('collision', 0.8); snd.footstep('steel');
 *
 * state = { view, room, shipCls, throttle, rpmFrac, speedKn, windSpd, windRelDeg, waveH, rain, storm,
 *           night, nearHarborM, nearShips:[{distM, bearingRel(deg, +stbd), cls, speedKn, id?}],
 *           underway, docked, towing, warp }
 *
 * Every public method is wrapped: nothing throws, everything no-ops before unlock() or without WebAudio.
 * CPU cap: processing nodes (sources, filters, panners, shapers, convolver, compressor — GainNodes are
 * free multipliers and are not counted) stay at or under `maxNodes` (default 25). Low-priority one-shots
 * are evicted or dropped first; continuous voices that go quiet are torn down.
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const VIEWS = new Set(['deck', 'bridge', 'interior', 'ashore', 'chart']);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Per-class acoustic data. horn = fundamental in Hz (COLREG Annex III bands by length);
// rpm = [idle, max] crankshaft rpm; cyl = cylinders; hotel = genset/ventilation presence.
const CLASSES = {
  boxship: { len: 300, eng: 'slow2', cyl: 11, rpm: [24, 96], horn: 76, maxKn: 22, hotel: 1, telegraph: true },
  bulker: { len: 190, eng: 'slow2', cyl: 6, rpm: [26, 108], horn: 118, maxKn: 14, hotel: 1, telegraph: true },
  tanker: { len: 180, eng: 'slow2', cyl: 6, rpm: [26, 104], horn: 124, maxKn: 15, hotel: 1, telegraph: true },
  feeder: { len: 150, eng: 'medium', cyl: 8, rpm: [220, 600], horn: 142, maxKn: 20, hotel: 1, telegraph: true },
  coaster: { len: 90, eng: 'medium', cyl: 6, rpm: [300, 750], horn: 172, maxKn: 12, hotel: 0.9, telegraph: true },
  ferry: { len: 120, eng: 'medium', cyl: 9, rpm: [300, 750], horn: 156, maxKn: 22, hotel: 1, telegraph: true, twin: true },
  psv: { len: 85, eng: 'medium', cyl: 8, rpm: [400, 900], horn: 196, maxKn: 14, hotel: 1, telegraph: true, twin: true },
  trawler: { len: 45, eng: 'medium', cyl: 6, rpm: [400, 1000], horn: 290, maxKn: 12, hotel: 0.6 },
  tug: { len: 32, eng: 'high', cyl: 16, rpm: [600, 1600], horn: 270, maxKn: 13, hotel: 0.5, twin: true },
  pilot: { len: 18, eng: 'high', cyl: 12, rpm: [650, 2100], horn: 390, maxKn: 26, hotel: 0, twin: true },
  cruiser: { len: 12, eng: 'high', cyl: 8, rpm: [700, 3400], horn: 420, maxKn: 30, hotel: 0, twin: true },
  myacht: { len: 24, eng: 'high', cyl: 12, rpm: [650, 2300], horn: 350, maxKn: 26, hotel: 0.4, twin: true },
  superyacht: { len: 70, eng: 'high', cyl: 16, rpm: [600, 2000], horn: 250, maxKn: 18, hotel: 0.8, twin: true },
  sloop: { len: 11, eng: 'aux', cyl: 3, rpm: [850, 3000], horn: 460, maxKn: 7.2, hotel: 0, wood: true, sail: true },
  ketch: { len: 16, eng: 'aux', cyl: 4, rpm: [800, 2800], horn: 440, maxKn: 8.6, hotel: 0, wood: true, sail: true },
  catamaran: { len: 14, eng: 'aux', cyl: 3, rpm: [850, 3000], horn: 450, maxKn: 10.5, hotel: 0, sail: true, twin: true },
  schooner: { len: 35, eng: 'aux', cyl: 6, rpm: [700, 2000], horn: 320, maxKn: 10, hotel: 0.3, wood: true, sail: true },
};
const DEFAULT_CLASS = { len: 60, eng: 'medium', cyl: 6, rpm: [400, 900], horn: 220, maxKn: 14, hotel: 0.6 };
const classInfo = (cls) => CLASSES[cls] || DEFAULT_CLASS;

// Engine families. The firing waveform of one full engine cycle (2 revs for 4-stroke, 1 rev for
// 2-stroke) is synthesised from per-cylinder pressure pulses with timing/amplitude jitter and turned
// into a PeriodicWave, so a single oscillator gives the real lope of an uneven multi-cylinder diesel.
const ENGINES = {
  slow2: { stroke: 2, width: 0.13, ringAmp: 0.35, ring: 7, ringDecay: 0.09, jT: 0.012, jA: 0.08, tc: 1.4, stop: true, b: 'turbo', turbo: [1900, 6200], noiseHz: 1300, deckLP: 600, roomLP: 3600, gain: 1.3, ship: 0.9 },
  medium: { stroke: 4, width: 0.26, ringAmp: 0.3, ring: 5, ringDecay: 0.1, jT: 0.02, jA: 0.12, tc: 0.7, b: 'turbo', turbo: [3200, 9500], noiseHz: 1900, deckLP: 800, roomLP: 5200, gain: 1.0, ship: 0.6 },
  high: { stroke: 4, width: 0.4, ringAmp: 0.22, ring: 3.5, ringDecay: 0.12, jT: 0.035, jA: 0.18, tc: 0.3, b: 'mech', noiseHz: 2600, deckLP: 1300, roomLP: 7000, gain: 0.75, ship: 0.55 },
  aux: { stroke: 4, width: 0.24, ringAmp: 0.32, ring: 4.5, ringDecay: 0.1, jT: 0.045, jA: 0.25, tc: 0.25, b: 'mech', noiseHz: 2300, deckLP: 1500, roomLP: 6000, gain: 0.85, ship: 0.25 },
};

// Acoustic presets per listening position. lp = engine low-pass multiplier (0 = engine-room preset),
// rmode = rain filter mode (0 open deck, 1 bridge glass, 2 drumming on the deckhead, 3 quay).
const ENV = {
  deck: { eng: 0.42, lp: 1, clat: 0.16, turbo: 0.25, water: 1, wlp: 1, wind: 1, whistle: 0.8, windLP: 1, rain: 1, rmode: 0, harbor: 1, ships: 1, hotel: 0, hlp: 260, sfxLP: 16000, radio: 0.3, reverb: 0.35, steps: 'steel' },
  bridge: { eng: 0.24, lp: 0.55, clat: 0.05, turbo: 0.08, water: 0.32, wlp: 0.45, wind: 0.42, whistle: 1, windLP: 0.7, rain: 0.85, rmode: 1, harbor: 0.42, ships: 0.5, hotel: 0.3, hlp: 420, sfxLP: 4200, radio: 1, reverb: 0.12, steps: 'steel' },
  engine: { eng: 1, lp: 0, clat: 0.55, turbo: 1, water: 0.22, wlp: 0.22, wind: 0, whistle: 0, windLP: 0.4, rain: 0, rmode: 2, harbor: 0, ships: 0.05, hotel: 0.9, hlp: 2200, sfxLP: 2600, radio: 0.05, reverb: 0.45, steps: 'grating' },
  passage: { eng: 0.45, lp: 0.35, clat: 0.08, turbo: 0.1, water: 0.25, wlp: 0.3, wind: 0.07, whistle: 0.05, windLP: 0.4, rain: 0.25, rmode: 2, harbor: 0.08, ships: 0.12, hotel: 0.55, hlp: 380, sfxLP: 2400, radio: 0.12, reverb: 0.4, steps: 'steel' },
  cabin: { eng: 0.26, lp: 0.28, clat: 0.03, turbo: 0.03, water: 0.34, wlp: 0.28, wind: 0.1, whistle: 0.1, windLP: 0.45, rain: 0.4, rmode: 2, harbor: 0.12, ships: 0.15, hotel: 0.4, hlp: 300, sfxLP: 2000, radio: 0.08, reverb: 0.15, steps: 'wood' },
  mess: { eng: 0.3, lp: 0.3, clat: 0.04, turbo: 0.04, water: 0.28, wlp: 0.28, wind: 0.1, whistle: 0.08, windLP: 0.45, rain: 0.35, rmode: 2, harbor: 0.12, ships: 0.15, hotel: 0.6, hlp: 340, sfxLP: 2200, radio: 0.15, reverb: 0.25, steps: 'steel' },
  ashore: { eng: 0.1, lp: 0.45, clat: 0.05, turbo: 0.15, water: 0.45, wlp: 0.8, wind: 0.75, whistle: 0.4, windLP: 0.9, rain: 1, rmode: 3, harbor: 1.6, ships: 1, hotel: 0, hlp: 220, sfxLP: 16000, radio: 0, reverb: 0.55, steps: 'concrete' },
};
ENV.chart = { ...ENV.bridge, eng: 0.2, water: 0.28, wind: 0.35, harbor: 0.35 };
// IV2 HV7 (docs/INTERIORS-V2-CONTRACT.md §5.3): the spaces of interiors v2, each with its own sound
Object.assign(ENV, {
  ecr: { ...ENV.cabin, eng: 0.42, lp: 0.32, turbo: 0.08, hotel: 0.95, hlp: 900, reverb: 0.12, steps: 'vinyl' },
  galley: { ...ENV.mess, hotel: 1.0, hlp: 700, reverb: 0.3, steps: 'vinyl' },
  public: { ...ENV.mess, eng: 0.16, hotel: 0.75, hlp: 420, reverb: 0.35, steps: 'carpet' },
  cardeck: { ...ENV.passage, eng: 0.5, lp: 0.45, hotel: 0.5, reverb: 0.8, steps: 'steel' },
  hold: { ...ENV.passage, eng: 0.3, hotel: 0.1, reverb: 0.9, steps: 'steel' },
  steering: { ...ENV.engine, eng: 0.55, turbo: 0.2, hotel: 1.0, hlp: 1600, reverb: 0.5, steps: 'chequer' },
  workshop: { ...ENV.engine, eng: 0.7, lp: 0.15, turbo: 0.4, reverb: 0.4, steps: 'chequer' },
  wet: { ...ENV.cabin, reverb: 0.3, steps: 'vinyl' },
  stair: { ...ENV.passage, reverb: 0.5, steps: 'vinyl' },
});
for (const k in ENV) ENV[k].key = k;
const RAIN_MODE = [[3200, 0.35], [2300, 0.9], [380, 0.7], [2600, 0.45]];

const SURF = {
  steel: { bp: 520, q: 1.1, dec: 0.016, toe: 0.045, ring: 380, ringDec: 0.05, ringAmp: 0.12, amp: 0.5 },
  wood: { bp: 340, q: 0.9, dec: 0.022, toe: 0.05, ring: 0, amp: 0.55 },
  concrete: { bp: 1500, q: 0.5, dec: 0.012, toe: 0.04, ring: 0, amp: 0.55, scuff: true },
  grating: { bp: 2300, q: 1.6, dec: 0.01, toe: 0.03, ring: 1250, ringDec: 0.07, ringAmp: 0.1, amp: 0.45, rattle: true },
  carpet: { bp: 260, q: 0.7, dec: 0.03, toe: 0.06, ring: 0, amp: 0.3 },        // IV2 HV7
  vinyl: { bp: 700, q: 0.8, dec: 0.014, toe: 0.045, ring: 0, amp: 0.45, scuff: true },
  chequer: { bp: 900, q: 1.2, dec: 0.014, toe: 0.04, ring: 520, ringDec: 0.04, ringAmp: 0.1, amp: 0.5 },
};

function envKey(s) {
  if (s.view === 'interior') {
    const r = s.room;
    return r && ENV[r] && r !== 'deck' && r !== 'ashore' && r !== 'chart' ? r : 'passage';
  }
  return ENV[s.view] ? s.view : 'deck';
}
function harborFactor(s) {
  const ashore = s.view === 'ashore';
  if (s.nearHarborM == null) return ashore ? 1 : 0;
  const h = Math.pow(clamp(1 - s.nearHarborM / 3000, 0, 1), 1.4);
  return ashore ? Math.max(h, 0.9) : h;
}

// ---------- waveform / buffer generation (pure, cached) ----------
const WAVE_DATA = new Map();
function engineWaveData(engKey, cyl, seed) {
  const key = engKey + ':' + cyl + ':' + seed;
  let d = WAVE_DATA.get(key);
  if (d) return d;
  const pr = ENGINES[engKey] || ENGINES.medium;
  const N = 2048, M = 384, rnd = mulberry32(seed);
  const fire = [];
  for (let c = 0; c < cyl; c++) fire.push([(c + (rnd() - 0.5) * 2 * pr.jT) / cyl, 1 + (rnd() - 0.5) * 2 * pr.jA]);
  const x = new Float32Array(N), w = pr.width, w2 = pr.width * 2.6;
  for (let n = 0; n < N; n++) {
    const t = n / N;
    let v = 0;
    for (let i = 0; i < cyl; i++) {
      let u = t - fire[i][0];
      u -= Math.floor(u); u *= cyl;
      if (u > 3.5) continue;
      const a = u / w, b = u / w2;
      v += fire[i][1] * (a * Math.exp(1 - a) - 0.42 * b * Math.exp(1 - b) + pr.ringAmp * Math.exp(-u / pr.ringDecay) * Math.sin(TAU * pr.ring * u));
    }
    x[n] = v;
  }
  const cs = new Float32Array(N), sn = new Float32Array(N);
  for (let n = 0; n < N; n++) { cs[n] = Math.cos((TAU * n) / N); sn[n] = Math.sin((TAU * n) / N); }
  const re = new Float32Array(M + 1), im = new Float32Array(M + 1);
  for (let k = 1; k <= M; k++) {
    let sr = 0, si = 0, idx = 0;
    for (let n = 0; n < N; n++) { sr += x[n] * cs[idx]; si += x[n] * sn[idx]; idx = (idx + k) & (N - 1); }
    re[k] = (2 * sr) / N; im[k] = (2 * si) / N;
  }
  d = { re, im };
  WAVE_DATA.set(key, d);
  return d;
}

function seamless(make, len, ch, sr, ctx) {
  // Generates len + fade samples per channel and cross-fades the tail into the head so loops have no seam.
  const F = Math.min(4096, len >> 2), buf = ctx.createBuffer(ch, len, sr);
  for (let c = 0; c < ch; c++) {
    const raw = make(len + F), d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = raw[i];
    for (let i = 0; i < F; i++) { const u = i / F; d[i] = raw[i] * Math.sqrt(u) + raw[len + i] * Math.sqrt(1 - u); }
  }
  return buf;
}
function whiteGen(n) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1; return a; }
function pinkGen(n) {
  const a = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    a[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
  }
  return a;
}
function brownGen(n) {
  const a = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; a[i] = last * 3.5; }
  return a;
}
function rainGen(sr) {
  return (n) => {
    const a = new Float32Array(n), rate = 1500 / sr, dec = Math.exp(-1 / (sr * 0.0035));
    let env = 0, hiss = 0;
    for (let i = 0; i < n; i++) {
      if (Math.random() < rate) env = Math.max(env, Math.pow(Math.random(), 2) * (Math.random() < 0.06 ? 1 : 0.5));
      env *= dec;
      const w = Math.random() * 2 - 1;
      hiss += (w - hiss) * 0.5;
      a[i] = w * env * 0.9 + hiss * 0.07;
    }
    return a;
  };
}
function makeIR(ctx, sec) {
  const sr = ctx.sampleRate, len = Math.max(64, Math.floor(sr * sec)), b = ctx.createBuffer(2, len, sr);
  const echoes = [[0.031, 0.5], [0.067, 0.35], [0.29, 0.22], [0.61, 0.14], [1.05, 0.08]];
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr, a = Math.min(0.95, 0.15 + t * 0.9);
      lp += (Math.random() * 2 - 1 - lp) * (1 - a);
      d[i] = lp * Math.exp(-t * 3.4) * (t < 0.005 ? t / 0.005 : 1) * (1 + 3 * a);
    }
    for (const [et, ea] of echoes) {
      const s0 = Math.floor((et + (ch ? 0.004 : 0)) * sr);
      for (let j = 0; j < 240 && s0 + j < len; j++) d[s0 + j] += (Math.random() * 2 - 1) * ea * Math.exp(-j / 60);
    }
  }
  return b;
}
let SHAPER = null;
function shaperCurve() {
  if (SHAPER) return SHAPER;
  const n = 1024;
  SHAPER = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; SHAPER[i] = Math.tanh(3 * x) / Math.tanh(3); }
  return SHAPER;
}
const isGain = (n) => typeof GainNode !== 'undefined' && n instanceof GainNode;

function sanitize(s, o) {
  s = s || {};
  o.view = VIEWS.has(s.view) ? s.view : 'deck';
  o.room = typeof s.room === 'string' ? s.room : null;
  o.shipCls = typeof s.shipCls === 'string' ? s.shipCls : 'coaster';
  o.throttle = clamp(fin(s.throttle), -1, 1);
  o.rpmFrac = clamp(fin(s.rpmFrac, Math.abs(o.throttle)), 0, 1);
  o.speedKn = clamp(Math.abs(fin(s.speedKn)), 0, 60);
  o.windSpd = clamp(fin(s.windSpd), 0, 60);
  o.windRelDeg = fin(s.windRelDeg);
  o.sailFlog = clamp(fin(s.sailFlog), 0, 1);                                // sailing: flapping / luffing cloth (area-weighted) 0…1
  o.waveH = clamp(fin(s.waveH), 0, 15);
  o.rain = clamp(fin(s.rain), 0, 1);
  o.storm = clamp(fin(s.storm), 0, 1);
  o.night = clamp(fin(s.night), 0, 1);
  o.nearHarborM = typeof s.nearHarborM === 'number' && Number.isFinite(s.nearHarborM) ? Math.max(0, s.nearHarborM) : null;
  o.nearShips = Array.isArray(s.nearShips) ? s.nearShips : [];
  o.underway = !!s.underway;
  o.docked = !!s.docked;
  o.towing = !!s.towing;
  o.warp = Math.max(1, fin(s.warp, 1));
  return o;
}

export class SoundEngine {
  /**
   * opts: { context?: AudioContext|OfflineAudioContext, autoUnlock?: bool (default true),
   *         storageKey?: string ('saltline.sound'), storage?: bool (default true), maxNodes?: number (25),
   *         autoRadio?: bool (default true), muted?: bool, debug?: bool }
   */
  constructor(opts = {}) {
    this.opts = opts && typeof opts === 'object' ? opts : {};
    this.ctx = null;
    this._offline = false;
    this._unlocked = false;
    this._disposed = false;
    this._muted = false;
    this._hidden = false;
    this.maxNodes = clamp(fin(this.opts.maxNodes, 25), 8, 96);
    this.vol = { master: 0.8, music: 0.6, sfx: 1, ambience: 0.85 };
    this._key = typeof this.opts.storageKey === 'string' ? this.opts.storageKey : 'saltline.sound';
    this._persist = this.opts.storage !== false;
    this._load();
    if (typeof this.opts.muted === 'boolean') this._muted = this.opts.muted;
    this._s = sanitize(null, {});
    this.v = {};
    this.shots = [];
    this._grave = [];
    this._waves = new Map();
    this._tgt = new WeakMap();
    this._rl = {};
    this._t = 0; this._acc = 0; this._step = 0;
    this._errs = 0; this._lastErr = null; this._dropped = 0; this._peakProc = 0;
    this._swPh = 0; this._slap = 0; this._swEnv = 0.5; this._racePh = 0;
    this._gPh1 = 0; this._gPh2 = 0; this._gRW = 0; this._gust = 0.5;
    this._slots = [null, null]; this._aiHornAt = -1e9;
    this._thrSign = undefined; this._ord = undefined; this._ordPend = undefined; this._ordAt = 0;
    this._env = ENV.deck; this._ek = 'deck'; this._h = 0; this._wf = 1;
    SoundEngine._all.push(this);
    try {
      if (typeof document !== 'undefined') {
        this._hidden = document.visibilityState === 'hidden';
        this._onVis = () => { try { this._hidden = document.visibilityState === 'hidden'; this._applyRunState(); } catch (e) { this._err('visibility', e); } };
        document.addEventListener('visibilitychange', this._onVis);
      }
      if (this.opts.autoUnlock !== false && !this.opts.context && typeof window !== 'undefined') {
        this._unlockH = () => { this.unlock(); this._removeUnlock(); };
        for (const ev of ['pointerdown', 'keydown', 'touchend', 'mousedown']) window.addEventListener(ev, this._unlockH, { capture: true, passive: true });
      }
    } catch (e) { this._err('ctor', e); }
  }

  // ------------------------------------------------------------------ lifecycle
  get ready() { return !!(this.ctx && this._unlocked && !this._disposed && this.ctx.state !== 'closed'); }
  get muted() { return this._muted; }
  get volume() { return { ...this.vol }; }

  unlock() {
    try {
      if (this._disposed) return Promise.resolve(false);
      if (!this.ctx) {
        let ctx = this.opts.context || null;
        if (!ctx) {
          const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
          if (!AC) return Promise.resolve(false);
          try { ctx = new AC({ latencyHint: 'balanced' }); } catch { ctx = new AC(); }
        }
        this.ctx = ctx;
        this._offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
        this._build();
      }
      this._unlocked = true;
      return this._applyRunState();
    } catch (e) { this._err('unlock', e); return Promise.resolve(false); }
  }

  setMuted(b) {
    try { this._muted = !!b; this._save(); if (this.ctx) this._applyRunState(); } catch (e) { this._err('setMuted', e); }
  }

  setVolume(master, cats) {
    try {
      if (master && typeof master === 'object') { cats = master; master = master.master; }
      if (master != null && Number.isFinite(+master)) this.vol.master = clamp(+master, 0, 1);
      if (cats && typeof cats === 'object') {
        for (const k of ['music', 'sfx', 'ambience']) if (cats[k] != null && Number.isFinite(+cats[k])) this.vol[k] = clamp(+cats[k], 0, 1);
      }
      this._save();
      if (this.ctx && this.master) {
        this._masterTarget();
        this._set(this.sfxBus.gain, this.vol.sfx, 0.08);
        this._set(this.musicBus.gain, this.vol.music, 0.08);
        this._set(this.ambBus.gain, this.vol.ambience * this._wf, 0.08);
      }
    } catch (e) { this._err('setVolume', e); }
  }

  dispose() {
    try {
      this._disposed = true;
      this._removeUnlock();
      if (this._onVis && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVis);
      clearTimeout(this._suspT);
      for (const k of Object.keys(this.v)) this._retire(this.v[k]);
      this.v = {};
      for (const sh of this.shots.slice()) this._reap(sh);
      for (const g of this._grave) this._retire(g.v);
      this._grave = [];
      for (const n of [this.noiseW, this.noiseP]) { try { n && n.stop(); } catch { /* already stopped */ } }
      if (this.ctx && !this.opts.context && this.ctx.close) this.ctx.close().catch(() => {});
      this.ctx = null;
      SoundEngine._all = SoundEngine._all.filter((x) => x !== this);
    } catch (e) { this._err('dispose', e); }
  }

  _removeUnlock() {
    if (!this._unlockH || typeof window === 'undefined') return;
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'mousedown']) window.removeEventListener(ev, this._unlockH, { capture: true });
    this._unlockH = null;
  }

  _applyRunState() {
    const ctx = this.ctx;
    if (!ctx || this._disposed) return Promise.resolve(false);
    this._masterTarget();
    if (this._offline) return Promise.resolve(true);
    clearTimeout(this._suspT);
    const want = this._unlocked && !this._muted && !this._hidden;
    if (want) {
      if (ctx.state !== 'running' && ctx.state !== 'closed') return ctx.resume().then(() => true, () => false);
      return Promise.resolve(true);
    }
    // fade out, then suspend the context so a muted or hidden tab costs no CPU
    if (ctx.state === 'running') {
      this._suspT = setTimeout(() => {
        try {
          const still = !(this._unlocked && !this._muted && !this._hidden);
          if (still && this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
        } catch (e) { this._err('suspend', e); }
      }, 220);
    }
    return Promise.resolve(false);
  }

  _masterTarget() {
    if (!this.master) return;
    const on = this._unlocked && !this._muted && !this._hidden && !this._disposed;
    this._set(this.master.gain, on ? this.vol.master : 0, on ? 0.12 : 0.03);
  }

  _load() {
    if (!this._persist) return;
    try {
      const raw = typeof localStorage !== 'undefined' && localStorage.getItem(this._key);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (typeof o.muted === 'boolean') this._muted = o.muted;
      for (const k of ['master', 'music', 'sfx', 'ambience']) if (typeof o[k] === 'number' && Number.isFinite(o[k])) this.vol[k] = clamp(o[k], 0, 1);
    } catch { /* storage blocked or corrupt: keep defaults */ }
  }
  _save() {
    if (!this._persist) return;
    try { localStorage.setItem(this._key, JSON.stringify({ muted: this._muted, ...this.vol })); } catch { /* storage blocked */ }
  }
  _err(where, e) {
    this._errs++;
    this._lastErr = where + ': ' + (e && e.message ? e.message : String(e));
    if ((this._errs <= 3 || this.opts.debug) && typeof console !== 'undefined') console.warn('[sound]', where, e);
  }

  // ------------------------------------------------------------------ graph
  _build() {
    const c = this.ctx, sr = c.sampleRate;
    const core = { nodes: [], srcs: [], ins: [], proc: 0 };
    this._core = core;
    const add = (n) => { core.nodes.push(n); if (!isGain(n)) core.proc++; return n; };
    this.mix = add(c.createGain());
    this.comp = add(c.createDynamicsCompressor());
    this.comp.threshold.value = -16; this.comp.knee.value = 10; this.comp.ratio.value = 3.5;
    this.comp.attack.value = 0.004; this.comp.release.value = 0.25;
    this.master = add(c.createGain());
    this.master.gain.value = 0;
    this.mix.connect(this.comp); this.comp.connect(this.master); this.master.connect(c.destination);
    this.sfxBus = add(c.createGain()); this.sfxBus.gain.value = this.vol.sfx; this.sfxBus.connect(this.mix);
    this.ambBus = add(c.createGain()); this.ambBus.gain.value = this.vol.ambience; this.ambBus.connect(this.mix);
    this.musicBus = add(c.createGain()); this.musicBus.gain.value = this.vol.music; this.musicBus.connect(this.mix);
    this.uiBus = add(c.createGain()); this.uiBus.gain.value = 0.9; this.uiBus.connect(this.sfxBus);
    this.worldBus = add(c.createGain());
    this.worldLP = add(c.createBiquadFilter()); this.worldLP.type = 'lowpass'; this.worldLP.frequency.value = 16000; this.worldLP.Q.value = 0.6;
    this.worldBus.connect(this.worldLP); this.worldLP.connect(this.sfxBus);
    this.reverbIn = add(c.createGain()); this.reverbIn.gain.value = 0.3;
    this.conv = add(c.createConvolver()); this.conv.buffer = makeIR(c, 1.6);
    this.reverbOut = add(c.createGain()); this.reverbOut.gain.value = 0.55;
    this.reverbIn.connect(this.conv); this.conv.connect(this.reverbOut); this.reverbOut.connect(this.mix);
    this._buf = {
      white: seamless(whiteGen, Math.floor(sr * 2.5), 2, sr, c),
      pink: seamless(pinkGen, Math.floor(sr * 3), 2, sr, c),
      brown: seamless(brownGen, Math.floor(sr * 3), 1, sr, c),
      rain: seamless(rainGen(sr), Math.floor(sr * 2), 2, sr, c),
    };
    const loop = (buf) => { const s = add(c.createBufferSource()); s.buffer = buf; s.loop = true; s.start(0, Math.random() * (buf.duration - 0.05)); return s; };
    this.noiseW = loop(this._buf.white);
    this.noiseP = loop(this._buf.pink);
  }

  _wave(engKey, cyl, seed) {
    const key = engKey + ':' + cyl + ':' + seed;
    let w = this._waves.get(key);
    if (!w) {
      const d = engineWaveData(engKey, cyl, seed);
      w = this.ctx.createPeriodicWave(d.re, d.im);
      this._waves.set(key, w);
    }
    return w;
  }

  // smoothed parameter write with de-duplication (keeps the automation timeline short)
  _set(p, v, tc = 0.1) {
    if (!p || !Number.isFinite(v) || !this.ctx) return;
    const last = this._tgt.get(p);
    if (last !== undefined && Math.abs(last - v) <= Math.max(1e-5, Math.abs(last) * 0.004)) return;
    this._tgt.set(p, v);
    p.setTargetAtTime(v, this.ctx.currentTime, Math.max(0.005, tc));
  }

  // node helpers shared by continuous voices and one-shots (both are {nodes, srcs, ins, proc})
  _add(v, n) { v.nodes.push(n); if (!isGain(n)) v.proc++; return n; }
  _gain(v, g) { const n = this._add(v, this.ctx.createGain()); n.gain.value = g; return n; }
  _bq(v, type, f, q) { const b = this._add(v, this.ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
  _feed(v, src, dst) { src.connect(dst); v.ins.push([src, dst]); }
  _panner(v) {
    if (!this.ctx.createStereoPanner) return null;
    return this._add(v, this.ctx.createStereoPanner());
  }
  _osc(v, type, f, t0, t1) {
    const o = this._add(v, this.ctx.createOscillator());
    o.type = type; o.frequency.value = f;
    o.start(t0); o.stop(t1);
    v.srcs.push(o); if (t1 > (v.stopAt || 0)) { v.stopAt = t1; v.lastSrc = o; }
    return o;
  }
  _noise(v, name, t0, t1, rate = 1) {
    const b = this._buf[name], s = this._add(v, this.ctx.createBufferSource());
    s.buffer = b; s.loop = true; s.playbackRate.value = rate;
    s.start(t0, Math.random() * (b.duration - 0.05)); s.stop(t1);
    v.srcs.push(s); if (t1 > (v.stopAt || 0)) { v.stopAt = t1; v.lastSrc = s; }
    return s;
  }
  _newVoice(bus, withPan) {
    const v = { nodes: [], srcs: [], ins: [], proc: 0, quiet: 0, pan: null };
    v.out = this._gain(v, 0);
    if (withPan) v.pan = this._panner(v);
    if (v.pan) { v.out.connect(v.pan); v.pan.connect(bus); } else v.out.connect(bus);
    return v;
  }
  _retire(v) {
    if (!v || v.retired) return;
    v.retired = true;
    for (const s of v.srcs) { try { s.stop(); } catch { /* not started / already stopped */ } }
    for (const [a, b] of v.ins) { try { a.disconnect(b); } catch { /* already gone */ } }
    for (const n of v.nodes) { try { n.disconnect(); } catch { /* already gone */ } }
  }
  _bury(v, fade = 0.2) {
    try { v.out.gain.cancelScheduledValues(this.ctx.currentTime); v.out.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3); } catch { /* ignore */ }
    this._grave.push({ v, at: this.ctx.currentTime + fade * 2 + 0.1 });
  }

  // continuous voice lifecycle: create on demand, retire after `hold` s of silence
  _want(name, level, make, est = 2, hold = 3) {
    let v = this.v[name];
    if (level > 0.0008) {
      if (!v) {
        if (this._procNow() + est > this.maxNodes) return null;
        v = make.call(this);
        if (!v) return null;
        v.name = name; this.v[name] = v; this._peak();
      }
      v.quiet = 0;
    } else if (v) {
      v.quiet += this._step;
      if (v.quiet > hold) { this._retire(v); delete this.v[name]; return null; }
    }
    return v || null;
  }

  // Processing-node count. For admission, nodes already fading out (killed shots, buried voices,
  // gone within ~0.3 s) are not counted; for stats/peak everything still in the graph is.
  _procNow(admit = false) {
    let p = this._core ? this._core.proc : 0;
    for (const k in this.v) p += this.v[k].proc;
    for (const sh of this.shots) if (!admit || !sh.dead) p += sh.proc;
    if (!admit) for (const g of this._grave) p += g.v.proc;
    return p;
  }
  _peak() { const p = this._procNow(); if (p > this._peakProc) this._peakProc = p; }

  _live() {
    const c = this.ctx;
    return !!c && this._unlocked && !this._disposed && (this._offline || (c.state === 'running' && !this._muted && !this._hidden));
  }
  _gap(key, sec) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    if (this._rl[key] != null && now - this._rl[key] < sec) return false;
    this._rl[key] = now;
    return true;
  }

  // ------------------------------------------------------------------ one-shots
  // Budget admission: 1) tear down continuous voices that are already silent, 2) evict older
  // lower-priority one-shots, 3) for player-triggered sounds (prio >= 2) shed optional ambience
  // (rigging whistle, far ship, gulls, harbour hum, near ship); they come back once there is room.
  _admit(prio, est) {
    const max = this.maxNodes, fits = () => this._procNow(true) + est <= max;
    this._sweep(this.ctx.currentTime);
    if (fits()) return true;
    for (const k of Object.keys(this.v)) {
      const v = this.v[k];
      if (k !== 'engine' && v.quiet > 0) { this._retire(v); delete this.v[k]; if (fits()) return true; }
    }
    const cands = this.shots.filter((s) => !s.dead && s.prio < prio).sort((a, b) => a.t0 - b.t0);
    for (const s of cands) { this._kill(s); if (fits()) return true; }
    if (prio >= 2) {
      for (const k of ['ship1', 'gulls', 'harbor', 'whistle', 'ship0']) {
        if (k === 'whistle') { if (this.v.wind && this.v.wind.wbp) { this._dropWhistle(this.v.wind); if (fits()) return true; } continue; }
        const v = this.v[k];
        if (v) { delete this.v[k]; this._bury(v, 0.06); if (fits()) return true; }
      }
    }
    // game events get a small soft headroom (+4) rather than being refused; critical ones always play
    return prio >= 3 || (prio >= 2 && this._procNow(true) + est <= max + 4);
  }
  _dropWhistle(v) {
    if (!v || !v.wbp) return;
    try { this.noiseW.disconnect(v.wbp); } catch { /* ignore */ }
    try { v.wbp.disconnect(); v.wg.disconnect(); } catch { /* ignore */ }
    v.nodes = v.nodes.filter((n) => n !== v.wbp && n !== v.wg);
    v.ins = v.ins.filter(([, d]) => d !== v.wbp);
    v.proc--; v.wbp = v.wg = null;
  }
  _shot(name, o, build) {
    let sh = null;
    try {
      if (!this._live()) return null;
      const c = this.ctx, prio = Math.max(o.prio == null ? 1 : o.prio, this._boost || 0);
      if (!this._admit(prio, o.proc == null ? 3 : o.proc)) { this._dropped++; return null; }
      const t0 = c.currentTime + 0.012 + (o.delay || 0);
      sh = { name, nodes: [], srcs: [], ins: [], proc: 0, prio, t0, end: t0 + (o.dur || 1), dead: false, stopAt: 0, lastSrc: null };
      sh.out = this._gain(sh, 1);
      let tail = sh.out;
      if (o.pan != null) { const p = this._panner(sh); if (p) { p.pan.value = clamp(fin(o.pan), -1, 1); sh.out.connect(p); tail = p; } }
      tail.connect(o.bus === 'amb' ? this.ambBus : o.bus === 'ui' ? this.uiBus : this.worldBus);
      if (o.reverb > 0) { const sg = this._gain(sh, o.reverb); tail.connect(sg); sg.connect(this.reverbIn); }
      build.call(this, sh, sh.t0);
      sh.end = Math.max(sh.end, sh.stopAt);
      if (sh.lastSrc) sh.lastSrc.onended = () => this._reap(sh);
      this.shots.push(sh);
      this._peak();
      return sh;
    } catch (e) {
      this._err(name, e);
      if (sh) this._reap(sh);
      return null;
    }
  }
  _kill(sh) {
    if (!sh || sh.dead) return;
    sh.dead = true;
    const now = this.ctx.currentTime;
    try { sh.out.gain.cancelScheduledValues(now); sh.out.gain.setTargetAtTime(0, now, 0.012); } catch { /* ignore */ }
    for (const s of sh.srcs) { try { s.stop(now + 0.07); } catch { /* ignore */ } }
    sh.end = now + 0.1;
  }
  _reap(sh) {
    if (!sh || sh.reaped) return;
    sh.reaped = true; sh.dead = true;
    this._retire(sh);
    const i = this.shots.indexOf(sh);
    if (i >= 0) this.shots.splice(i, 1);
  }
  _sweep(now) {
    for (let i = this.shots.length - 1; i >= 0; i--) { const sh = this.shots[i]; if (now > sh.end + (sh.lastSrc ? 0.3 : 0.02)) this._reap(sh); }
    for (let i = this._grave.length - 1; i >= 0; i--) { const g = this._grave[i]; if (now >= g.at) { this._retire(g.v); this._grave.splice(i, 1); } }
  }

  // ------------------------------------------------------------------ introspection
  describe() {
    try {
      const now = this.ctx ? this.ctx.currentTime : 0, out = [];
      if (this._core) out.push({ voice: 'core', type: 'bus', nodes: this._core.nodes.length, proc: this._core.proc, info: 'mix, compressor, reverb, world LP, 2 shared noise loops' });
      for (const k of Object.keys(this.v)) {
        const v = this.v[k], lvl = this._tgt.get(v.out.gain);
        out.push({ voice: k, type: 'loop', level: +(lvl || 0).toFixed(4), nodes: v.nodes.length, proc: v.proc, ...(v.info ? v.info() : {}) });
      }
      for (const g of this._grave) out.push({ voice: (g.v.name || '?') + '(fading)', type: 'loop', level: 0, nodes: g.v.nodes.length, proc: g.v.proc });
      for (const sh of this.shots) out.push({ voice: sh.name, type: 'oneshot', nodes: sh.nodes.length, proc: sh.proc, left: +Math.max(0, sh.end - now).toFixed(2), dead: sh.dead || undefined });
      return out;
    } catch (e) { this._err('describe', e); return []; }
  }
  // debugging: voices of the most recently created live engine (e.g. SoundEngine.describe() in the console)
  static describe() { const i = SoundEngine._all[SoundEngine._all.length - 1]; return i ? i.describe() : []; }

  stats() {
    try {
      let nodes = this._core ? this._core.nodes.length : 0;
      for (const k in this.v) nodes += this.v[k].nodes.length;
      for (const sh of this.shots) nodes += sh.nodes.length;
      for (const g of this._grave) nodes += g.v.nodes.length;
      return {
        ctx: this.ctx ? this.ctx.state : 'none', ready: this.ready, muted: this._muted, hidden: this._hidden,
        env: this._ek, nodes, proc: this._procNow(), peakProc: this._peakProc, maxNodes: this.maxNodes,
        voices: Object.keys(this.v).length, shots: this.shots.length, dropped: this._dropped,
        errors: this._errs, lastError: this._lastErr, sampleRate: this.ctx ? this.ctx.sampleRate : 0,
      };
    } catch (e) { return { errors: this._errs + 1, lastError: String(e) }; }
  }

  meter() {
    try {
      if (!this.ctx || !this.master) return null;
      if (!this._an) {
        this._an = this.ctx.createAnalyser(); this._an.fftSize = 2048;
        this.master.connect(this._an);
        this._abuf = new Float32Array(this._an.fftSize);
      }
      this._an.getFloatTimeDomainData(this._abuf);
      let s = 0, pk = 0;
      for (let i = 0; i < this._abuf.length; i++) { const x = this._abuf[i]; s += x * x; if (Math.abs(x) > pk) pk = Math.abs(x); }
      const rms = Math.sqrt(s / this._abuf.length);
      return { rms, peak: pk, db: rms > 0 ? 20 * Math.log10(rms) : -Infinity };
    } catch (e) { this._err('meter', e); return null; }
  }

  // ------------------------------------------------------------------ per-frame update
  update(state, dt) {
    try {
      sanitize(state, this._s);
      if (!this.ctx || !this._unlocked || this._disposed) return;
      // a frozen clock (suspended realtime context) would pile up automation events: skip
      if (!this._offline && this.ctx.state !== 'running') return;
      this._acc += clamp(fin(dt, 0.016), 0, 0.25);
      if (this._acc < 1 / 30) return;
      const step = Math.min(this._acc, 0.25);
      this._acc = 0;
      this._control(step);
    } catch (e) { this._err('update', e); }
  }

  _control(step) {
    const now = this.ctx.currentTime, s = this._s;
    this._step = step; this._t += step;
    const ek = envKey(s), env = ENV[ek], ci = classInfo(s.shipCls);
    const wf = s.warp > 20 ? 0 : 1;
    const h = harborFactor(s);
    this._ek = ek; this._env = env; this._h = h; this._wf = wf;

    this._set(this.ambBus.gain, this.vol.ambience * wf, wf ? 0.4 : 0.6);
    this._set(this.sfxBus.gain, this.vol.sfx, 0.08);
    this._set(this.musicBus.gain, this.vol.music, 0.08);
    this._set(this.worldLP.frequency, env.sfxLP, 0.15);
    this._set(this.reverbIn.gain, env.reverb * (ek === 'deck' || ek === 'ashore' ? 0.35 + 0.65 * h : 1), 0.3);
    this._masterTarget();

    // shared modulators: swell, slaps, gusts
    const wh = s.waveH;
    this._swPh += (step * TAU) / (3.2 + 1.1 * Math.min(wh, 8));
    if (Math.random() < step * (0.5 + 0.35 * Math.min(wh, 4))) this._slap = Math.max(this._slap, rand(0.4, 1));
    this._slap *= Math.exp(-step / 0.14);
    this._swEnv = 0.45 + 0.4 * Math.pow(0.5 + 0.5 * Math.sin(this._swPh), 1.8) + 0.15 * (0.5 + 0.5 * Math.sin(this._swPh * 2.7 + 1.3));
    this._gPh1 += step * 0.41; this._gPh2 += step * 0.137;
    this._gRW = (this._gRW + (Math.random() - 0.5) * step * 0.8) * Math.exp(-step / 6);
    this._gust = clamp(0.55 + 0.25 * Math.sin(this._gPh1) + 0.15 * Math.sin(this._gPh2 * 2.3 + 0.5) + this._gRW, 0, 1.2);

    const running = this._ctlEngine(s, env, ci, wf, step);
    this._ctlHotel(s, env, ci, wf, running);
    this._ctlWater(s, env, ci, wf);
    this._ctlWind(s, env, ci, wf);
    this._ctlRain(s, env, wf);
    this._ctlHarbor(s, env, wf, h);
    this._ctlShips(s, env, wf, step, now);
    this._ctlCues(s, env, ci, wf, now, running);
    if (wf) this._auto(step, s, env, ci, h);
    this._sweep(now);
    this._peak();
  }

  _ctlEngine(s, env, ci, wf, step) {
    if (this.v.engine && this.v.engine.cls !== s.shipCls) { const old = this.v.engine; delete this.v.engine; this._bury(old, 0.4); }
    const pr = ENGINES[ci.eng];
    const thr = Math.abs(s.throttle), rf = s.rpmFrac;
    const demanded = thr > 0.02 || rf > 0.04;
    // big direct-drive two-strokes and sailing-yacht auxiliaries stop at zero throttle; others idle
    const running = !s.docked && (pr.stop || ci.sail ? demanded : demanded || s.underway);
    const ek = env.key, outside = ek === 'deck' || ek === 'ashore' || ek === 'bridge' || ek === 'chart';
    const boost = outside ? (ci.len < 30 ? 1.7 : ci.len < 80 ? 1.25 : 1) : 1;
    const idle = ci.rpm[0] / ci.rpm[1];
    const load = clamp(thr * 0.65 + Math.max(0, thr - rf) * 1.6 + Math.min(s.waveH, 6) * 0.03, 0, 1);
    // heavy weather: the propeller lifts and the governor hunts
    this._racePh += (step * TAU) / (4 + 1.2 * Math.min(s.waveH, 8));
    const race = s.waveH > 2.5 ? Math.sin(this._racePh) * 0.035 * Math.min((s.waveH - 2.5) / 3, 1) * rf : 0;
    const rpm = ci.rpm[1] * Math.max(idle, rf) * (1 + race);
    const cyc = rpm / 60 / (pr.stroke === 4 ? 2 : 1);
    let level = running ? env.eng * pr.gain * boost * (0.5 + 0.5 * Math.max(idle, rf)) * (0.85 + 0.35 * load) * 0.5 * (s.engNear != null ? 0.65 + 0.45 * s.engNear : 1) : 0;   // IV2 HV7: engNear
    let lp = env.lp === 0 ? pr.roomLP : Math.max(110, pr.deckLP * env.lp);
    lp *= 0.75 + 0.35 * load + 0.2 * rf;
    if (!wf) { level = running ? env.eng * pr.gain * 0.12 : 0; lp = 260; } // time-warp: muted engine bed only
    const v = this._want('engine', level, () => this._mkEngine(s.shipCls), 4, 6);
    if (!v) return running;
    const tcF = running ? pr.tc : 1.6;
    this._set(v.A.frequency, running ? cyc : cyc * 0.35, tcF);
    if (v.mode === 'twin') {
      this._set(v.B.frequency, cyc * (1.006 + 0.004 * Math.sin(this._t * 0.07)), tcF);
      this._set(v.bG.gain, 0.8, 0.3);
    } else if (v.mode === 'turbo') {
      this._set(v.B.frequency, lerp(pr.turbo[0], pr.turbo[1], Math.pow(rf, 1.4)), 1.5);
      this._set(v.bG.gain, running && wf ? env.turbo * 0.05 * rf * rf : 0, 0.8);
    } else {
      this._set(v.B.frequency, (rpm / 60) * 19, tcF); // gearbox mesh whine
      this._set(v.bG.gain, running && wf ? env.turbo * 0.012 * rf : 0, 0.5);
    }
    this._set(v.occ.frequency, lp, 0.25);
    const clat = running && wf ? env.clat * (0.3 + 0.7 * load) : 0;
    this._set(v.am.gain, clat * 0.5, 0.2);
    this._set(v.depth.gain, clat * 0.9, 0.2);
    this._set(v.nbp.frequency, env.lp === 0 ? pr.noiseHz : pr.noiseHz * 0.45, 0.3);
    this._set(v.out.gain, level, running ? 0.35 : 1.1);
    v.info = () => ({ cls: v.cls, family: ci.eng, mode: v.mode, rpm: Math.round(rpm), firingHz: +(cyc * ci.cyl).toFixed(1), running });
    return running;
  }

  _mkEngine(cls) {
    const c = this.ctx, ci = classInfo(cls), pr = ENGINES[ci.eng];
    const v = this._newVoice(this.sfxBus);
    v.cls = cls;
    const occ = this._bq(v, 'lowpass', 400, 0.9);
    occ.connect(v.out);
    const seed = hashStr(cls);
    const A = this._add(v, c.createOscillator());
    A.setPeriodicWave(this._wave(ci.eng, ci.cyl, seed));
    A.frequency.value = ci.rpm[0] / 60 / (pr.stroke === 4 ? 2 : 1);
    const aG = this._gain(v, 0.9);
    A.connect(aG); aG.connect(occ);
    // combustion / valve-gear clatter: band-passed noise amplitude-modulated by the firing waveform
    const nbp = this._bq(v, 'bandpass', pr.noiseHz, 0.8);
    this._feed(v, this.noiseW, nbp);
    const am = this._gain(v, 0);
    nbp.connect(am); am.connect(occ);
    const depth = this._gain(v, 0);
    A.connect(depth); depth.connect(am.gain);
    const mode = ci.twin && pr.stroke === 4 ? 'twin' : pr.b;
    const B = this._add(v, c.createOscillator());
    if (mode === 'twin') B.setPeriodicWave(this._wave(ci.eng, ci.cyl, seed + 7)); else B.type = 'sine';
    B.frequency.value = mode === 'twin' ? A.frequency.value : 1000;
    const bG = this._gain(v, 0);
    B.connect(bG); bG.connect(occ);
    A.start(); B.start();
    v.srcs.push(A, B);
    Object.assign(v, { occ, A, aG, nbp, am, depth, B, bG, mode });
    return v;
  }

  _ctlHotel(s, env, ci, wf, running) {
    // gensets + ventilation: the constant room tone of a working ship (and the only machinery when docked)
    let h = env.hotel;
    if ((env.key === 'deck' || env.key === 'ashore') && (s.docked || !running)) h = 0.08;
    const lvl = ci.hotel * h * wf * 0.22;
    const v = this._want('hotel', lvl, () => {
      const c = this.ctx, hv = this._newVoice(this.ambBus);
      hv.lp = this._bq(hv, 'lowpass', 300, 0.7); hv.lp.connect(hv.out);
      hv.A = this._add(hv, c.createOscillator());
      hv.A.setPeriodicWave(this._wave('medium', 6, 4242));
      hv.A.frequency.value = 7.5;
      const aG = this._gain(hv, 1); hv.A.connect(aG); aG.connect(hv.lp);
      hv.vent = this._gain(hv, 0.5); this._feed(hv, this.noiseP, hv.vent); hv.vent.connect(hv.lp);
      hv.A.start(); hv.srcs.push(hv.A);
      return hv;
    }, 2);
    if (!v) return;
    this._set(v.A.frequency, (ci.len > 100 ? 900 : 1500) / 120, 0.5);
    this._set(v.lp.frequency, env.hlp, 0.3);
    this._set(v.vent.gain, env.key === 'engine' ? 0.25 : 0.6, 0.3);
    this._set(v.out.gain, lvl, 0.4);
  }

  _ctlWater(s, env, ci, wf) {
    const kn = s.speedKn, wh = s.waveH;
    const sizeW = ci.len < 30 ? 1.3 : ci.len < 100 ? 1 : 0.85, pitchW = ci.len < 30 ? 1.25 : ci.len > 150 ? 0.7 : 1;
    // bow wave / hull wash
    const washL = Math.pow(clamp(kn / 13, 0, 1.5), 1.3) * (0.55 + 0.1 * Math.min(wh, 5)) * sizeW * env.water * wf * 0.3;
    const vw = this._want('wash', washL, () => {
      const v = this._newVoice(this.ambBus);
      v.bp = this._bq(v, 'bandpass', 600, 0.55); this._feed(v, this.noiseW, v.bp); v.bp.connect(v.out);
      return v;
    }, 1);
    if (vw) {
      this._set(vw.bp.frequency, Math.min(3200, (260 + 75 * kn) * pitchW) * env.wlp, 0.4);
      this._set(vw.out.gain, washL * (0.85 + 0.3 * this._swEnv), 0.15);
    }
    // sea: swell, lapping, slaps against hull or quay
    const quay = s.docked || env.key === 'ashore' ? 1.25 : 1;
    const seaL = (0.1 + 0.16 * Math.min(wh, 6)) * env.water * wf * (this._swEnv + 0.6 * this._slap * quay) * 0.28;
    const vs = this._want('sea', seaL, () => {
      const v = this._newVoice(this.ambBus);
      v.lp = this._bq(v, 'lowpass', 400, 0.8); this._feed(v, this.noiseP, v.lp); v.lp.connect(v.out);
      return v;
    }, 1);
    if (vs) {
      this._set(vs.lp.frequency, (320 + 120 * Math.min(wh, 6)) * env.wlp * (1 + 0.8 * this._slap), 0.06);
      this._set(vs.out.gain, seaL, 0.07);
    }
  }

  _ctlWind(s, env, ci, wf) {
    // apparent wind = true wind (from windRelDeg, + = starboard) plus own-speed headwind
    const th = s.windRelDeg * DEG, vs = s.speedKn * 0.5144;
    const ax = s.windSpd * Math.cos(th) + vs, ay = s.windSpd * Math.sin(th);
    const aw = Math.hypot(ax, ay), aang = Math.atan2(ay, ax), g = this._gust;
    const rig = ci.sail || ci.wood ? 1.25 : 1;
    const lvl = Math.pow(clamp(aw / 20, 0, 1.6), 1.6) * env.wind * (0.7 + 0.5 * g) * wf * 0.4 * rig;
    const v = this._want('wind', lvl, () => {
      const wv = this._newVoice(this.ambBus, true);
      wv.bp = this._bq(wv, 'bandpass', 400, 0.7); this._feed(wv, this.noiseW, wv.bp); wv.bp.connect(wv.out);
      return wv;
    }, 2);
    if (!v) return;
    this._set(v.bp.frequency, (180 + 26 * aw + 140 * g) * env.windLP, 0.25);
    this._set(v.bp.Q, 0.6 + 0.015 * aw, 0.5);
    const flog = s.sailFlog > 0.02 ? s.sailFlog * (0.5 + 0.5 * Math.sin(this.ctx.currentTime * 2 * Math.PI * (2.5 + aw / 8))) : 0;   // sailing: cloth flapping at 2–4 Hz
    this._set(v.out.gain, lvl * (1 + 1.6 * flog) + 0.02 * flog, flog ? 0.03 : 0.25);
    if (v.pan) this._set(v.pan.pan, Math.sin(aang) * (env.key === 'deck' || env.key === 'ashore' ? 0.55 : 0.2), 0.4);
    // whistle/howl in rigging, aerials and window seals above ~15 m/s
    const wl = clamp((aw - 14) / 12, 0, 1) * env.whistle * g * g * wf * 0.1 * rig;
    if (wl > 0.004 && !v.wbp && this._procNow() + 1 <= this.maxNodes) {
      v.wbp = this._bq(v, 'bandpass', 900, 28); this._feed(v, this.noiseW, v.wbp);
      v.wg = this._gain(v, 0); v.wbp.connect(v.wg); v.wg.connect(v.out);
      v.wq = 0;
    }
    if (v.wbp) {
      this._set(v.wbp.frequency, 600 + 42 * aw + 380 * g, 0.18);
      this._set(v.wg.gain, lvl > 0 ? wl / Math.max(lvl, 0.02) : 0, 0.2);
      v.wq = wl > 0.002 ? 0 : v.wq + this._step;
      if (v.wq > 3) this._dropWhistle(v);
    }
    // storm howl: a low, moaning resonance (superstructure, stays, wave crests) from about Bft 8, rising in pitch and
    // level with the gusts — the sound of a gale, not a breeze
    const hl = clamp((aw - 16) / 14, 0, 1.2) * env.wind * wf * 0.22 * (0.55 + 0.6 * g) * rig;
    if (hl > 0.004 && !v.hbp && this._procNow() + 1 <= this.maxNodes) {
      v.hbp = this._bq(v, 'bandpass', 260, 7); this._feed(v, this.noiseW, v.hbp);
      v.hg = this._gain(v, 0); v.hbp.connect(v.hg); v.hg.connect(v.out);
    }
    if (v.hbp) {
      this._ph = (this._ph || 0) + this._step * (0.35 + 0.25 * g);
      this._set(v.hbp.frequency, (190 + 7 * aw + 120 * g + 40 * Math.sin(this._ph)) * env.windLP, 0.3);
      this._set(v.hg.gain, lvl > 0 ? hl / Math.max(lvl, 0.02) : 0, 0.35);
    }
    v.info = () => ({ apparentMs: +aw.toFixed(1), whistle: !!v.wbp, howl: !!v.hbp });
  }

  _ctlRain(s, env, wf) {
    const rl = Math.pow(s.rain, 0.8) * env.rain * wf * 0.3;
    const v = this._want('rain', rl, () => {
      const rv = this._newVoice(this.ambBus);
      rv.src = this._add(rv, this.ctx.createBufferSource());
      rv.src.buffer = this._buf.rain; rv.src.loop = true; rv.src.start();
      rv.srcs.push(rv.src);
      rv.bp = this._bq(rv, 'bandpass', 3000, 0.4); rv.src.connect(rv.bp); rv.bp.connect(rv.out);
      return rv;
    }, 2);
    if (!v) return;
    const m = RAIN_MODE[env.rmode] || RAIN_MODE[0];
    this._set(v.bp.frequency, m[0], 0.25);
    this._set(v.bp.Q, m[1], 0.25);
    this._set(v.src.playbackRate, 0.85 + 0.35 * s.rain, 0.5);
    this._set(v.out.gain, rl * (0.85 + 0.15 * this._gust), 0.3);
  }

  _ctlHarbor(s, env, wf, h) {
    const he = h * env.harbor * wf;
    const humL = he * 0.14 * (1 - 0.35 * s.night);
    const v = this._want('harbor', humL, () => {
      const hv = this._newVoice(this.ambBus);
      hv.lp = this._bq(hv, 'lowpass', 240, 0.7); this._feed(hv, this.noiseP, hv.lp); hv.lp.connect(hv.out);
      return hv;
    }, 1);
    if (v) {
      this._set(v.lp.frequency, env.key === 'ashore' ? 520 : 230, 0.5);
      this._set(v.out.gain, humL, 0.6);
    }
    const gl = he * (1 - 0.85 * s.night) * (1 - s.storm);
    const g = this._want('gulls', gl > 0.04 ? gl : 0, () => {
      const c = this.ctx, gv = this._newVoice(this.ambBus, true);
      gv.bp = this._bq(gv, 'bandpass', 2000, 2.5);
      gv.call = this._gain(gv, 0);
      gv.A = this._add(gv, c.createOscillator()); gv.A.type = 'sawtooth'; gv.A.frequency.value = 900;
      gv.A.connect(gv.bp); gv.bp.connect(gv.call); gv.call.connect(gv.out);
      gv.A.start(); gv.srcs.push(gv.A); gv.busy = 0;
      return gv;
    }, 3);
    if (g) this._set(g.out.gain, Math.min(1, gl), 0.8);
  }

  _ctlShips(s, env, wf, step, now) {
    const list = [];
    for (const x of s.nearShips) {
      if (!x || typeof x !== 'object') continue;
      const d = fin(x.distM, 1e9);
      if (d > 2500 || d < 0) continue;
      list.push({ d, b: fin(x.bearingRel), cls: typeof x.cls === 'string' ? x.cls : 'coaster', kn: Math.abs(fin(x.speedKn)), id: x.id != null ? x.id : null, taken: false });
    }
    if (s.towing && !list.some((x) => x.cls === 'tug' && x.d < 400)) list.push({ d: 90, b: 175, cls: 'tug', kn: 4, id: '_tug', virtual: true, taken: false });
    list.sort((a, b) => a.d - b.d);
    if (list.length > 2) list.length = 2;
    const asg = [null, null];
    for (let i = 0; i < 2; i++) {
      const cur = this._slots[i];
      if (!cur) continue;
      let best = null, bd = 1e9;
      for (const x of list) {
        if (x.taken) continue;
        const same = x.id != null || cur.id != null ? x.id === cur.id : x.cls === cur.cls && Math.abs(x.d - cur.d) < 200;
        if (same && Math.abs(x.d - cur.d) < bd) { bd = Math.abs(x.d - cur.d); best = x; }
      }
      if (best) { best.taken = true; asg[i] = best; }
    }
    for (let i = 0; i < 2; i++) if (!asg[i]) { const x = list.find((y) => !y.taken); if (x) { x.taken = true; asg[i] = x; } }

    for (let i = 0; i < 2; i++) {
      const x = asg[i], prev = this._slots[i];
      const ci = x ? classInfo(x.cls) : null, pr = ci ? ENGINES[ci.eng] : null;
      const rf = x ? (x.virtual || (x.cls === 'tug' && s.towing) ? 0.85 : clamp(x.kn / ci.maxKn, 0, 1)) : 0;
      const moving = x ? x.kn > 0.4 || x.virtual : false;
      let level = x ? pr.ship * (moving ? 0.5 + 0.5 * rf : 0.2) * Math.min(1, 60 / (x.d + 30)) * env.ships * wf * 0.5 : 0;
      const v = this._want('ship' + i, level, () => {
        const sv = this._newVoice(this.ambBus, true);
        sv.lp = this._bq(sv, 'lowpass', 800, 0.7); sv.lp.connect(sv.out);
        sv.A = this._add(sv, this.ctx.createOscillator()); sv.A.frequency.value = 5;
        sv.A.connect(sv.lp); sv.A.start(); sv.srcs.push(sv.A);
        sv.cls = null; sv.pending = null; sv.rad = 0;
        return sv;
      }, 3);
      this._slots[i] = x ? { id: x.id, cls: x.cls, d: x.d } : null;
      if (!v || !x) continue;
      const sameShip = prev && (x.id != null || prev.id != null ? x.id === prev.id : prev.cls === x.cls);
      if (v.cls !== x.cls) {
        if (v.cls == null) { v.A.setPeriodicWave(this._wave(ci.eng, ci.cyl, hashStr(x.cls) + 1)); v.cls = x.cls; }
        else if (v.pending !== x.cls) { v.pending = x.cls; v.switchAt = now + 0.3; }
      }
      if (v.pending && now >= v.switchAt) {
        const pc = classInfo(v.pending);
        v.A.setPeriodicWave(this._wave(pc.eng, pc.cyl, hashStr(v.pending) + 1));
        v.cls = v.pending; v.pending = null;
      }
      if (v.pending) level = 0;
      // Doppler from the change in range
      if (sameShip && prev) v.rad = lerp(v.rad, clamp((prev.d - x.d) / Math.max(step, 1e-3), -40, 40), 0.15);
      else v.rad = 0;
      const dop = 343 / (343 - v.rad);
      const rpm = moving ? ci.rpm[1] * Math.max(ci.rpm[0] / ci.rpm[1], rf) : 900;
      this._set(v.A.frequency, (rpm / 60 / (pr.stroke === 4 ? 2 : 1)) * dop, 0.3);
      this._set(v.lp.frequency, Math.min(env.sfxLP, (160 + 2600 / (1 + x.d / 140)) * (Math.abs(x.b) > 100 ? 0.7 : 1)), 0.3);
      if (v.pan) this._set(v.pan.pan, Math.sin(x.b * DEG) * 0.85, 0.3);
      this._set(v.out.gain, level, v.pending ? 0.06 : 0.3);
      v.info = () => ({ cls: v.cls, distM: Math.round(x.d), bearing: Math.round(x.b), doppler: +dop.toFixed(3) });
      // passing traffic sometimes sounds a signal when it closes inside ~650 m
      if (wf && prev && sameShip && prev.d > 650 && x.d <= 650 && !x.virtual && x.kn > 2 && now - this._aiHornAt > 45 && Math.random() < 0.5) {
        this._aiHornAt = now;
        this._shipHorn(x, env);
      }
    }
  }

  _ctlCues(s, env, ci, wf, now, running) {
    // throttle through zero: air-start blast on a direct-reversing two-stroke, gearbox clunk otherwise
    const sign = Math.abs(s.throttle) < 0.03 ? 0 : Math.sign(s.throttle);
    if (this._thrSign === undefined) this._thrSign = sign;
    if (sign !== this._thrSign) {
      if (sign !== 0 && !s.docked && wf) { if (ci.eng === 'slow2') this._airStart(env); else this._gearClunk(env); }
      this._thrSign = sign;
    }
    // engine-order telegraph on ships that have one: ring when a new order (9 positions) settles
    if (!ci.telegraph) return;
    const ord = Math.round(s.throttle * 4);
    if (this._ord === undefined) this._ord = ord;
    if (ord === this._ord) { this._ordPend = undefined; return; }
    if (ord !== this._ordPend) { this._ordPend = ord; this._ordAt = now + 0.3; return; }
    if (now >= this._ordAt) {
      this._ord = ord; this._ordPend = undefined;
      if (wf && (env.key === 'bridge' || env.key === 'engine' || env.key === 'chart')) this._telegraph(env);
    }
  }

  _auto(dt, s, env, ci, h) {
    const P = (rate) => rate > 0 && Math.random() < rate * dt;
    const ek = env.key, he = h * env.harbor;
    if (s.storm > 0.3 && P(Math.pow(s.storm, 1.5) / 22)) this._thunder(rand(0.15, 1));
    if (this.v.gulls && P(he * 0.22 * (1 - 0.8 * s.night) * (1 - s.storm))) this._gullCall();
    if (he > 0.05 && P(he * 0.07)) this._clank(he, env);
    if (he > 0.1 && P(he * 0.015)) this._beeps(he, env);
    if (he > 0.1 && s.windSpd > 4 && P(he * 0.06 * clamp((s.windSpd - 4) / 8, 0, 1.5))) this._halyard(he);
    const inside = ek !== 'deck' && ek !== 'ashore';
    if (!s.docked && s.waveH > 0.8 && (inside || ci.wood) && P((s.waveH - 0.7) * 0.025 * (inside ? 1 : 0.6))) this._creak(rand(0.2, 0.7));
    if (s.docked && (s.waveH > 0.15 || s.windSpd > 6) && (ek === 'deck' || ek === 'ashore' || ek === 'cabin') && P(0.04)) this._creak(rand(0.2, 0.6), 'rope');
    if (!s.docked && s.waveH > 2.2 && s.speedKn > 3 && (ek === 'deck' || ek === 'bridge') && P((s.waveH - 2.2) * 0.03 * clamp(s.speedKn / 10, 0.3, 1.5))) this._splash(rand(0.3, 0.9), ek === 'bridge');
    // heavy seas: breaking crests crash against the hull and over the deck whether she makes way or lies hove-to
    if (!s.docked && s.waveH > 3 && (ek === 'deck' || ek === 'bridge' || ek === 'ashore') && P(clamp((s.waveH - 3) * 0.035, 0, 0.45))) this._splash(rand(0.5, 1), ek === 'bridge');
    if (this.opts.autoRadio !== false && env.radio > 0.2 && P(h > 0.1 ? 1 / 50 : 1 / 140)) this._chatter(0.55 * env.radio);
  }

  // ------------------------------------------------------------------ public one-shots
  horn(kind = 'long') {
    try {
      if (!this._live()) return false;
      const ci = classInfo(this._s.shipCls), ek = this._env.key;
      const pats = {
        long: [[0, 5]], prolonged: [[0, 5]], short: [[0, 1]], two: [[0, 1], [1.9, 1]], three: [[0, 1], [1.9, 1], [3.8, 1]],
        danger: [[0, 0.9], [1.7, 0.9], [3.4, 0.9], [5.1, 0.9], [6.8, 0.9]],
      };
      if (this._ownHorn && !this._ownHorn.dead && this._ownHorn.end > this.ctx.currentTime) this._kill(this._ownHorn);
      const amp = 0.5 * (ek === 'deck' || ek === 'ashore' ? 1 : ek === 'bridge' || ek === 'chart' ? 0.8 : 0.45);
      this._ownHorn = this._hornShot('horn', ci.horn, pats[kind] || pats.long, amp, { prio: 3, reverb: 0.25 + 0.5 * this._h });
      return !!this._ownHorn;
    } catch (e) { this._err('horn', e); return false; }
  }

  bell(count = 2) {
    try {
      if (!this._live()) return false;
      const n = clamp(Math.round(fin(count, 2)), 1, 8), ek = this._env.key;
      const times = [];
      for (let i = 0; i < n; i++) times.push(Math.floor(i / 2) * 1.25 + (i % 2) * 0.38);
      const last = times[times.length - 1], base = 1046 * rand(0.995, 1.005);
      const amp = 0.22 * (ek === 'deck' || ek === 'bridge' || ek === 'chart' || ek === 'ashore' ? 1 : 0.45);
      const parts = [[0.5, 0.1, 3.0], [1, 0.32, 2.2], [1.183, 0.2, 1.5], [2, 0.42, 1.0]];
      return !!this._shot('bell', { proc: 5, prio: 2, dur: last + 3.3, reverb: 0.35 }, (sh, t0) => {
        for (const [r, a, dec] of parts) {
          const o = this._osc(sh, 'sine', base * r, t0, t0 + last + 3.3), g = this._gain(sh, 0);
          o.connect(g); g.connect(sh.out);
          g.gain.setValueAtTime(0, t0);
          for (const ts of times) { const vel = rand(0.85, 1); g.gain.setTargetAtTime(a * amp * vel, t0 + ts, 0.0015); g.gain.setTargetAtTime(0, t0 + ts + 0.006, dec / 3); }
        }
        // clapper strike transient
        const bp = this._bq(sh, 'bandpass', 4200, 1.2), ng = this._gain(sh, 0);
        this._feed(sh, this.noiseW, bp); bp.connect(ng); ng.connect(sh.out);
        ng.gain.setValueAtTime(0, t0);
        for (const ts of times) { ng.gain.setTargetAtTime(amp * 0.5, t0 + ts, 0.0008); ng.gain.setTargetAtTime(0, t0 + ts + 0.003, 0.006); }
      });
    } catch (e) { this._err('bell', e); return false; }
  }

  radio(kind = 'squelch') {
    try {
      if (!this._live()) return false;
      const lvl = Math.max(0.15, this._env.radio);
      this._boost = 2;
      return !!(kind === 'chatter' ? this._chatter(lvl, 2) : this._squelch(lvl));
    } catch (e) { this._err('radio', e); return false; } finally { this._boost = 0; }
  }

  ui(kind = 'click') {
    try {
      if (!this._live()) return false;
      const tone = (sh, t0, f, at, len, a, type = 'sine') => {
        const o = this._osc(sh, type, f, t0 + at, t0 + at + len + 0.05), g = this._gain(sh, 0);
        o.connect(g); g.connect(sh.out);
        g.gain.setValueAtTime(0, t0 + at); g.gain.linearRampToValueAtTime(a, t0 + at + 0.004); g.gain.setTargetAtTime(0, t0 + at + 0.01, len / 3);
        return o;
      };
      switch (kind) {
        case 'click': return !!this._shot('ui-click', { bus: 'ui', proc: 1, prio: 3, dur: 0.08 }, (sh, t0) => {
          const o = tone(sh, t0, 1700, 0, 0.03, 0.07); o.frequency.exponentialRampToValueAtTime(1100, t0 + 0.03);
        });
        case 'open': return !!this._shot('ui-open', { bus: 'ui', proc: 2, prio: 3, dur: 0.3 }, (sh, t0) => { tone(sh, t0, 620, 0, 0.09, 0.06); tone(sh, t0, 930, 0.07, 0.12, 0.06); });
        case 'close': return !!this._shot('ui-close', { bus: 'ui', proc: 2, prio: 3, dur: 0.3 }, (sh, t0) => { tone(sh, t0, 930, 0, 0.09, 0.06); tone(sh, t0, 620, 0.07, 0.12, 0.06); });
        case 'cash': return !!this._shot('ui-cash', { bus: 'ui', proc: 4, prio: 3, dur: 0.8 }, (sh, t0) => {
          const bp = this._bq(sh, 'bandpass', 6000, 1), ng = this._gain(sh, 0);
          this._feed(sh, this.noiseW, bp); bp.connect(ng); ng.connect(sh.out);
          ng.gain.setValueAtTime(0, t0); ng.gain.linearRampToValueAtTime(0.12, t0 + 0.003); ng.gain.setTargetAtTime(0, t0 + 0.006, 0.01);
          tone(sh, t0, 2093, 0.02, 0.45, 0.06); tone(sh, t0, 2637, 0.09, 0.55, 0.07); tone(sh, t0, 3951, 0.09, 0.2, 0.025);
        });
        case 'error': return !!this._shot('ui-error', { bus: 'ui', proc: 2, prio: 3, dur: 0.35 }, (sh, t0) => {
          const lp = this._bq(sh, 'lowpass', 900, 0.7), g = this._gain(sh, 0), o = this._osc(sh, 'square', 180, t0, t0 + 0.3);
          o.connect(g); g.connect(lp); lp.connect(sh.out);
          for (const a of [0, 0.13]) { g.gain.setValueAtTime(0, t0 + a); g.gain.linearRampToValueAtTime(0.09, t0 + a + 0.005); g.gain.setValueAtTime(0.09, t0 + a + 0.08); g.gain.linearRampToValueAtTime(0, t0 + a + 0.09); }
        });
        case 'warn': return !!this._shot('ui-warn', { bus: 'ui', proc: 2, prio: 3, dur: 0.45 }, (sh, t0) => { tone(sh, t0, 880, 0, 0.14, 0.07, 'triangle'); tone(sh, t0, 660, 0.17, 0.16, 0.07, 'triangle'); });
        default: return false;
      }
    } catch (e) { this._err('ui', e); return false; }
  }

  event(kind, intensity = 0.6) {
    try {
      if (!this._live()) return false;
      const k = clamp(fin(intensity, 0.6), 0, 1), env = this._env;
      this._boost = 2; // game-triggered: outranks auto ambience in the node budget
      switch (kind) {
        case 'collision': return this._gap('collision', 0.35) && !!this._collision(k, env);
        case 'grounding': return this._gap('grounding', 1.2) && !!this._grounding(k, env);
        case 'creak': return !!this._creak(k);
        case 'jibe_bang': return this._gap('jibe', 1.5) && !!this._collision(Math.min(1, 0.35 + 0.5 * k), env);   // sailing: crash jibe
        case 'splash': return !!this._splash(k, env.key === 'bridge');
        case 'thunder': return !!this._thunder(k);
        case 'tug': return !!this._tug(k, env);
        case 'anchor': return this._gap('anchor', 2) && !!this._anchor(k, env);
        default: return false;
      }
    } catch (e) { this._err('event', e); return false; } finally { this._boost = 0; }
  }

  footstep(surface) {
    try {
      if (!this._live() || !this._gap('step', 0.09)) return false;
      const env = this._env, surf = SURF[surface] ? surface : env.steps || 'steel', p = SURF[surf];
      this._boost = 2;
      const amp = p.amp * rand(0.85, 1.1) * (env.key === 'engine' ? 0.8 : 1) * 0.5;
      return !!this._shot('step-' + surf, { proc: p.ring ? 2 : 1, prio: 1, dur: 0.3, reverb: env.reverb * 0.5 }, (sh, t0) => {
        const bp = this._bq(sh, 'bandpass', p.bp * rand(0.9, 1.1), p.q), g = this._gain(sh, 0);
        this._feed(sh, this.noiseW, bp); bp.connect(g); g.connect(sh.out);
        g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(amp, t0 + 0.002); g.gain.setTargetAtTime(0, t0 + 0.003, p.dec);
        g.gain.setTargetAtTime(amp * 0.55, t0 + p.toe, 0.002); g.gain.setTargetAtTime(0, t0 + p.toe + 0.004, p.dec * 0.8);
        if (p.rattle) for (const dt of [0.012, 0.055]) { g.gain.setTargetAtTime(amp * 0.3, t0 + dt, 0.001); g.gain.setTargetAtTime(0, t0 + dt + 0.003, 0.006); }
        if (p.scuff) { g.gain.setTargetAtTime(amp * 0.12, t0 + p.toe + 0.02, 0.01); g.gain.setTargetAtTime(0, t0 + p.toe + 0.08, 0.02); }
        if (p.ring) {
          const o = this._osc(sh, 'sine', p.ring * rand(0.92, 1.08), t0, t0 + 0.28), rg = this._gain(sh, 0);
          o.connect(rg); rg.connect(sh.out);
          rg.gain.setValueAtTime(0, t0); rg.gain.linearRampToValueAtTime(amp * p.ringAmp * 2, t0 + 0.003); rg.gain.setTargetAtTime(0, t0 + 0.004, p.ringDec);
        }
        // shared-noise shots have no source of their own: keep them alive for their envelope
        sh.end = t0 + 0.3;
      });
    } catch (e) { this._err('footstep', e); return false; } finally { this._boost = 0; }
  }

  // ------------------------------------------------------------------ synthesisers
  // Ship's whistle: two detuned reed-like oscillators through a resonant formant low-pass; pressure
  // build-up glide on attack, sag on release. pattern = [[start, length], ...] in seconds.
  _hornShot(name, f, pattern, amp, o = {}) {
    const big = f < 160, atk = big ? 0.2 : f < 300 ? 0.1 : 0.05, rel = big ? 0.6 : f < 300 ? 0.3 : 0.15;
    const total = pattern.reduce((m, p) => Math.max(m, p[0] + p[1]), 0) + rel * 3;
    return this._shot(name, { proc: 3, prio: o.prio == null ? 3 : o.prio, dur: total, pan: o.pan, delay: o.delay, reverb: o.reverb == null ? 0.3 : o.reverb, bus: o.bus }, (sh, t0) => {
      const lp = this._bq(sh, 'lowpass', Math.min(o.lp || 20000, clamp(f * (big ? 10 : 7), 600, 4500)), big ? 3.5 : 2.2);
      lp.connect(sh.out);
      const g = this._gain(sh, 0); g.connect(lp);
      const o1 = this._osc(sh, 'sawtooth', f, t0, t0 + total), o2 = this._osc(sh, big ? 'sawtooth' : 'square', f * 1.004, t0, t0 + total);
      const g2 = this._gain(sh, big ? 0.6 : 0.35);
      o1.connect(g); o2.connect(g2); g2.connect(g);
      g.gain.setValueAtTime(0, t0);
      for (const [st, len] of pattern) {
        const a = t0 + st, b = a + len;
        for (const [osc, mul] of [[o1, 1], [o2, 1.004]]) {
          osc.frequency.setValueAtTime(f * mul * 0.92, a);
          osc.frequency.exponentialRampToValueAtTime(f * mul, a + atk * 1.4);
          osc.frequency.setValueAtTime(f * mul, b);
          osc.frequency.exponentialRampToValueAtTime(f * mul * 0.95, b + rel);
        }
        g.gain.setValueAtTime(0, a); g.gain.linearRampToValueAtTime(amp, a + atk); g.gain.setValueAtTime(amp, b); g.gain.setTargetAtTime(0, b, rel / 3);
      }
    });
  }

  _shipHorn(x, env) {
    const f = classInfo(x.cls).horn;
    const pat = pick([[[0, 1]], [[0, 1], [1.9, 1]], [[0, 4.5]]]);
    const amp = 0.5 * env.ships * Math.min(1, 220 / (x.d + 40));
    return this._hornShot('ship-horn', f, pat, amp, {
      prio: 2, bus: 'amb', pan: Math.sin(x.b * DEG) * 0.85, delay: Math.min(x.d / 343, 5), reverb: 0.35,
      lp: Math.min(env.sfxLP, 300 + 5000 / (1 + x.d / 250)),
    });
  }

  _squelch(lvl) {
    return this._shot('radio-squelch', { proc: 1, prio: 1, dur: 0.4 }, (sh, t0) => {
      const bp = this._bq(sh, 'bandpass', 2100, 0.6), g = this._gain(sh, 0), len = rand(0.12, 0.26), a = 0.22 * lvl;
      this._feed(sh, this.noiseW, bp); bp.connect(g); g.connect(sh.out);
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(a, t0 + 0.004); g.gain.setValueAtTime(a, t0 + len); g.gain.linearRampToValueAtTime(0, t0 + len + 0.012);
    });
  }

  // VHF voice: a glottal sawtooth through two moving formants, syllabic envelope, 300–3000 Hz radio
  // band, soft clipping and carrier hiss, with squelch open/close bursts.
  _chatter(lvl, prio = 1) {
    const dur = rand(1.4, 3.2);
    return this._shot('radio-chatter', { proc: 5, prio, dur: dur + 0.45 }, (sh, t0) => {
      const o = this._osc(sh, 'sawtooth', 120, t0, t0 + dur + 0.1);
      const f1 = this._bq(sh, 'bandpass', 600, 4), f2 = this._bq(sh, 'bandpass', 1500, 5), syl = this._gain(sh, 0);
      const rbp = this._bq(sh, 'bandpass', 1400, 0.75), sat = this._add(sh, this.ctx.createWaveShaper()), hiss = this._gain(sh, 0);
      sat.curve = shaperCurve(); sat.oversample = 'none';
      const f2g = this._gain(sh, 0.6);
      o.connect(f1); o.connect(f2); f1.connect(syl); f2.connect(f2g); f2g.connect(syl);
      syl.connect(rbp); this._feed(sh, this.noiseW, hiss); hiss.connect(rbp);
      const post = this._gain(sh, 0.35 * lvl);
      rbp.connect(sat); sat.connect(post); post.connect(sh.out);
      let t = t0 + 0.08;
      const p0 = rand(100, 150);
      syl.gain.setValueAtTime(0, t0);
      while (t < t0 + dur) {
        const len = rand(0.07, 0.22), p = p0 * (1 - (0.15 * (t - t0)) / dur) * rand(0.9, 1.15);
        o.frequency.setTargetAtTime(p, t, 0.025);
        f1.frequency.setTargetAtTime(rand(300, 850), t, 0.02);
        f2.frequency.setTargetAtTime(rand(900, 2400), t, 0.02);
        syl.gain.setTargetAtTime(rand(1.5, 3), t, 0.012);
        syl.gain.setTargetAtTime(0.05, t + len, 0.018);
        t += len + (Math.random() < 0.18 ? rand(0.15, 0.35) : rand(0.015, 0.06));
      }
      syl.gain.setTargetAtTime(0, t0 + dur, 0.02);
      hiss.gain.setValueAtTime(0, t0); hiss.gain.linearRampToValueAtTime(0.5, t0 + 0.01); hiss.gain.setTargetAtTime(0.08, t0 + 0.06, 0.02);
      hiss.gain.setTargetAtTime(0.7, t0 + dur, 0.005); hiss.gain.setTargetAtTime(0, t0 + dur + 0.2, 0.01);
    });
  }

  _collision(k, env) {
    const dur = 1.2 + 1.3 * k, amp = (0.35 + 0.65 * k) * 0.6;
    return this._shot('collision', { proc: 4, prio: 3, dur, reverb: 0.25 }, (sh, t0) => {
      const o = this._osc(sh, 'sine', 72, t0, t0 + dur), og = this._gain(sh, 0);
      o.frequency.setValueAtTime(72, t0); o.frequency.exponentialRampToValueAtTime(28, t0 + 0.5);
      o.connect(og); og.connect(sh.out);
      og.gain.setValueAtTime(0, t0); og.gain.linearRampToValueAtTime(amp, t0 + 0.006); og.gain.setTargetAtTime(0, t0 + 0.01, 0.22);
      const lp = this._bq(sh, 'lowpass', 1800, 0.8), ng = this._gain(sh, 0);
      this._feed(sh, this.noiseP, lp); lp.connect(ng); ng.connect(sh.out);
      lp.frequency.setValueAtTime(Math.min(1800 + 2000 * k, env.sfxLP * 1.5), t0); lp.frequency.exponentialRampToValueAtTime(250, t0 + 0.6);
      ng.gain.setValueAtTime(0, t0); ng.gain.linearRampToValueAtTime(amp * 1.6, t0 + 0.004); ng.gain.setTargetAtTime(0, t0 + 0.01, 0.12 + 0.15 * k);
      if (k > 0.4) { ng.gain.setTargetAtTime(amp * 0.7, t0 + 0.18, 0.01); ng.gain.setTargetAtTime(0, t0 + 0.2, 0.1); }
      const m1 = this._osc(sh, 'triangle', rand(120, 160), t0, t0 + dur), m2 = this._osc(sh, 'sine', m1.frequency.value * 2.71, t0, t0 + dur), mg = this._gain(sh, 0);
      m1.connect(mg); m2.connect(mg); mg.connect(sh.out);
      mg.gain.setValueAtTime(0, t0); mg.gain.linearRampToValueAtTime(amp * 0.22, t0 + 0.01); mg.gain.setTargetAtTime(0, t0 + 0.02, 0.4 + 0.3 * k);
    });
  }

  _grounding(k, env) {
    const dur = 1.4 + 2.6 * k, amp = (0.3 + 0.5 * k) * 0.7;
    return this._shot('grounding', { proc: 4, prio: 3, dur, reverb: 0.15 }, (sh, t0) => {
      const src = this._noise(sh, 'brown', t0, t0 + dur, rand(0.7, 0.9));
      const bp = this._bq(sh, 'bandpass', 220, 1.1), g = this._gain(sh, 0);
      src.connect(bp); bp.connect(g); g.connect(sh.out);
      const sub = this._osc(sh, 'sine', 38, t0, t0 + dur), sg = this._gain(sh, 0);
      sub.connect(sg); sg.connect(sh.out);
      const N = Math.max(8, Math.ceil(dur * 60)), cv = new Float32Array(N), cs = new Float32Array(N);
      let r = 0.7;
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1);
        r = clamp(r + (Math.random() - 0.5) * 0.25, 0.3, 1);
        const spike = Math.random() < 0.05 ? 0.6 : 0;
        const shape = Math.min(1, u / 0.03) * (u > 0.7 ? (1 - u) / 0.3 : 1);
        cv[i] = amp * (r + spike) * shape * 3;
        cs[i] = amp * 0.6 * shape;
      }
      cv[N - 1] = 0; cs[N - 1] = 0;
      g.gain.setValueCurveAtTime(cv, t0, dur);
      sg.gain.setValueCurveAtTime(cs, t0, dur);
      bp.frequency.setValueAtTime(180, t0); bp.frequency.linearRampToValueAtTime(rand(260, 340), t0 + dur);
    });
  }

  _creak(k, flavor) {
    const ci = classInfo(this._s.shipCls), env = this._env;
    flavor = flavor || (this._s.docked ? 'rope' : ci.wood ? 'wood' : 'steel');
    const P = { wood: { f: [38, 70], bp: 760, q: 7, d: [0.5, 1.3] }, steel: { f: [18, 32], bp: 300, q: 5, d: [0.8, 2.0] }, rope: { f: [10, 18], bp: 1150, q: 3.5, d: [0.6, 1.4] } }[flavor] || null;
    if (!P) return null;
    const dur = lerp(P.d[0], P.d[1], k) * rand(0.85, 1.15), inside = env.key !== 'deck' && env.key !== 'ashore';
    const amp = (0.08 + 0.18 * k) * (inside ? 1 : 0.6) * 1.6;
    return this._shot('creak-' + flavor, { proc: 2, prio: 0, dur, reverb: env.reverb * 0.6 }, (sh, t0) => {
      const f0 = rand(P.f[0], P.f[1]), o = this._osc(sh, 'sawtooth', f0, t0, t0 + dur);
      const bp = this._bq(sh, 'bandpass', P.bp * rand(0.85, 1.15), P.q), g = this._gain(sh, 0);
      o.connect(bp); bp.connect(g); g.connect(sh.out);
      const N = 32, fc = new Float32Array(N), gc = new Float32Array(N), wob = rand(1, 3);
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1);
        fc[i] = f0 * (1 + 0.25 * Math.sin(u * Math.PI * wob) + (Math.random() - 0.5) * 0.3);
        gc[i] = amp * Math.pow(Math.sin(Math.PI * u), 0.6) * (0.6 + 0.4 * Math.random());
      }
      gc[0] = 0; gc[N - 1] = 0;
      o.frequency.setValueCurveAtTime(fc, t0, dur);
      g.gain.setValueCurveAtTime(gc, t0, dur);
    });
  }

  _splash(k, glass, delay = 0) {
    const dur = 0.5 + 0.9 * k, ek = this._env.key;
    const amp = (0.12 + 0.35 * k) * (ek === 'deck' || ek === 'bridge' || ek === 'ashore' || ek === 'chart' ? 1 : 0.4);
    return this._shot('splash', { proc: 2, prio: 1, dur, delay, reverb: 0.1 }, (sh, t0) => {
      const bp = this._bq(sh, 'bandpass', glass ? 3200 : 2200, 0.7), g = this._gain(sh, 0);
      this._feed(sh, this.noiseW, bp); bp.connect(g); g.connect(sh.out);
      bp.frequency.setValueAtTime(glass ? 3200 : 2200, t0); bp.frequency.exponentialRampToValueAtTime(glass ? 1400 : 520, t0 + dur);
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(amp, t0 + 0.012); g.gain.setTargetAtTime(amp * 0.5, t0 + 0.05, 0.08); g.gain.setTargetAtTime(0, t0 + 0.15, dur * 0.3);
      const lp = this._bq(sh, 'lowpass', 300, 0.7), wg = this._gain(sh, 0);
      this._feed(sh, this.noiseP, lp); lp.connect(wg); wg.connect(sh.out);
      wg.gain.setValueAtTime(0, t0); wg.gain.linearRampToValueAtTime(amp * 1.5 * k, t0 + 0.02); wg.gain.setTargetAtTime(0, t0 + 0.04, 0.12 + 0.2 * k);
    });
  }

  _thunder(k) {
    const near = k > 0.65, dur = rand(4, 7.5) * (0.7 + 0.5 * k), env = this._env;
    const inside = env.key !== 'deck' && env.key !== 'ashore', amp = (0.25 + 0.6 * k) * (inside ? 0.5 : 1);
    return this._shot('thunder', { bus: 'amb', proc: 2, prio: 1, dur, reverb: 0.4 }, (sh, t0) => {
      const src = this._noise(sh, 'brown', t0, t0 + dur, rand(0.8, 1.1));
      const lp = this._bq(sh, 'lowpass', 700, 0.5), g = this._gain(sh, 0);
      src.connect(lp); lp.connect(g); g.connect(sh.out);
      lp.frequency.setValueAtTime(Math.min(near ? 4500 : 700, env.sfxLP), t0);
      lp.frequency.exponentialRampToValueAtTime(110, t0 + dur * 0.7);
      const N = 96, cv = new Float32Array(N), bumps = [];
      const nb = 3 + ((Math.random() * 4) | 0);
      for (let i = 0; i < nb; i++) bumps.push([rand(0.04, 0.6), rand(0.03, 0.12), rand(0.4, 1)]);
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1);
        let v = near && u < 0.03 ? 1.4 * (1 - u / 0.03) : 0;
        for (const [c, w, a] of bumps) v += a * Math.exp(-((u - c) * (u - c)) / (2 * w * w));
        cv[i] = amp * Math.min(v, 1.6) * Math.exp(-u * 2.2) * (0.85 + 0.3 * Math.random()) * 2.2;
      }
      cv[0] = 0; cv[N - 1] = 0;
      g.gain.setValueCurveAtTime(cv, t0, dur);
    });
  }

  _tug(k, env) {
    const pan = rand(-0.7, 0.7);
    this._hornShot('tug-toot', 280 * rand(0.95, 1.05), [[0, 0.45], [0.75, 0.45]], 0.3 * (0.5 + 0.5 * k) * Math.max(env.ships, 0.1), { pan, prio: 3, reverb: 0.3, lp: Math.min(2400, env.sfxLP) });
    // thruster wash churning alongside
    return this._shot('tug-wash', { proc: 2, prio: 1, dur: 2.6, pan, bus: 'amb' }, (sh, t0) => {
      const lp = this._bq(sh, 'lowpass', 500, 0.7), g = this._gain(sh, 0), a = 0.25 * (0.4 + 0.6 * k) * Math.max(env.water, 0.15);
      this._feed(sh, this.noiseP, lp); lp.connect(g); g.connect(sh.out);
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(a, t0 + 0.8); g.gain.setTargetAtTime(0, t0 + 1.6, 0.3);
      sh.end = t0 + 2.6;
    });
  }

  _anchor(k, env) {
    const dur = 2.5 + 3.5 * k, amp = 0.3 * (0.5 + 0.5 * k) * (env.key === 'deck' || env.key === 'bridge' ? 1 : 0.6);
    this._splash(0.6 + 0.3 * k, false, 0.9);
    return this._shot('anchor', { proc: 3, prio: 3, dur: dur + 0.6, reverb: 0.3 }, (sh, t0) => {
      const b1 = this._bq(sh, 'bandpass', 1900, 5), b2 = this._bq(sh, 'bandpass', 520, 2.5), g = this._gain(sh, 0), g2 = this._gain(sh, 0.6);
      this._feed(sh, this.noiseW, b1); this._feed(sh, this.noiseW, b2);
      b1.connect(g); b2.connect(g2); g2.connect(g); g.connect(sh.out);
      // chain links clattering over the gypsy, speeding up as the cable runs out
      const R = 400, N = Math.ceil(dur * R), cv = new Float32Array(N);
      let tl = 0.02;
      while (tl < dur - 0.05) {
        const a = rand(0.5, 1) * amp * 4, i0 = Math.floor(tl * R);
        for (let i = i0; i < N && i < i0 + 30; i++) cv[i] += a * Math.exp(-(i - i0) / (R * 0.012));
        tl += 1 / lerp(9, 18, tl / dur) * rand(0.8, 1.2);
      }
      for (let i = 0; i < N; i++) cv[i] += amp * 0.3;
      cv[0] = 0; cv[N - 1] = 0;
      g.gain.setValueCurveAtTime(cv, t0, dur);
      const o = this._osc(sh, 'sine', 70, t0 + dur, t0 + dur + 0.5), og = this._gain(sh, 0); // brake clunk
      o.connect(og); og.connect(sh.out);
      og.gain.setValueAtTime(0, t0 + dur); og.gain.linearRampToValueAtTime(amp * 0.7, t0 + dur + 0.005); og.gain.setTargetAtTime(0, t0 + dur + 0.01, 0.08);
    });
  }

  _airStart(env) {
    const amp = 0.35 * env.eng;
    return this._shot('air-start', { proc: 1, prio: 1, dur: 1.4 }, (sh, t0) => {
      const bp = this._bq(sh, 'bandpass', 2600, 0.6), g = this._gain(sh, 0);
      this._feed(sh, this.noiseW, bp); bp.connect(g); g.connect(sh.out);
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(amp, t0 + 0.015); g.gain.setValueAtTime(amp, t0 + 0.4); g.gain.setTargetAtTime(0, t0 + 0.4, 0.18);
    });
  }

  _gearClunk(env) {
    const amp = 0.3 * Math.max(env.eng, 0.2);
    return this._shot('gear', { proc: 2, prio: 1, dur: 0.4 }, (sh, t0) => {
      const o = this._osc(sh, 'sine', 95, t0, t0 + 0.35), og = this._gain(sh, 0);
      o.frequency.exponentialRampToValueAtTime(60, t0 + 0.1);
      o.connect(og); og.connect(sh.out);
      og.gain.setValueAtTime(0, t0); og.gain.linearRampToValueAtTime(amp, t0 + 0.004); og.gain.setTargetAtTime(0, t0 + 0.006, 0.05);
      const bp = this._bq(sh, 'bandpass', 900, 2), ng = this._gain(sh, 0);
      this._feed(sh, this.noiseW, bp); bp.connect(ng); ng.connect(sh.out);
      ng.gain.setValueAtTime(0, t0); ng.gain.linearRampToValueAtTime(amp * 0.6, t0 + 0.002); ng.gain.setTargetAtTime(0, t0 + 0.004, 0.015);
    });
  }

  _telegraph(env) {
    const amp = 0.14 * (env.key === 'bridge' || env.key === 'engine' || env.key === 'chart' ? 1 : 0.3);
    return this._shot('telegraph', { proc: 2, prio: 1, dur: 1.2, reverb: 0.2 }, (sh, t0) => {
      const o1 = this._osc(sh, 'sine', 1880, t0, t0 + 1.1), o2 = this._osc(sh, 'sine', 1880 * 2.65, t0, t0 + 1.1), g = this._gain(sh, 0), g2 = this._gain(sh, 0.35);
      o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(sh.out);
      g.gain.setValueAtTime(0, t0);
      for (const ts of [0, 0.16]) { g.gain.setTargetAtTime(amp, t0 + ts, 0.001); g.gain.setTargetAtTime(0, t0 + ts + 0.004, 0.18); }
    });
  }

  // harbour: container / crane clangs far across the basin
  _clank(he, env) {
    const d = rand(120, 900), amp = (0.5 * he) / (1 + d / 150);
    return this._shot('clank', { bus: 'amb', proc: 4, prio: 0, dur: 1.6, pan: rand(-0.9, 0.9), reverb: 0.5 }, (sh, t0) => {
      const lp = this._bq(sh, 'lowpass', Math.min(env.sfxLP, 600 + 3000 / (1 + d / 200)), 0.7);
      lp.connect(sh.out);
      const f = rand(150, 380), o1 = this._osc(sh, 'sine', f, t0, t0 + 1.5), o2 = this._osc(sh, 'sine', f * 2.76 * rand(0.98, 1.02), t0, t0 + 1.5), g = this._gain(sh, 0);
      o1.connect(g); o2.connect(g); g.connect(lp);
      const tau = rand(0.15, 0.35), twice = Math.random() < 0.4;
      g.gain.setValueAtTime(0, t0);
      for (const [ts, a] of twice ? [[0, 1], [0.26, 0.6]] : [[0, 1]]) { g.gain.setTargetAtTime(amp * a, t0 + ts, 0.001); g.gain.setTargetAtTime(0, t0 + ts + 0.004, tau); }
      const ng = this._gain(sh, 0);
      this._feed(sh, this.noiseP, ng); ng.connect(lp);
      ng.gain.setValueAtTime(0, t0); ng.gain.setTargetAtTime(amp * 1.5, t0, 0.001); ng.gain.setTargetAtTime(0, t0 + 0.004, 0.01);
    });
  }

  _beeps(he, env) {
    const d = rand(200, 700), amp = (0.12 * he) / (1 + d / 200), n = 4 + ((Math.random() * 5) | 0);
    return this._shot('reversing-beeps', { bus: 'amb', proc: 3, prio: 0, dur: n * 0.84 + 0.2, pan: rand(-0.9, 0.9), reverb: 0.4 }, (sh, t0) => {
      const o = this._osc(sh, 'sine', 1040 * rand(0.97, 1.03), t0, t0 + n * 0.84 + 0.1), lp = this._bq(sh, 'lowpass', Math.min(env.sfxLP, 3000), 0.7), g = this._gain(sh, 0);
      o.connect(g); g.connect(lp); lp.connect(sh.out);
      for (let i = 0; i < n; i++) { const a = t0 + i * 0.84; g.gain.setValueAtTime(0, a); g.gain.linearRampToValueAtTime(amp, a + 0.01); g.gain.setValueAtTime(amp, a + 0.41); g.gain.linearRampToValueAtTime(0, a + 0.42); }
    });
  }

  // halyards slapping aluminium masts in the marina
  _halyard(he) {
    const f = rand(2400, 3600), amp = 0.05 * he;
    return this._shot('halyard', { bus: 'amb', proc: 3, prio: 0, dur: 1.6, pan: rand(-0.8, 0.8), reverb: 0.3 }, (sh, t0) => {
      const o1 = this._osc(sh, 'sine', f, t0, t0 + 1.55), o2 = this._osc(sh, 'sine', f * 2.4, t0, t0 + 1.55), g = this._gain(sh, 0), g2 = this._gain(sh, 0.4);
      o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(sh.out);
      g.gain.setValueAtTime(0, t0);
      let t = 0;
      const n = 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) { g.gain.setTargetAtTime(amp * rand(0.5, 1), t0 + t, 0.001); g.gain.setTargetAtTime(0, t0 + t + 0.003, 0.06); t += rand(0.15, 0.45); }
    });
  }

  // gulls: a herring-gull "kyow" series on the persistent gull voice (no new nodes)
  _gullCall() {
    const v = this.v.gulls;
    if (!v) return;
    const now = this.ctx.currentTime;
    if (now < v.busy) return;
    const d = rand(25, 260), amp = clamp(0.5 / (1 + d / 50), 0.03, 0.4) * 0.35;
    let t = now + 0.03;
    const base = rand(780, 1150), n = 1 + ((Math.random() * 4) | 0);
    if (v.pan) v.pan.pan.setValueAtTime(rand(-0.85, 0.85), t);
    v.bp.frequency.setValueAtTime(Math.min(this._env.sfxLP, lerp(2600, 1500, d / 260)), t);
    for (let i = 0; i < n; i++) {
      const len = rand(0.2, 0.38) * (i === 0 ? 1.25 : 1), N = 24, curve = new Float32Array(N), peak = rand(1.3, 1.6), pk = rand(0.2, 0.35);
      for (let j = 0; j < N; j++) {
        const u = j / (N - 1);
        const shp = u < pk ? lerp(1, peak, Math.sin(((u / pk) * Math.PI) / 2)) : lerp(peak, 0.78, (u - pk) / (1 - pk));
        curve[j] = base * shp * (1 + (Math.random() - 0.5) * 0.04);
      }
      v.A.frequency.setValueCurveAtTime(curve, t, len);
      const g = v.call.gain;
      g.setValueAtTime(0, t); g.linearRampToValueAtTime(amp, t + 0.025); g.linearRampToValueAtTime(amp * 0.7, t + len * 0.5); g.linearRampToValueAtTime(0, t + len);
      t += len + rand(0.06, 0.2);
    }
    v.busy = t + 0.1;
  }
}

SoundEngine._all = [];

export default SoundEngine;
