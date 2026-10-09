// Memory guard: keeps the process inside its container memory limit (the pod was OOM-killed at 1 GiB with world tiles
// on). Reads the limit once (cgroup v2 memory.max → cgroup v1 limit_in_bytes → os.totalmem; SALTLINE_MEM_LIMIT_MB
// overrides), samples rss every 2 s and maps rss / limit to a level:
//
//   ok        < 50 %   everything runs, background warm-up (P4) and the harbour rebuild included
//   warm      ≥ 50 %   no background warm-up / harbour rebuild (they only start below 50 %)
//   pause     ≥ 65 %   also P3 prefetch (offline ships) paused, queued P3/P4 work dropped
//   shed      ≥ 75 %   also decoded tiles / harbour patches not near an online ship dropped, global.gc() if exposed
//   critical  ≥ 85 %   all tile fetching stopped except P0 (tiles a client / ship in view is waiting for)
//
// Going down needs `hysteresis` (3 %) below the threshold so the level does not flap. Shed handlers run on entering
// shed / critical and again every `reshedMs` while it stays there. Transitions are logged. Never throws.
import fs from 'node:fs';
import os from 'node:os';

export const LEVEL = { ok: 0, warm: 1, pause: 2, shed: 3, critical: 4 };
export const LEVEL_NAMES = ['ok', 'warm', 'pause', 'shed', 'critical'];
/** Lower bound (fraction of the limit) of each level above ok. */
export const THRESHOLDS = [0, 0.5, 0.65, 0.75, 0.85];
const HUGE = 2 ** 60;

/**
 * Container memory limit in bytes and where it came from. `read(path)` returns the file text or throws (injectable).
 * A cgroup "max" or an absurd v1 value (no limit) falls through to the machine's memory.
 */
export function readMemLimit({ env = process.env, read = (p) => fs.readFileSync(p, 'utf8'), totalmem = os.totalmem } = {}) {
  const mb = Number(env.SALTLINE_MEM_LIMIT_MB);
  if (Number.isFinite(mb) && mb > 0) return { bytes: Math.round(mb * 1048576), source: 'env' };
  const tot = totalmem();
  for (const [p, src] of [['/sys/fs/cgroup/memory.max', 'cgroup2'], ['/sys/fs/cgroup/memory/memory.limit_in_bytes', 'cgroup1']]) {
    try {
      const s = String(read(p)).trim();
      if (!/^\d+$/.test(s)) continue;                     // "max" = unlimited
      const v = Number(s);
      if (v > 0 && v < HUGE && v < tot * 4) return { bytes: Math.min(v, tot), source: src };
    } catch { /* not in a cgroup / not readable */ }
  }
  return { bytes: tot, source: 'totalmem' };
}

/** Level for `frac` (rss / limit), given the previous level (hysteresis applies on the way down only). */
export function levelFor(frac, prev = LEVEL.ok, hysteresis = 0.03) {
  let up = LEVEL.ok;
  for (let l = THRESHOLDS.length - 1; l > 0; l--) if (frac >= THRESHOLDS[l]) { up = l; break; }
  if (up >= prev) return up;
  // going down: stay at the highest level whose threshold is still within the hysteresis band
  let l = prev;
  while (l > up && frac < THRESHOLDS[l] - hysteresis) l--;
  return l;
}

/**
 * createMemGuard({ limitBytes, sample () → rss bytes, intervalMs 2000, log, gc, now, reshedMs 30 s, hysteresis }) →
 * { level(), name(), frac(), limitBytes, tick(), start(), stop(), onShed(fn), onLevel(fn), allowBackground(),
 *   allowPrio(prio), stats() }
 */
