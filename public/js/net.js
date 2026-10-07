// WebSocket client: hello/welcome handshake, 10 Hz state upload, actions, chat, latency ping, auto-reconnect.
// v0.3: `fetchPatch(id)` binary helper for the harbour patch route (decoding lives in harborgeom.js).
const TOKEN_KEY = 'saltline.token';

export class Net {
  constructor(handlers) {
    this.h = handlers;
    this.ws = null;
    this.connected = false;
    this.latency = 0;
    this.name = '';
    this.lastStateSent = 0;
    this.reconnectDelay = 1000;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.reconnects = 0;
  }
  get token() { try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; } }
  set token(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch {} }

  connect(name) {
    this.name = name;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return; // already connecting / connected
    clearTimeout(this.reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      const wasReconnect = this.reconnects > 0 || this.everConnected;
      this.connected = true; this.reconnectDelay = 1000; this.everConnected = true;
      this.h.status?.('connected');
      // main.js re-sends `hello` from its status handler once started; `onReconnect` is an optional extra hook
      if (wasReconnect) this.h.onReconnect?.();
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 5000);
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'welcome') { this.token = m.token; }
      if (m.t === 'pong') { this.latency = Math.round(performance.now() - m.c); return; }
      this.h.message?.(m);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // a newer socket superseded this one
      this.connected = false; clearInterval(this.pingTimer);
      this.h.status?.(ev.code === 4001 ? 'replaced' : 'disconnected');
      if (ev.code !== 4001) { this.reconnects++; this.reconnectTimer = setTimeout(() => this.connect(this.name), this.reconnectDelay = Math.min(15000, this.reconnectDelay * 1.6)); }
    };
    ws.onerror = () => {};
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  sendState(s) {
    const now = performance.now();
    if (now - this.lastStateSent < 95) return;
    this.lastStateSent = now;
    this.send({ t: 'state', lat: s.lat, lon: s.lon, hdg: s.hdg, spd: s.spd, throttle: s.throttle, rudder: s.rudder });
  }
  // Envelope fields go last so an extra payload field can never clobber `t` / `action`.
  action(action, extra = {}) { this.send({ ...extra, t: 'action', action }); }
  chat(text) { this.send({ t: 'chat', text }); }
  /** Binary harbour patch (§1 layout). Resolves to an ArrayBuffer, or null on 404 (harbour not built yet). Throws on network errors. */
  async fetchPatch(id) {
    const r = await fetch(`/api/harbor/${encodeURIComponent(id)}/patch`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`patch ${id}: HTTP ${r.status}`);
    return r.arrayBuffer();
  }
  /** Geometry JSON of a harbour, or null on 404. */
  async fetchGeom(id) {
    const r = await fetch(`/api/harbor/${encodeURIComponent(id)}/geom`, { headers: { Accept: 'application/json' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`geom ${id}: HTTP ${r.status}`);
    return r.json();
  }
}
