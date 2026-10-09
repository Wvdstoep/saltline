// VHF radio sound effects (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §6.6, lane B): its own WebAudio graph (sound.js untouched).
//   squelchOpen()  short click + noise burst as the carrier comes up
//   bed(q, s)      band-passed noise (300–3,000 Hz) at a level (1 − q) while a transmission plays
//   tail()         the squelch tail on release: a 120 ms noise burst
//   pip()          1 kHz "roger" pip when an operator ends
//   speak(...)     optional browser speechSynthesis (cannot go through WebAudio; the bed plays alongside)
// Everything is a no-op until unlock() ran inside a user gesture, and when WebAudio is missing (Node, old browsers).
import { hash32 } from '../../shared/vhf.js';

export class RadioSound {
  constructor({ volume = 0.8, voices = true } = {}) {
    this.ctx = null; this.out = null; this.noise = null; this.vol = volume; this.voices = voices; this.muted = false;
    this.bedNode = null; this.log = [];      // the harness reads `log` to check what played
  }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume?.(); return true; }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
      this.out = this.ctx.createGain(); this.out.gain.value = this.vol; this.out.connect(this.ctx.destination);
      // 2 s of white noise, looped by every noise source
      const n = this.ctx.sampleRate * 2, buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
      let s = 0x2545F491; for (let i = 0; i < n; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; d[i] = ((s >>> 0) / 4294967296) * 2 - 1; }
      this.noise = buf;
      return true;
    } catch { this.ctx = null; return false; }
  }
  setVolume(v) { this.vol = Math.max(0, Math.min(1, v)); if (this.out) this.out.gain.value = this.muted ? 0 : this.vol; }
  setMuted(m) { this.muted = !!m; this.setVolume(this.vol); if (m) this.stopBed(); }
  _noise(gain, dur, { lo = 300, hi = 3000, at = 0 } = {}) {
    const c = this.ctx; if (!c || this.muted) return null;
    const t0 = c.currentTime + at;
    const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = lo;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = hi;
    const g = c.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    if (dur != null) { g.gain.setValueAtTime(gain, t0 + Math.max(0.01, dur - 0.03)); g.gain.linearRampToValueAtTime(0, t0 + dur); }
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(this.out);
    src.start(t0, Math.random() * 1.5); if (dur != null) src.stop(t0 + dur + 0.02);
    return { src, g };
  }
  _tone(freq, dur, gain = 0.18, at = 0) {
    const c = this.ctx; if (!c || this.muted) return;
    const t0 = c.currentTime + at, o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.005); g.gain.setValueAtTime(gain, t0 + dur - 0.01); g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(g); g.connect(this.out); o.start(t0); o.stop(t0 + dur + 0.02);
  }
  squelchOpen() { this.log.push('squelch'); this._tone(2400, 0.012, 0.12); this._noise(0.32, 0.06, { lo: 500, hi: 4000 }); }
  /** Noise bed while a transmission plays: level (1 − q), at least a faint hiss so the channel sounds live. */
  bed(q, seconds) {
    this.log.push(`bed:${(1 - q).toFixed(2)}`);
    this.stopBed();
    const lvl = 0.03 + 0.3 * Math.max(0, Math.min(1, 1 - q));
    this.bedNode = this._noise(lvl, seconds);
  }
  stopBed() { try { this.bedNode?.src.stop(); } catch { /* already stopped */ } this.bedNode = null; }
  tail() { this.log.push('tail'); this._noise(0.4, 0.12, { lo: 400, hi: 3500 }); }
  pip() { this.log.push('pip'); this._tone(1000, 0.12, 0.16); }
  /** Local PTT click (own transmission). */
  key() { this.log.push('key'); this._tone(1800, 0.01, 0.1); }
  /** DSC alarm: alternating two-tone for ~2 s. */
  alarm() { this.log.push('alarm'); for (let i = 0; i < 8; i++) this._tone(i % 2 ? 2200 : 1300, 0.22, 0.14, i * 0.25); }
  /** Optional voice. Voice and rate seeded by the station id; Dutch voice for Dutch lines. */
  speak(text, { lang = 'en', seed = '' } = {}) {
    const ss = globalThis.speechSynthesis;
    if (!this.voices || this.muted || !ss || !globalThis.SpeechSynthesisUtterance || !text) return false;
    try {
      const u = new SpeechSynthesisUtterance(text.replace(/·/g, ' '));
      const tag = lang === 'nl' ? 'nl' : 'en';
      const vs = (ss.getVoices?.() || []).filter((v) => String(v.lang || '').toLowerCase().startsWith(tag));
      const h = hash32(seed);
      if (vs.length) u.voice = vs[h % vs.length];
      u.lang = lang === 'nl' ? 'nl-NL' : 'en-GB';
      u.rate = 0.95 + (h % 16) / 100; u.pitch = 0.85 + ((h >>> 4) % 30) / 100; u.volume = this.vol;
      ss.speak(u);
      return true;
    } catch { return false; }
  }
}
