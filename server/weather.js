// STUB — replaced by agent S2 (docs/V3-CONTRACTS.md §2).
export class WeatherService {
  constructor(opts = {}) { this.log = opts.log || (() => {}); this.enabled = process.env.SALTLINE_OFFLINE !== '1'; this.cells = new Map(); }
  sample(lat, lon) { return null; }
  request(lat, lon) {}
  tick() {}
  stats() { return { cells: 0, inflight: 0, failures: 0, enabled: this.enabled }; }
}
