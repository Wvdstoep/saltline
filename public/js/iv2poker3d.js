// Saltline Casino — Realistic 3D Texas Hold'em Poker
// Photorealistic PBR poker table, real-time lighting, physical cards & chip stacks,
// live sync with server/casino.js WebSocket protocol. Fullscreen 3D immersive view.
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { money, h, T } from './iv2casinoui.js';

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_GLYPHS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const GUEST_NAMES = ['You', 'Anna', 'Ben', 'Carla'];

function cardInfo(c) {
  if (typeof c !== 'number' || c < 0 || c > 51) return null;
  const r = c % 13, s = Math.floor(c / 13);
  return { rank: RANKS[r], suit: SUITS[s], glyph: SUIT_GLYPHS[SUITS[s]], red: SUITS[s] === 'H' || SUITS[s] === 'D' };
}

// ----------------------------------------------------------------------------- Synthesized Casino Sound Effects
const audioCtx = typeof AudioContext !== 'undefined' ? new AudioContext() : null;
function playSound(type = 'chip') {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const t = audioCtx.currentTime;
  if (type === 'card') {
    // Crisp card flick/swish
    const node = audioCtx.createBufferSource();
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.08, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (audioCtx.sampleRate * 0.018));
    node.buffer = buf;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.setValueAtTime(2200, t); filter.Q.setValueAtTime(1.5, t);
    node.connect(filter); filter.connect(audioCtx.destination);
    node.start(t);
  } else if (type === 'chip') {
    // High-end ceramic chip click
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(3200 + Math.random() * 800, t);
    osc.frequency.exponentialRampToValueAtTime(1200, t + 0.05);
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(t); osc.stop(t + 0.06);
  } else if (type === 'win') {
    // Golden chime chord
    [523.25, 659.25, 783.99, 1046.50].forEach((freq, idx) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t + idx * 0.06);
      gain.gain.setValueAtTime(0.18, t + idx * 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.06 + 0.6);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start(t + idx * 0.06); osc.stop(t + idx * 0.06 + 0.65);
    });
  }
}

// ----------------------------------------------------------------------------- 3D Card & Material Factories
function canvasTex(w, h, draw, maxAniso = 8) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.anisotropy = maxAniso; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const cardBackTex = canvasTex(512, 716, (x, w, h) => {
  x.fillStyle = '#6e111d'; x.fillRect(0, 0, w, h);
  x.strokeStyle = '#d4af37'; x.lineWidth = 14; x.strokeRect(16, 16, w - 32, h - 32);
  x.strokeStyle = '#8f721e'; x.lineWidth = 3;
  for (let i = 0; i < 40; i++) {
    x.beginPath(); x.moveTo(16, 16 + i * 20); x.lineTo(16 + i * 20, 16); x.stroke();
    x.beginPath(); x.moveTo(w - 16, h - 16 - i * 20); x.lineTo(w - 16 - i * 20, h - 16); x.stroke();
  }
  x.fillStyle = '#f3dc8e'; x.font = 'bold 130px Georgia, serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('S', w / 2, h / 2);
});

const faceCache = new Map();
function cardFaceTex(rank, suit) {
  const key = rank + suit;
  if (faceCache.has(key)) return faceCache.get(key);
  const t = canvasTex(512, 716, (x, w, h) => {
    x.fillStyle = '#faf8f2'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#222222'; x.lineWidth = 4; x.strokeRect(12, 12, w - 24, h - 24);
    x.strokeStyle = '#dfd5bf'; x.lineWidth = 2; x.strokeRect(18, 18, w - 36, h - 36);

    const red = suit === 'H' || suit === 'D';
    x.fillStyle = red ? '#b91522' : '#111317';
    x.font = 'bold 112px "Segoe UI",Arial,sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(rank, 74, 96);
    x.font = '92px "Segoe UI Symbol","DejaVu Sans",Arial,sans-serif';
    x.fillText(SUIT_GLYPHS[suit], 74, 196);

    x.font = '270px "Segoe UI Symbol","DejaVu Sans",Arial,sans-serif';
    x.fillText(SUIT_GLYPHS[suit], w / 2, h / 2 + 10);

    x.save(); x.translate(w, h); x.rotate(Math.PI);
    x.font = 'bold 112px "Segoe UI",Arial,sans-serif'; x.fillText(rank, 74, 96);
    x.font = '92px "Segoe UI Symbol","DejaVu Sans",Arial,sans-serif'; x.fillText(SUIT_GLYPHS[suit], 74, 196);
    x.restore();
  });
  faceCache.set(key, t);
  return t;
}

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0);
  s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5); return s;
}

const CARD_W = 0.138, CARD_H = 0.194;
const cardGeo = (() => {
  const g = new THREE.ExtrudeGeometry(roundedRectShape(CARD_W, CARD_H, 0.009), { depth: 0.002, bevelEnabled: false, curveSegments: 6 });
  const uv = g.attributes.uv, pos = g.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + CARD_W / 2) / CARD_W, (pos.getY(i) + CARD_H / 2) / CARD_H);
  return g;
})();
const cardEdgeMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 });

const TABLE_Y = 0.78;