export function createMemGuard(opts = {}) {
  const lim = opts.limitBytes ? { bytes: opts.limitBytes, source: 'opts' } : readMemLimit(opts);
  const limitBytes = lim.bytes;
  const sample = opts.sample || (() => process.memoryUsage().rss);
  const log = opts.log || (() => {});
  const now = opts.now || Date.now;
  const gc = opts.gc !== undefined ? opts.gc : typeof globalThis.gc === 'function' ? () => globalThis.gc() : null;
  const reshedMs = opts.reshedMs ?? 30_000, hysteresis = opts.hysteresis ?? 0.03;
  const shedFns = [], levelFns = [];
  let level = LEVEL.ok, rss = 0, peak = 0, timer = null, lastShed = 0, since = now();
  const st = { samples: 0, transitions: 0, sheds: 0, gcs: 0, timeAt: [0, 0, 0, 0, 0] };
  let lastSampleAt = now();

  function shed(why) {
    lastShed = now(); st.sheds++;
    const near = level >= LEVEL.critical ? 'critical' : 'shed';
    for (const fn of shedFns) { try { fn({ level, why, mode: near }); } catch (e) { try { log('[mem] shed handler failed', e?.message || e); } catch { /* never */ } } }
    if (gc) { try { gc(); st.gcs++; } catch { /* not exposed */ } }
  }
  function tick() {
    try {
      const t = now();
      st.timeAt[level] += Math.max(0, t - lastSampleAt); lastSampleAt = t;
      rss = Number(sample()) || 0; st.samples++;
      if (rss > peak) peak = rss;
      const prev = level, next = levelFor(rss / limitBytes, prev, hysteresis);
      if (next !== prev) {
        level = next; since = t; st.transitions++;
        try { log(`[mem] ${LEVEL_NAMES[prev]} → ${LEVEL_NAMES[next]}: rss ${Math.round(rss / 1048576)} MB of ${Math.round(limitBytes / 1048576)} MB (${Math.round((rss / limitBytes) * 100)} %)`); } catch { /* never */ }
        for (const fn of levelFns) { try { fn(next, prev); } catch { /* listener errors stay there */ } }
        if (next >= LEVEL.shed && next > prev) shed('enter');
      } else if (level >= LEVEL.shed && t - lastShed >= reshedMs) shed('still');
    } catch { /* never */ }
    return level;
  }
  const g = {
    limitBytes, limitSource: lim.source,
    level: () => level, name: () => LEVEL_NAMES[level], frac: () => (limitBytes ? rss / limitBytes : 0), rss: () => rss,
    tick,
    start() { if (!timer) { tick(); timer = setInterval(tick, opts.intervalMs ?? 2000); timer.unref?.(); } return g; },
    stop() { if (timer) clearInterval(timer); timer = null; },
    onShed(fn) { if (typeof fn === 'function') shedFns.push(fn); return g; },
    onLevel(fn) { if (typeof fn === 'function') levelFns.push(fn); return g; },
    /** Background warm-up / harbour rebuild may start (rss < 50 %). */
    allowBackground: () => level === LEVEL.ok,
    /** May a tile request at `prio` (0 = P0 … 4 = P4) start new work at the current level? */
    allowPrio(prio) {
      if (level >= LEVEL.critical) return prio <= 0;
      if (level >= LEVEL.pause) return prio <= 2;
      if (level >= LEVEL.warm) return prio <= 3;
      return true;
    },
    stats: () => ({ level: LEVEL_NAMES[level], rssMB: Math.round(rss / 1048576), peakMB: Math.round(peak / 1048576), limitMB: Math.round(limitBytes / 1048576), limitSource: lim.source, pct: limitBytes ? Math.round((rss / limitBytes) * 1000) / 10 : 0, sinceS: Math.round((now() - since) / 1000), gcExposed: !!gc, ...st, timeAt: Object.fromEntries(LEVEL_NAMES.map((n, i) => [n, Math.round(st.timeAt[i] / 1000)])) }),
  };
  return g;
}

/** A guard that never restricts anything (tests, tools). */
export function noGuard() {
  return { limitBytes: Infinity, level: () => 0, name: () => 'ok', frac: () => 0, rss: () => 0, tick: () => 0, start() { return this; }, stop() {}, onShed() { return this; }, onLevel() { return this; }, allowBackground: () => true, allowPrio: () => true, stats: () => ({ level: 'ok', disabled: true }) };
}
