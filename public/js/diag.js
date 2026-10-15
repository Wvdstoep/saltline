// In-game diagnostics (phones have no console): ?diag=1 or More → Diagnostics. Shows the GPU, WebGL version and limits,
// the depth buffer, the sea shader tier chosen and why, the wake simulation, the frame-rate governor and every
// console.error / console.warn / uncaught error captured since this module loaded (it must be imported first), with a
// Copy button so a screenshot or a pasted text can be sent from the phone.
const LOG = [];
const MAX = 120;
function push(kind, args) {
  try {
    const text = args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : safeJson(a))).join(' ').slice(0, 1500);
    const last = LOG[LOG.length - 1];
    if (last && last.text === text && last.kind === kind) { last.n++; return; }
    LOG.push({ kind, text, t: Math.round(performance.now() / 100) / 10, n: 1 });
    if (LOG.length > MAX) LOG.splice(0, LOG.length - MAX);
  } catch { /* never break the console */ }
}
function safeJson(a) { try { return JSON.stringify(a, (k, v) => (v && v.isTexture ? '[texture]' : v), 0)?.slice(0, 400) ?? String(a); } catch { return String(a); } }
export function hookConsole() {
  if (globalThis.__saltlineDiagHooked) return;
  globalThis.__saltlineDiagHooked = true;
  const e = console.error.bind(console), w = console.warn.bind(console);
  console.error = (...a) => { push('error', a); e(...a); };
  console.warn = (...a) => { push('warn', a); w(...a); };
  addEventListener('error', (ev) => push('error', ['uncaught: ' + (ev.message || ev.error || ev)]));
  addEventListener('unhandledrejection', (ev) => push('error', ['unhandled promise: ' + (ev.reason?.stack || ev.reason)]));
}
hookConsole();

/** Build the diagnostics report (plain object + text). app = the game App (renderer, ocean, skySys, qGov). */
export function diagReport(app) {
  const r = app?.renderer, o = app?.ocean;
  const out = { at: new Date().toISOString(), url: location.href, ua: navigator.userAgent, screen: `${innerWidth}x${innerHeight} dpr ${devicePixelRatio}`, touch: matchMedia?.('(pointer: coarse)')?.matches ?? null };
  try {
    const gl = r?.getContext?.();
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      out.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      out.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      out.webgl = gl.getParameter(gl.VERSION);
      out.glsl = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
      out.depthBits = gl.getParameter(gl.DEPTH_BITS); out.stencilBits = gl.getParameter(gl.STENCIL_BITS);
      out.colorBits = [gl.getParameter(gl.RED_BITS), gl.getParameter(gl.GREEN_BITS), gl.getParameter(gl.BLUE_BITS), gl.getParameter(gl.ALPHA_BITS)].join('/');
      out.drawingBuffer = `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`;
      out.contextLost = gl.isContextLost();
      const ext = gl.getSupportedExtensions() || [];
      out.ext = { colorBufferFloat: ext.includes('EXT_color_buffer_float'), colorBufferHalfFloat: ext.includes('EXT_color_buffer_half_float'), textureFloatLinear: ext.includes('OES_texture_float_linear'), derivatives: ext.includes('OES_standard_derivatives') || out.webgl?.includes('WebGL 2'), elementIndexUint: ext.includes('OES_element_index_uint') || out.webgl?.includes('WebGL 2') };
    }
    const c = r?.capabilities;
    if (c) out.caps = { webgl2: c.isWebGL2, precision: c.precision, maxFragmentUniforms: c.maxFragmentUniforms, maxVertexUniforms: c.maxVertexUniforms, maxVaryings: c.maxVaryings, maxTextures: c.maxTextures, maxVertexTextures: c.maxVertexTextures, maxTextureSize: c.maxTextureSize, maxAttributes: c.maxAttributes, floatFragmentTextures: c.floatFragmentTextures, floatVertexTextures: c.floatVertexTextures };
    if (r) { out.pixelRatio = r.getPixelRatio(); out.programs = r.info?.programs?.length; out.render = r.info?.render ? { calls: r.info.render.calls, triangles: r.info.render.triangles } : null; }
    if (r?.info?.programs) out.brokenPrograms = r.info.programs.filter((p) => p.diagnostics && p.diagnostics.runnable === false).map((p) => (p.name || '?') + ': ' + (p.diagnostics.programLog || p.diagnostics.fragmentShader?.log || p.diagnostics.vertexShader?.log || '').slice(0, 300));
  } catch (e) { out.glError = String(e); }
  try { out.ocean = o?.diag ? o.diag() : (o ? { note: 'ocean has no diag()' } : null); } catch (e) { out.ocean = { error: String(e) }; }
  try { out.sky = app?.skySys ? { tier: app.skySys.tier, env: !!app.scene?.environment, envOn: app.skySys.envOn } : null; } catch { /* optional */ }
  try { out.lighting = app?.lighting?.diag ? app.lighting.diag() : { note: app?.lighting === null ? 'lighting failed to start (see console)' : 'no lighting module' }; } catch (e) { out.lighting = { error: String(e) }; }
  try { out.fps = app?.qGov ? Math.round(1 / app.qGov.ema) : null; } catch { /* optional */ }
  out.log = LOG.map((l) => `${l.t}s ${l.kind}${l.n > 1 ? ' x' + l.n : ''}: ${l.text}`);
  return out;
}
export function diagText(rep) {
  const lines = [];
  const kv = (k, v) => lines.push(`${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`);
  for (const k of ['at', 'url', 'ua', 'screen', 'touch', 'gpu', 'vendor', 'webgl', 'glsl', 'depthBits', 'stencilBits', 'colorBits', 'drawingBuffer', 'contextLost', 'pixelRatio', 'fps', 'programs', 'render', 'ext', 'caps', 'brokenPrograms', 'sky', 'glError']) if (rep[k] !== undefined) kv(k, rep[k]);
  lines.push('--- ocean');
  if (rep.ocean) for (const [k, v] of Object.entries(rep.ocean)) kv(k, v);
  lines.push('--- lighting');
  if (rep.lighting) for (const [k, v] of Object.entries(rep.lighting)) kv(k, v);
  lines.push(`--- console (${rep.log.length})`);
  for (const l of rep.log) lines.push(l);
  return lines.join('\n');
}