// Chip materials
const CHIP_COLS = { red: '#b3202a', black: '#18181c', blue: '#1d52a8', green: '#1c8048', white: '#e9e5d8', gold: '#c9a24a' };
const chipMats = {};
function chipMat(name) {
  if (chipMats[name]) return chipMats[name];
  const col = CHIP_COLS[name] || CHIP_COLS.red;
  const side = canvasTex(512, 64, (x, w, h) => { x.fillStyle = col; x.fillRect(0, 0, w, h); x.fillStyle = '#f4efe2'; for (let i = 0; i < 12; i++) x.fillRect(i * w / 12, 0, w / 24, h); });
  side.wrapS = THREE.RepeatWrapping;
  const top = canvasTex(256, 256, (x) => {
    x.fillStyle = col; x.fillRect(0, 0, 256, 256); x.fillStyle = '#f4efe2';
    for (let i = 0; i < 8; i++) { x.save(); x.translate(128, 128); x.rotate(i * Math.PI / 4); x.fillRect(-15, -128, 30, 36); x.restore(); }
    x.strokeStyle = '#f4efe2'; x.lineWidth = 5; x.beginPath(); x.arc(128, 128, 88, 0, 7); x.stroke();
    x.fillStyle = 'rgba(255,255,255,.12)'; x.beginPath(); x.arc(128, 128, 70, 0, 7); x.fill(); x.stroke();
    x.fillStyle = '#f4efe2'; x.font = 'bold 56px Georgia, serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('S', 128, 132);
  });
  const mk = (map) => new THREE.MeshPhysicalMaterial({ map, roughness: 0.38, clearcoat: 0.35, clearcoatRoughness: 0.4, envMapIntensity: 0.4 });
  chipMats[name] = [mk(side), mk(top), mk(top)];
  return chipMats[name];
}
const chipGeo = new THREE.CylinderGeometry(0.026, 0.026, 0.015, 36);
let chipSeed = 11;
const rnd = () => (chipSeed = (chipSeed * 16807) % 2147483647) / 2147483647;
function makeChipStack(x, z, name, count, y0 = TABLE_Y) {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(chipGeo, chipMat(name));
    m.position.set(x + (rnd() - 0.5) * 0.0015, y0 + 0.0075 + i * 0.0152, z + (rnd() - 0.5) * 0.0015);
    m.rotation.y = rnd() * 6.28; m.castShadow = true; m.receiveShadow = true; g.add(m);
  }
  return g;
}

// ----------------------------------------------------------------------------- Main Poker 3D Module
export function poker(S) {
  const modalEl = document.getElementById('iv2Game');
  if (modalEl) modalEl.className = 'casino poker3d';

  // Inject Dedicated Fullscreen Styles
  let styleEl = document.getElementById('poker3d-css');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'poker3d-css';
    document.head.append(styleEl);
  }
  styleEl.textContent = `
    #iv2Game.poker3d {
      position: fixed !important; left: 0 !important; top: 0 !important; right: 0 !important; bottom: 0 !important;
      width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important;
      transform: none !important; margin: 0 !important; padding: 0 !important; border: none !important;
      border-radius: 0 !important; box-shadow: none !important; background: #070504 !important; overflow: hidden !important; z-index: 9999 !important;
    }
    #iv2Game.poker3d .cbody { width: 100vw !important; height: 100vh !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important; position: absolute !important; inset: 0 !important; }
    #iv2Game.poker3d .cnote, #iv2Game.poker3d .note, #iv2Game.poker3d .msg { display: none !important; }
    #iv2Game.poker3d canvas { position: absolute !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; border-radius: 0 !important; background: #070504 !important; display: block !important; outline: none !important; }

    #iv2Game.poker3d .gh {
      position: absolute !important; top: 14px !important; left: 20px !important; right: 20px !important; z-index: 50 !important;
      display: flex !important; justify-content: space-between !important; align-items: center !important; background: none !important; border: none !important; padding: 0 !important; pointer-events: none !important;
    }
    #iv2Game.poker3d .gh b {
      pointer-events: auto !important; font: 700 16px Georgia, serif !important; letter-spacing: .12em !important; text-transform: uppercase !important;
      color: #f8e59e !important; text-shadow: 0 2px 8px rgba(0,0,0,0.8) !important; background: rgba(18,14,10,0.92) !important; border: 1.5px solid rgba(212,175,55,0.45) !important;
      border-radius: 20px !important; padding: 7px 20px !important; backdrop-filter: blur(12px) !important; box-shadow: 0 4px 16px rgba(0,0,0,0.6) !important;
    }
    #iv2Game.poker3d .gh span {
      pointer-events: auto !important; font: 700 15px ui-monospace, Menlo, Consolas, monospace !important; color: #f8e59e !important;
      background: rgba(18,14,10,0.92) !important; border: 1.5px solid rgba(212,175,55,0.45) !important; border-radius: 20px !important; padding: 7px 18px !important; backdrop-filter: blur(12px) !important; box-shadow: 0 4px 16px rgba(0,0,0,0.6) !important;
    }
    #iv2Game.poker3d .gh button {
      pointer-events: auto !important; font-size: 24px !important; width: 40px !important; height: 40px !important; border-radius: 50% !important; min-height: 0 !important; min-width: 0 !important; padding: 0 !important; display: grid !important; place-items: center !important;
      background: rgba(22,17,12,0.95) !important; border: 1.5px solid rgba(212,175,55,0.5) !important; color: #f8e59e !important; cursor: pointer !important; box-shadow: 0 4px 16px rgba(0,0,0,0.6) !important; transition: all 0.15s ease !important;
    }
    #iv2Game.poker3d .gh button:hover { transform: scale(1.08) !important; border-color: #f8e59e !important; box-shadow: 0 0 16px rgba(212,175,55,0.4) !important; }

    .poker3d-overlay { position: absolute !important; inset: 0 !important; pointer-events: none !important; z-index: 30 !important; }
    .p3d-badge {
      position: absolute !important; transform: translate(-50%, -50%) !important; background: linear-gradient(135deg, rgba(22,17,13,0.95), rgba(10,8,6,0.97)) !important;
      border: 1.5px solid rgba(212,175,55,0.45) !important; border-radius: 12px !important; padding: 7px 12px !important; display: flex !important; align-items: center !important;
      gap: 10px !important; box-shadow: 0 8px 24px rgba(0,0,0,0.75) !important; backdrop-filter: blur(12px) !important; min-width: 170px !important; box-sizing: border-box !important; white-space: nowrap !important; transition: all 0.3s ease !important;
    }
    .p3d-badge.active-turn { border-color: #f8e59e !important; box-shadow: 0 0 22px rgba(212,175,55,0.5), 0 8px 24px rgba(0,0,0,0.85) !important; animation: p3dPulse 1.8s infinite alternate !important; }
    @keyframes p3dPulse { from { border-color: #d4af37; box-shadow: 0 0 10px rgba(212,175,55,0.35); } to { border-color: #f8e59e; box-shadow: 0 0 24px rgba(248,229,158,0.65); } }
    .p3d-badge.folded { opacity: 0.45 !important; filter: grayscale(0.5) !important; border-color: rgba(140,120,90,0.25) !important; }
    .p3d-avatar { width: 36px !important; height: 36px !important; border-radius: 50% !important; display: grid !important; place-items: center !important; font-weight: bold !important; font-size: 15px !important; color: #fff !important; border: 2px solid #d4af37 !important; flex-shrink: 0 !important; }
    .p3d-info { display: flex !important; flex-direction: column !important; gap: 2px !important; flex-grow: 1 !important; }
    .p3d-name { font-size: 13px !important; font-weight: 700 !important; letter-spacing: 0.04em !important; color: #f5eedb !important; }
    .p3d-stack { font-size: 12px !important; font-weight: 600 !important; color: #f8e59e !important; font-variant-numeric: tabular-nums !important; }
    .p3d-action { padding: 3px 8px !important; border-radius: 6px !important; font-size: 11px !important; font-weight: 700 !important; letter-spacing: 0.05em !important; text-transform: uppercase !important; background: rgba(212,175,55,0.18) !important; border: 1px solid #8e7330 !important; color: #f8e59e !important; flex-shrink: 0 !important; }
    .p3d-action.fold { background: rgba(180,50,50,0.25) !important; border-color: rgba(200,80,80,0.5) !important; color: #e89898 !important; }
    .p3d-action.dealer { background: #f8e59e !important; border-color: #fff !important; color: #141108 !important; font-family: Georgia, serif !important; font-size: 13px !important; padding: 2px 8px !important; border-radius: 12px !important; }

    .p3d-pot-badge { position: absolute !important; transform: translate(-50%, -50%) !important; background: rgba(14,11,8,0.94) !important; border: 1.5px solid rgba(212,175,55,0.45) !important; border-radius: 20px !important; padding: 5px 16px !important; display: flex !important; align-items: center !important; gap: 8px !important; box-shadow: 0 4px 16px rgba(0,0,0,0.65) !important; pointer-events: none !important; white-space: nowrap !important; }
    .p3d-pot-badge span { font-size: 11px !important; letter-spacing: 0.12em !important; text-transform: uppercase !important; color: #c4b087 !important; }
    .p3d-pot-badge b { font-size: 16px !important; color: #f8e59e !important; font-variant-numeric: tabular-nums !important; }

    /* Bottom HUD & Betting Controls */
    .p3d-hud {
      position: absolute !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
      display: flex !important; flex-direction: column !important; align-items: center !important; gap: 10px !important;
      padding: 0 20px 22px !important; pointer-events: none !important; z-index: 35 !important;
      background: linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.55) 60%, transparent 100%) !important;
      box-sizing: border-box !important;
    }
    .p3d-bet-bar {
      pointer-events: auto !important; display: flex !important; align-items: center !important; gap: 12px !important;
      background: rgba(18,14,10,0.94) !important; border: 1.5px solid rgba(212,175,55,0.5) !important; border-radius: 30px !important;
      padding: 6px 18px !important; backdrop-filter: blur(12px) !important; box-shadow: 0 8px 24px rgba(0,0,0,0.7) !important;
    }
    .p3d-quick-btn {
      background: rgba(212,175,55,0.15) !important; border: 1px solid rgba(212,175,55,0.4) !important; border-radius: 14px !important;
      color: #f8e59e !important; font: 700 12px Georgia, serif !important; padding: 4px 12px !important; cursor: pointer !important; transition: all 0.15s ease !important;
    }
    .p3d-quick-btn:hover { background: rgba(212,175,55,0.3) !important; border-color: #f8e59e !important; transform: translateY(-2px) !important; }
    .p3d-slider { width: 160px !important; accent-color: #f8e59e !important; vertical-align: middle !important; cursor: pointer !important; }
    .p3d-amt-display { font: 700 16px ui-monospace, Menlo, monospace !important; color: #f8e59e !important; min-width: 80px !important; text-align: center !important; }

    .p3d-actions-row { display: flex !important; justify-content: center !important; align-items: center !important; gap: 14px !important; }
    .p3d-pill {
      pointer-events: auto !important; background: rgba(14,11,9,0.92) !important; border: 1.5px solid rgba(212,175,55,0.45) !important;
      border-radius: 8px !important; padding: 9px 18px !important; color: #f5eedb !important; backdrop-filter: blur(12px) !important; box-shadow: 0 6px 22px rgba(0,0,0,0.65) !important;
    }
    .p3d-stat { display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; min-width: 100px !important; }
    .p3d-stat span { font-size: 11px !important; text-transform: uppercase !important; letter-spacing: 0.12em !important; color: #bca882 !important; }
    .p3d-stat b { font-size: 18px !important; color: #f8e59e !important; letter-spacing: 0.02em !important; margin-top: 2px !important; font-variant-numeric: tabular-nums !important; }
    
    .p3d-btn {
      min-width: 120px !important; text-align: center !important; font: 700 15px Georgia, serif !important; letter-spacing: 0.15em !important;
      text-transform: uppercase !important; color: #f8e59e !important; cursor: pointer !important; transition: all 0.15s ease !important; border-radius: 8px !important;
    }
    .p3d-btn:hover { transform: translateY(-3px) !important; border-color: #f8e59e !important; box-shadow: 0 10px 28px rgba(0,0,0,0.7), 0 0 18px rgba(212,175,55,0.4) !important; }
    .p3d-btn:active { transform: translateY(1px) !important; }
    .p3d-btn.fold { color: #e89a9a !important; border-color: rgba(200,70,70,0.5) !important; }
    .p3d-btn.fold:hover { border-color: #f08080 !important; box-shadow: 0 8px 24px rgba(180,50,50,0.4) !important; }
    .p3d-btn.bet, .p3d-btn.raise { background: linear-gradient(180deg, #d4af37, #9b7e36) !important; color: #141108 !important; border-color: #f8e59e !important; }
    .p3d-btn.deal { min-width: 220px !important; font-size: 16px !important; background: linear-gradient(180deg, #d4af37, #9b7e36) !important; color: #141108 !important; border-color: #f8e59e !important; box-shadow: 0 4px 20px rgba(212,175,55,0.4) !important; }

    .p3d-banner {
      position: absolute !important; top: 45% !important; left: 50% !important; transform: translate(-50%, -50%) !important;
      background: rgba(12,9,7,0.95) !important; border: 2px solid #d4af37 !important; border-radius: 16px !important; padding: 18px 36px !important;
      text-align: center !important; box-shadow: 0 12px 40px rgba(0,0,0,0.9), 0 0 30px rgba(212,175,55,0.4) !important; z-index: 50 !important; pointer-events: none !important; transition: opacity 0.4s ease !important;
    }
    .p3d-banner h2 { margin: 0 !important; font: 700 28px Georgia, serif !important; color: #f8e59e !important; letter-spacing: 0.1em !important; }
    .p3d-banner p { margin: 6px 0 0 !important; font-size: 16px !important; color: #f5eedb !important; }
  `;

  // Clear previous body elements
  S.U.body.textContent = '';

  // Three.js Setup
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.96;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  S.U.body.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070504);
  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 60);

  const TL = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  function loadTex(url, rep = [1, 1], srgb = false) {
    const t = TL.load(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rep[0], rep[1]);
    t.anisotropy = maxAniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function cgMat(name, { rep = [1, 1], tint = 0xffffff, metal = false, env = 0.5, rough = 1, ns = 1 } = {}) {
    const b = '/assets/casino/textures/CG_' + name + '/' + name + '_2K-JPG_';
    const m = new THREE.MeshStandardMaterial({
      map: loadTex(b + 'Color.jpg', rep, true), normalMap: loadTex(b + 'NormalGL.jpg', rep),
      roughnessMap: loadTex(b + 'Roughness.jpg', rep), roughness: rough, color: new THREE.Color(tint), envMapIntensity: env
    });
    m.normalScale.set(ns, ns);
    if (metal) { m.metalnessMap = loadTex(b + 'Metalness.jpg', rep); m.metalness = 1; }
    return m;
  }
  function phMat(name, { rep = [1, 1], tint = 0xffffff, env = 0.5, ns = 1 } = {}) {
    const b = '/assets/casino/textures/PH_' + name + '/';
    const arm = loadTex(b + 'arm.jpg', rep);
    const m = new THREE.MeshStandardMaterial({
      map: loadTex(b + 'Diffuse.jpg', rep, true), normalMap: loadTex(b + 'nor_gl.jpg', rep),
      aoMap: arm, roughnessMap: arm, metalnessMap: arm, metalness: 1, roughness: 1,
      color: new THREE.Color(tint), envMapIntensity: env
    });
    m.normalScale.set(ns, ns);
    return m;
  }

  // PBR Materials
  const M = {
    felt: cgMat('Fabric028', { rep: [3, 3], tint: new THREE.Color(0.02, 0.22, 0.08), env: 0.04, rough: 0.98, ns: 1.1 }),
    leather: cgMat('Leather034C', { rep: [36, 3], tint: new THREE.Color(0.72, 0.64, 0.58), env: 0.5, ns: 1.2 }),
    walnut: phMat('black_walnut_veneer_01', { rep: [2, 1], tint: new THREE.Color(0.55, 0.26, 0.14), env: 0.35 }),
    brass: cgMat('Metal048A', { metal: true, env: 1.0 }),
    carpet: cgMat('Carpet012', { rep: [14, 14], tint: new THREE.Color(2.0, 0.45, 0.40), env: 0.2, ns: 1.5 }),
    wallWood: cgMat('Wood051', { rep: [3, 1.2], tint: new THREE.Color(0.48, 0.30, 0.22), env: 0.25 }),
    marble: cgMat('Marble014', { rep: [1, 3], env: 0.75 }),
    plaster: new THREE.MeshStandardMaterial({ color: 0x24150d, roughness: 0.95, envMapIntensity: 0.2 })
  };

  class EllipseCurve3 extends THREE.Curve {
    constructor(a, b) { super(); this.a = a; this.b = b; }
    getPoint(t, target = new THREE.Vector3()) { const th = t * Math.PI * 2; return target.set(this.a * Math.cos(th), 0, this.b * Math.sin(th)); }
  }
  function ellipseShape(a, b, seg = 128) {
    const s = new THREE.Shape();
    for (let i = 0; i <= seg; i++) { const th = i / seg * Math.PI * 2; const x = a * Math.cos(th), y = b * Math.sin(th); if (i) s.lineTo(x, y); else s.moveTo(x, y); }
    return s;
  }
  function ring(a, b, r, mat, y, seg = 160, radial = 24) {
    const m = new THREE.Mesh(new THREE.TubeGeometry(new EllipseCurve3(a, b), seg, r, radial, true), mat);
    m.position.y = y; m.castShadow = true; m.receiveShadow = true; return m;
  }

  // Build 3D Poker Table
  function buildTable() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ExtrudeGeometry(ellipseShape(1.65, 1.10), { depth: 0.70, bevelEnabled: false, curveSegments: 1 }), M.walnut);
    body.rotation.x = -Math.PI / 2; body.position.y = 0.06; body.castShadow = true; body.receiveShadow = true; g.add(body);
    const felt = new THREE.Mesh(new THREE.ExtrudeGeometry(ellipseShape(1.52, 0.98), { depth: 0.05, bevelEnabled: false, curveSegments: 1 }), M.felt);
    felt.rotation.x = -Math.PI / 2; felt.position.y = 0.73; felt.receiveShadow = true; g.add(felt);
    const rail = ring(1.60, 1.05, 0.105, M.leather, 0.80, 200, 28); rail.scale.y = 0.85; g.add(rail);
    g.add(ring(1.39, 0.84, 0.006, M.brass, 0.7812, 200, 8));
    g.add(ring(1.695, 1.145, 0.009, M.brass, 0.745, 200, 8));

    const logo = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.20), new THREE.MeshStandardMaterial({
      map: canvasTex(1024, 256, (x, w, h) => { x.clearRect(0, 0, w, h); x.fillStyle = 'rgba(216, 180, 106, 0.40)'; x.font = '600 100px Georgia, serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('SALTLINE CASINO', w / 2, h / 2); }),
      transparent: true, roughness: 0.95, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -2 }));
    logo.rotation.x = -Math.PI / 2; logo.position.set(0, 0.7815, -0.40); g.add(logo);
    return g;
  }
  scene.add(buildTable());

  // Room Architecture
  function box(w, h, d, mat, x, y, z) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.receiveShadow = true; m.castShadow = true; return m; }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), M.carpet); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  scene.add(box(18, 1.35, 0.2, M.wallWood, 0, 0.675, -6.1), box(18, 2.85, 0.2, M.plaster, 0, 2.775, -6.1), box(18, 0.07, 0.3, M.brass, 0, 1.36, -6.0));
  scene.add(box(0.2, 1.35, 18, M.wallWood, -8.1, 0.675, 0), box(0.2, 2.85, 18, M.plaster, -8.1, 2.775, 0), box(0.3, 0.07, 18, M.brass, -8.0, 1.36, 0));
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), M.plaster); ceil.rotation.x = Math.PI / 2; ceil.position.y = 4.2; scene.add(ceil);

  for (const [cx, cz] of [[-4.6, -1.6], [4.6, -1.6], [-4.6, -5.0], [4.6, -5.0], [-4.6, 3.6], [4.6, 3.6]]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 4.2, 40), M.marble); col.position.set(cx, 2.1, cz); col.castShadow = true; col.receiveShadow = true; scene.add(col);
    const baseM = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.38, 0.2, 40), M.brass); baseM.position.set(cx, 0.1, cz); scene.add(baseM);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.3, 0.22, 40), M.brass); cap.position.set(cx, 4.09, cz); scene.add(cap);
  }

  // Soft Directional & Ambient Lighting (Zero glare, clean felt)
  const mainLight = new THREE.DirectionalLight(0xfff3db, 1.8);
  mainLight.position.set(-0.2, 5.5, -0.5);
  mainLight.target.position.set(0, 0.78, 0);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.set(2048, 2048);
  mainLight.shadow.bias = -0.0003;
  mainLight.shadow.radius = 6;
  scene.add(mainLight, mainLight.target);

  const fillLight = new THREE.DirectionalLight(0xffecd0, 0.8);
  fillLight.position.set(1.5, 4.0, 2.0);
  fillLight.target.position.set(0, 0.78, 0);
  scene.add(fillLight, fillLight.target);

  scene.add(new THREE.HemisphereLight(0x5a483a, 0x140e0a, 0.85));

  // Environment HDRI
  const pmrem = new THREE.PMREMGenerator(renderer);
  new RGBELoader().load('/assets/casino/ballroom_1k.hdr', (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    tex.dispose();
  });

  // Props GLTF Loading (Chandelier NEVER casts shadow to avoid ugly black blob on felt!)
  const gltfLoader = new GLTFLoader();
  function placeProp(name, { h, w, pos = [0, 0, 0], ry = 0, top, env = 0.5, castShadow = true } = {}) {
    gltfLoader.load('/assets/casino/models/' + name + '/' + name + '.gltf', (gltf) => {
      const o = gltf.scene; const b = new THREE.Box3().setFromObject(o); const sz = b.getSize(new THREE.Vector3());
      const s = h ? h / sz.y : w / Math.max(sz.x, sz.z); o.scale.setScalar(s);
      b.setFromObject(o); const c = b.getCenter(new THREE.Vector3());
      o.position.set(-c.x, -b.min.y, -c.z);
      const wrap = new THREE.Group(); wrap.add(o); wrap.position.set(pos[0], pos[1], pos[2]); wrap.rotation.y = ry;
      if (top !== undefined) wrap.position.y = top - (b.max.y - b.min.y);
      o.traverse((m) => {
        if (m.isMesh) {
          m.castShadow = castShadow;
          m.receiveShadow = true;
          if (m.material) m.material.envMapIntensity = env;
        }
      });
      scene.add(wrap);
    });
  }

  // Chandelier placed without casting shadow over the felt
  placeProp('lantern_chandelier_01', { w: 1.5, pos: [0, 0, 0.1], top: 4.2, castShadow: false });
  placeProp('ornate_mirror_01', { h: 2.2, pos: [-2.5, 1.6, -5.93] });
  placeProp('ornate_mirror_01', { h: 2.2, pos: [2.5, 1.6, -5.93] });
  placeProp('side_table_tall_01', { h: 0.95, pos: [3.9, 0, -4.9] });
  placeProp('wine_bottles_01', { h: 0.42, pos: [3.9, 0.95, -4.9] });
  placeProp('vintage_oil_lamp', { h: 0.34, pos: [3.55, 0.95, -4.95] });
  placeProp('potted_plant_01', { h: 1.1, pos: [-3.6, 0, -5.4] });
  placeProp('mid_century_lounge_chair', { h: 0.85, pos: [-5.8, 0, 3.4], ry: 0.9 });
  placeProp('mid_century_lounge_chair', { h: 0.85, pos: [5.6, 0, 4.2], ry: -0.9 });

  function seatXZ(deg, rx = 2.15, rz = 1.55) { const t = deg * Math.PI / 180; return [rx * Math.cos(t), rz * Math.sin(t)]; }
  for (const deg of [150, 210, 330, 30]) {
    const [px, pz] = seatXZ(deg, 2.35, 1.65);
    placeProp('modern_arm_chair_01', { h: 0.92, pos: [px, 0, pz], ry: Math.atan2(-px, -pz) });
  }

  // Post Processing
  const rt = new THREE.WebGLRenderTarget(window.innerWidth * Math.min(window.devicePixelRatio || 1, 1.5), window.innerHeight * Math.min(window.devicePixelRatio || 1, 1.5), { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.12, 0.4, 0.98);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Camera presets: Broadcast Tournament View
  const presets = {
    1: { pos: [0, 2.40, 1.35], look: [0, 0.78, -0.05], fov: 42 }
  };
  const camPos = new THREE.Vector3(...presets[1].pos), camLook = new THREE.Vector3(...presets[1].look);
  let camFov = presets[1].fov;
  const mouse = new THREE.Vector2();
  const onMouseMove = (e) => { mouse.set(e.clientX / window.innerWidth - 0.5, e.clientY / window.innerHeight - 0.5); };
  window.addEventListener('mousemove', onMouseMove);

  // Dynamic Game Object Groups
  const cardsGroup = new THREE.Group(); scene.add(cardsGroup);
  const chipsGroup = new THREE.Group(); scene.add(chipsGroup);

  function createFlatCard(tex, x, z, angleOnFelt, yOffset = 0.002) {
    const g = new THREE.Group(); g.position.set(x, TABLE_Y + yOffset, z); g.rotation.y = angleOnFelt;
    const mesh = new THREE.Mesh(cardGeo, [
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.65, metalness: 0.0, envMapIntensity: 0.2 }),
      cardEdgeMat
    ]);
    mesh.rotation.x = -Math.PI / 2; mesh.castShadow = true; mesh.receiveShadow = true;
    g.add(mesh); return g;
  }
  function createHeroCard(tex, x, z, tiltAngle = 36, yaw = 0) {
    const g = new THREE.Group(); g.position.set(x, TABLE_Y + 0.038, z); g.rotation.y = yaw;
    const mesh = new THREE.Mesh(cardGeo, [
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.65, metalness: 0.0, envMapIntensity: 0.25 }),
      cardEdgeMat
    ]);
    mesh.rotation.x = -Math.PI / 2 + THREE.MathUtils.degToRad(tiltAngle); mesh.castShadow = true; mesh.receiveShadow = true;
    g.add(mesh); return g;
  }

  // HTML HUD Overlay
  const overlay = document.createElement('div');
  overlay.className = 'poker3d-overlay';
  overlay.innerHTML = `
    <div class="p3d-badge" id="p3d-seat-1">
      <div class="p3d-avatar" style="background:#7a3528;">A</div>
      <div class="p3d-info"><div class="p3d-name">ANNA</div><div class="p3d-stack">$0</div></div>
      <div class="p3d-action">WAIT</div>
    </div>
    <div class="p3d-badge" id="p3d-seat-2">
      <div class="p3d-avatar" style="background:#204566;">B</div>
      <div class="p3d-info"><div class="p3d-name">BEN</div><div class="p3d-stack">$0</div></div>
      <div class="p3d-action">WAIT</div>
    </div>
    <div class="p3d-badge" id="p3d-seat-dealer" style="min-width:135px;">
      <div class="p3d-avatar" style="background:#9b7a32;">E</div>
      <div class="p3d-info"><div class="p3d-name">ELIZA</div><div class="p3d-stack" style="color:#c4b087;">DEALER</div></div>
    </div>
    <div class="p3d-badge" id="p3d-seat-3">
      <div class="p3d-avatar" style="background:#6e2042;">C</div>
      <div class="p3d-info"><div class="p3d-name">CARLA</div><div class="p3d-stack">$0</div></div>
      <div class="p3d-action">WAIT</div>
    </div>
    <div class="p3d-pot-badge" id="p3d-pot">
      <span>MAIN POT</span>
      <b>$0</b>
    </div>
  `;
  S.U.body.append(overlay);

  // Bottom HUD
  const hud = document.createElement('main');
  hud.className = 'p3d-hud';
  S.U.body.append(hud);

  // Seat Anchors in 3D for HTML Projection
  const seatAnchors = [
    { id: 'p3d-seat-1', pos: new THREE.Vector3(-1.20, 1.02, 0.38) },
    { id: 'p3d-seat-2', pos: new THREE.Vector3(-0.92, 1.02, -0.62) },
    { id: 'p3d-seat-dealer', pos: new THREE.Vector3(0, 1.02, -0.96) },
    { id: 'p3d-seat-3', pos: new THREE.Vector3(1.20, 1.02, 0.38) },
    { id: 'p3d-pot', pos: new THREE.Vector3(0, 0.92, -0.21) }
  ];
  const tempV = new THREE.Vector3();
  function updateSeatBadges() {
    const w = window.innerWidth, hh = window.innerHeight;
    for (const s of seatAnchors) {
      const el = document.getElementById(s.id);
      if (!el) continue;
      tempV.copy(s.pos).project(camera);
      if (tempV.z > 1) { el.style.display = 'none'; continue; }
      el.style.display = 'flex';
      let x = (tempV.x * 0.5 + 0.5) * w;
      let y = (-(tempV.y * 0.5) + 0.5) * hh;
      const halfW = (el.offsetWidth || 170) / 2 + 12;
      const halfH = (el.offsetHeight || 52) / 2 + 12;
      x = Math.max(halfW, Math.min(w - halfW, x));
      y = Math.max(halfH + 40, Math.min(hh - halfH - 120, y));
      el.style.left = x.toFixed(1) + 'px';
      el.style.top = y.toFixed(1) + 'px';
    }
  }

  // Animation Loop
  let alive = true;
  const clock = new THREE.Clock();
  function animate() {
    if (!alive) return;
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    const pz = presets[1];
    const k = 1 - Math.exp(-dt * 3.0);
    camPos.lerp(new THREE.Vector3(pz.pos[0] + mouse.x * 0.15, pz.pos[1] - mouse.y * 0.08, pz.pos[2]), k);
    camLook.lerp(new THREE.Vector3(pz.look[0] - mouse.x * 0.05, pz.look[1], pz.look[2]), k);
    camFov += (pz.fov - camFov) * k;
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    if (Math.abs(camera.fov - camFov) > 0.001) { camera.fov = camFov; camera.updateProjectionMatrix(); }

    updateSeatBadges();
    composer.render(dt);
  }
  animate();

  const handleResize = () => {
    const w = window.innerWidth, hh = window.innerHeight;
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
    renderer.setSize(w, hh);
    composer.setSize(w, hh);
  };
  window.addEventListener('resize', handleResize);
  setTimeout(handleResize, 50);

  // Betting state variables
  let currentChosenBet = S.lim.min || 25;
  let currentChosenAnte = S.lim.min || 25;

  // --------------------------------------------------------------------------- Render Game State (onResult)
  let lastView = null;
  let lastStacks = null;
  let playToken = 0;
  function renderGameState(v, net = null) {
    lastView = v; if (v.stacks) lastStacks = v.stacks;
    const done = v.phase === 'done';

    // 1. Update 3D Cards
    while (cardsGroup.children.length) cardsGroup.remove(cardsGroup.children[0]);

    // Hero pocket cards
    if (v.you && v.you.length >= 2) {
      const c1 = cardInfo(v.you[0]), c2 = cardInfo(v.you[1]);
      if (c1) cardsGroup.add(createHeroCard(cardFaceTex(c1.rank, c1.suit), -0.082, 0.52, 36, 0.05));
      if (c2) cardsGroup.add(createHeroCard(cardFaceTex(c2.rank, c2.suit), 0.082, 0.52, 36, -0.05));
    }

    // Community cards
    if (v.board && v.board.length) {
      v.board.forEach((cd, i) => {
        const ci = cardInfo(cd);
        if (ci) cardsGroup.add(createFlatCard(cardFaceTex(ci.rank, ci.suit), -0.34 + i * 0.17, -0.06, (i - 2) * 0.012, 0.002));
      });
    }

    // Opponent cards (seats 1, 2, 3)
    const OPP_CONFIG = [
      { deg: 150, seat: 1 },
      { deg: 210, seat: 2 },
      { deg: 30, seat: 3 }
    ];
    OPP_CONFIG.forEach(cfg => {
      const isFolded = v.folded && v.folded[cfg.seat];
      if (isFolded) return; // Mucked cards!
      const ang = cfg.deg * Math.PI / 180;
      const x = 0.95 * Math.cos(ang), z = 0.60 * Math.sin(ang);
      const showdownCards = done && v.seats && v.seats[cfg.seat]?.cards;
      if (showdownCards && showdownCards.length >= 2) {
        const sc1 = cardInfo(showdownCards[0]), sc2 = cardInfo(showdownCards[1]);
        if (sc1) cardsGroup.add(createFlatCard(cardFaceTex(sc1.rank, sc1.suit), x - 0.045, z, -0.35, 0.002));
        if (sc2) cardsGroup.add(createFlatCard(cardFaceTex(sc2.rank, sc2.suit), x + 0.045, z, -0.25, 0.003));
      } else {
        cardsGroup.add(createFlatCard(cardBackTex, x - 0.045, z, -0.35, 0.002));
        cardsGroup.add(createFlatCard(cardBackTex, x + 0.045, z, -0.25, 0.003));
      }
    });

    // 2. Update 3D Chip Stacks
    while (chipsGroup.children.length) chipsGroup.remove(chipsGroup.children[0]);

    if (v.pot > 0) {
      const potCount = Math.min(24, Math.max(4, Math.floor(v.pot / (S.lim.min || 25))));
      chipsGroup.add(makeChipStack(-0.12, 0.14, 'red', Math.min(10, potCount)));
      if (potCount > 6) chipsGroup.add(makeChipStack(0.0, 0.12, 'blue', Math.min(8, potCount - 4)));
      if (potCount > 12) chipsGroup.add(makeChipStack(0.12, 0.14, 'black', Math.min(12, potCount - 8)));
    }

    if (v.in) {
      if (v.in[0] > 0) chipsGroup.add(makeChipStack(-0.05, 0.34, 'red', Math.min(8, Math.max(2, Math.floor(v.in[0] / 25)))));
      if (v.in[1] > 0) chipsGroup.add(makeChipStack(-0.65, 0.20, 'red', Math.min(8, Math.max(2, Math.floor(v.in[1] / 25)))));
      if (v.in[2] > 0) chipsGroup.add(makeChipStack(-0.55, -0.15, 'red', Math.min(8, Math.max(2, Math.floor(v.in[2] / 25)))));
      if (v.in[3] > 0) chipsGroup.add(makeChipStack(0.55, 0.20, 'red', Math.min(8, Math.max(2, Math.floor(v.in[3] / 25)))));
    }

    // Dealer button
    {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.012, 36), new THREE.MeshPhysicalMaterial({ roughness: 0.2, clearcoat: 0.6, map: canvasTex(128, 128, (x) => { x.fillStyle = '#f5f0e4'; x.fillRect(0, 0, 128, 128); x.fillStyle = '#141416'; x.font = 'bold 88px Georgia'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('D', 64, 68); }) }));
      b.position.set(0.68, TABLE_Y + 0.006, -0.22); b.castShadow = true; chipsGroup.add(b);
    }

    // 3. Update HTML Seat Badges
    const potEl = document.querySelector('#p3d-pot b');
    if (potEl) potEl.textContent = '$' + money(v.pot || 0);

    for (let i = 1; i < 4; i++) {
      const bEl = document.getElementById('p3d-seat-' + i);
      if (!bEl) continue;
      const isFolded = v.folded && v.folded[i];
      bEl.classList.toggle('folded', !!isFolded);
      bEl.classList.toggle('active-turn', !done && v.turn === i);

      const stackEl = bEl.querySelector('.p3d-stack');
      if (stackEl) stackEl.textContent = '$' + money(Math.max(0, v.stacks ? v.stacks[i] : (lastStacks ? lastStacks[i] : 40000 - (v.in ? v.in[i] : 0))));

      const actEl = bEl.querySelector('.p3d-action');
      if (actEl) {
        if (isFolded) { actEl.textContent = 'FOLD'; actEl.className = 'p3d-action fold'; }
        else if (v.in && v.in[i] > 0) { actEl.textContent = 'IN $' + money(v.in[i]); actEl.className = 'p3d-action'; }
        else { actEl.textContent = done ? 'DONE' : 'WAIT'; actEl.className = 'p3d-action'; }
      }
    }

    // 4. Update Bottom HUD Actions
    hud.textContent = '';

    const canBetOrRaise = (v.options || []).some(o => o === 'bet' || o === 'raise');
    const minB = v.minBet || S.lim.min || 25;
    const maxB = Math.min(S.balance || 50000, Math.max(minB * 10, v.pot || 500));
    currentChosenBet = Math.max(minB, Math.min(maxB, currentChosenBet));

    // Interactive Bet / Raise Bar
    if (!done && canBetOrRaise) {
      const betBar = document.createElement('div');
      betBar.className = 'p3d-bet-bar';

      const slider = document.createElement('input');
      slider.type = 'range'; slider.className = 'p3d-slider';
      slider.min = minB; slider.max = maxB; slider.step = minB;
      slider.value = currentChosenBet;

      const amtDisp = document.createElement('div');
      amtDisp.className = 'p3d-amt-display';
      amtDisp.textContent = '$' + money(currentChosenBet);

      slider.addEventListener('input', () => {
        currentChosenBet = parseInt(slider.value, 10);
        amtDisp.textContent = '$' + money(currentChosenBet);
        updateActionButtons();
      });

      const qMin = h('button', { class: 'p3d-quick-btn', onclick: () => { slider.value = minB; slider.dispatchEvent(new Event('input')); } }, 'Min');
      const q2x = h('button', { class: 'p3d-quick-btn', onclick: () => { slider.value = Math.min(maxB, minB * 2); slider.dispatchEvent(new Event('input')); } }, '2x');
      const qPot = h('button', { class: 'p3d-quick-btn', onclick: () => { slider.value = Math.max(minB, Math.min(maxB, v.pot || minB * 2)); slider.dispatchEvent(new Event('input')); } }, 'Pot');
      const qMax = h('button', { class: 'p3d-quick-btn', onclick: () => { slider.value = maxB; slider.dispatchEvent(new Event('input')); } }, 'Max');

      betBar.append(qMin, q2x, qPot, qMax, slider, amtDisp);
      hud.append(betBar);
    } else if (done) {
      // Ante selector before deal
      const anteBar = document.createElement('div');
      anteBar.className = 'p3d-bet-bar';
      const antes = [25, 50, 100, 250, 500, 1000].filter(a => a >= (S.lim.min || 25) && a <= (S.lim.max || 10000));
      currentChosenAnte = Math.max(S.lim.min || 25, currentChosenAnte);

      const anteTitle = h('span', { style: 'font-size:12px;color:#c4b087;text-transform:uppercase;letter-spacing:0.1em;' }, 'Select Stake:');
      anteBar.append(anteTitle);
      antes.forEach(a => {
        const b = h('button', {
          class: 'p3d-quick-btn',
          style: a === currentChosenAnte ? 'background:#f8e59e;color:#141108;border-color:#fff;' : '',
          onclick: () => {
            currentChosenAnte = a;
            renderGameState(v);
          }
        }, '$' + money(a));
        anteBar.append(b);
      });
      hud.append(anteBar);
    }

    const actionsRow = document.createElement('div');
    actionsRow.className = 'p3d-actions-row';

    const heroStack = h('div', { class: 'p3d-pill p3d-stat' }, h('span', {}, 'Your Stack'), h('b', {}, '$' + money(S.balance || 0)));
    actionsRow.append(heroStack);

    function doAction(op, extra = {}) {
      if (S.pending.busy) return;
      S.pending.busy = true;
      playSound(op === 'deal' ? 'card' : 'chip');
      // Auto-clear busy safety timeout
      setTimeout(() => { S.pending.busy = false; }, 2000);
      S.send(op, extra);
    }

    function updateActionButtons() {
      const dynamicBtn = actionsRow.querySelector('.p3d-btn.dynamic-bet');
      if (dynamicBtn) {
        const op = dynamicBtn.dataset.op;
        dynamicBtn.textContent = `${op.toUpperCase()} $${money(currentChosenBet)}`;
      }
    }

    if (done) {
      const dealBtn = h('button', {
        class: 'p3d-pill p3d-btn deal',
        onclick: (e) => {
          e.target.textContent = 'DEALING...';
          doAction('deal', { amt: currentChosenAnte });
        }
      }, `DEAL HAND (Ante $${money(currentChosenAnte)})`);
      actionsRow.append(dealBtn);

      // Win Banner
      if (net !== null) {
        playSound(net > 0 ? 'win' : 'chip');
        const won = v.winners && v.winners.includes(0);
        const bannerEl = document.createElement('div');
        bannerEl.className = 'p3d-banner';
        bannerEl.innerHTML = `
          <h2>${won ? 'YOU WIN THE POT!' : v.folded && v.folded[0] ? 'YOU FOLDED' : (GUEST_NAMES[v.winners?.[0] ?? 1].toUpperCase() + ' WINS')}</h2>
          <p>${net > 0 ? ('+' + money(net) + ' credits') : net < 0 ? (money(net) + ' credits') : 'Push'}</p>
        `;
        S.U.body.append(bannerEl);
        setTimeout(() => bannerEl.remove(), T(3.5) * 1000);
      }
    } else {
      (v.options || []).forEach(op => {
        const cost = v.costs ? v.costs[op] : 0;
        const isFold = op === 'fold';
        const isBetOrRaise = op === 'bet' || op === 'raise';
        let label = cost > 0 ? `${op.toUpperCase()} $${money(cost)}` : op.toUpperCase();
        if (isBetOrRaise) label = `${op.toUpperCase()} $${money(currentChosenBet)}`;

        const btn = h('button', {
          class: `p3d-pill p3d-btn ${isFold ? 'fold' : isBetOrRaise ? 'bet dynamic-bet' : ''}`,
          'data-op': op,
          onclick: (e) => {
            if (isBetOrRaise) {
              doAction(op, { amt: currentChosenBet });
            } else {
              doAction(op);
            }
          }
        }, label);
        actionsRow.append(btn);
      });
    }

    const totalPot = h('div', { class: 'p3d-pill p3d-stat' }, h('span', {}, 'Total Pot'), h('b', {}, '$' + money(v.pot || 0)));
    actionsRow.append(totalPot);
    hud.append(actionsRow);
  }

  // Turn-by-turn playback: the server answers a whole street at once; show each guest's decision in order, then the new state
  function playTurns(v, net) {
    const token = ++playToken;
    const acts = (v.log || []).filter((e) => e.seat > 0);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    hud.textContent = '';
    hud.append(h('div', { class: 'p3d-pill p3d-stat' }, h('span', {}, 'Table'), h('b', {}, 'Players acting...')));
    (async () => {
      await wait(350);
      for (const e of acts) {
        if (token !== playToken || !alive) return;
        document.querySelectorAll('.p3d-badge').forEach((b) => b.classList.remove('active-turn'));
        const bEl = document.getElementById('p3d-seat-' + e.seat);
        if (bEl) bEl.classList.add('active-turn');
        await wait(650);
        if (token !== playToken || !alive) return;
        const actEl = bEl && bEl.querySelector('.p3d-action');
        if (actEl) { actEl.textContent = String(e.a).toUpperCase(); actEl.className = 'p3d-action' + (e.a === 'fold' ? ' fold' : ''); }
        playSound(e.a === 'fold' ? 'card' : e.a === 'check' ? 'card' : 'chip');
        await wait(550);
      }
      if (token !== playToken || !alive) return;
      if (v.phase === 'done') await wait(500);
      if (token !== playToken || !alive) return;
      renderGameState(v, net);
    })();
  }

  // Initial render
  renderGameState({ phase: 'done', pot: 0, you: [], board: [], folded: [false, false, false, false], in: [0, 0, 0, 0] });

  return {
    onResult(m) {
      S.pending.busy = false;
      if (m.money !== undefined) {
        S.balance = m.money;
        S.U.setMoney(m.money);
      }
      if (m.view) playTurns(m.view, m.net);
    },
    refused(m) {
      S.pending.busy = false;
      S.say(m.text || 'Action refused.', false);
    },
    stop() {
      alive = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('resize', handleResize);
      if (modalEl) {
        modalEl.classList.remove('poker3d');
        modalEl.style.cssText = '';
      }
      renderer.dispose();
      composer.dispose();
    }
  };
}