/** Wire the panel: a More-menu button (#btnDiag, if present), ?diag=1 opens it at once, window.saltlineDiag() returns the report. */
export function installDiag(app) {
  let panel = null, timer = null;
  const render = () => { if (!panel) return; const pre = panel.querySelector('pre'); if (pre) pre.textContent = diagText(diagReport(app)); };
  const open = () => {
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'diagPanel';
      panel.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(8,12,18,0.96);color:#dfe7ee;font:12px/1.35 ui-monospace,Menlo,Consolas,monospace;display:flex;flex-direction:column;';
      panel.innerHTML = '<div style="display:flex;gap:8px;padding:10px 12px;align-items:center;border-bottom:1px solid #345"><b style="flex:1">Diagnostics</b><button id="diagCopy" style="font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #6a8;background:#1d3b2a;color:#cfe">Copy</button><button id="diagRefresh" style="font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #567;background:#223;color:#cde">Refresh</button><button id="diagClose" style="font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #765;background:#322;color:#edc">Close</button></div><pre style="flex:1;margin:0;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word;-webkit-user-select:text;user-select:text"></pre>';
      document.body.appendChild(panel);
      panel.querySelector('#diagClose').onclick = close;
      panel.querySelector('#diagRefresh').onclick = render;
      panel.querySelector('#diagCopy').onclick = async () => {
        const text = diagText(diagReport(app)), b = panel.querySelector('#diagCopy');
        try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch {
          try { const pre = panel.querySelector('pre'); const sel = getSelection(), rg = document.createRange(); rg.selectNodeContents(pre); sel.removeAllRanges(); sel.addRange(rg); document.execCommand('copy'); b.textContent = 'Copied'; } catch { b.textContent = 'Select & copy by hand'; }
        }
        setTimeout(() => { b.textContent = 'Copy'; }, 2000);
      };
    }
    panel.style.display = 'flex';
    render();
    clearInterval(timer); timer = setInterval(render, 3000);
  };
  const close = () => { if (panel) panel.style.display = 'none'; clearInterval(timer); timer = null; };
  const btn = document.getElementById('btnDiag');
  if (btn) btn.addEventListener('click', () => { document.getElementById('moreSheet')?.classList.remove('open'); open(); });
  window.saltlineDiag = () => diagReport(app);
  try { if (new URLSearchParams(location.search).get('diag') === '1') setTimeout(open, 1500); } catch { /* no URL API */ }
  return { open, close, report: () => diagReport(app) };
}
