// Photorealistic PBR Material & Mesh System for Cruise Ship Interiors
// Docs: docs/CRUISE-CONTRACT.md §4 & §7
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

let pbrLoaded = false;
let M = null;
const TL = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();
const modelCache = new Map();
let envApplied = false;

export function applyCasinoEnvironment(scene, renderer) {
  if (envApplied || !scene || !renderer) return;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    new RGBELoader().load('/assets/casino/ballroom_1k.hdr', (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      scene.environment = pmrem.fromEquirectangular(tex).texture;
      tex.dispose();
      pmrem.dispose();
      envApplied = true;
    }, undefined, (err) => console.warn('[iv2pbr] HDR load err:', err));
  } catch (e) {
    console.warn('[iv2pbr] applyCasinoEnvironment err:', e);
  }
}

function loadTex(url, rep = [1, 1], srgb = false) {
  const t = TL.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rep[0], rep[1]);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function cgMat(name, { rep = [1, 1], tint = 0xffffff, metal = false, env = 0.5, rough = 1, ns = 1 } = {}) {
  const b = '/assets/casino/textures/CG_' + name + '/' + name + '_2K-JPG_';
  const m = new THREE.MeshStandardMaterial({
    map: loadTex(b + 'Color.jpg', rep, true),
    normalMap: loadTex(b + 'NormalGL.jpg', rep),
    roughnessMap: loadTex(b + 'Roughness.jpg', rep),
    roughness: rough,
    color: new THREE.Color(tint),
    envMapIntensity: env
  });
  m.normalScale.set(ns, ns);
  if (metal) {
    m.metalnessMap = loadTex(b + 'Metalness.jpg', rep);
    m.metalness = 1;
  }
  return m;
}

function phMat(name, { rep = [1, 1], tint = 0xffffff, env = 0.5, ns = 1 } = {}) {
  const b = '/assets/casino/textures/PH_' + name + '/';
  const arm = loadTex(b + 'arm.jpg', rep);
  const m = new THREE.MeshStandardMaterial({
    map: loadTex(b + 'Diffuse.jpg', rep, true),
    normalMap: loadTex(b + 'nor_gl.jpg', rep),
    aoMap: arm, roughnessMap: arm, metalnessMap: arm, metalness: 1, roughness: 1,
    color: new THREE.Color(tint), envMapIntensity: env
  });
  m.normalScale.set(ns, ns);
  return m;
}

export function getPBRMaterials() {
  if (pbrLoaded) return M;
  M = {
    felt: cgMat('Fabric028', { rep: [4, 4], tint: new THREE.Color(0.04, 0.28, 0.12), env: 0.1, rough: 0.95, ns: 1.2 }),
    feltRed: cgMat('Fabric028', { rep: [4, 4], tint: new THREE.Color(0.55, 0.08, 0.12), env: 0.1, rough: 0.95, ns: 1.2 }),
    leather: cgMat('Leather034C', { rep: [36, 3], tint: new THREE.Color(0.24, 0.20, 0.18), env: 0.6, ns: 1.4 }),
    leatherDark: cgMat('Leather034C', { rep: [18, 2], tint: new THREE.Color(0.12, 0.10, 0.09), env: 0.6, ns: 1.4 }),
    walnut: phMat('black_walnut_veneer_01', { rep: [2, 1], tint: new THREE.Color(0.55, 0.26, 0.14), env: 0.5 }),
    brass: cgMat('Metal048A', { metal: true, env: 1.4, tint: new THREE.Color(0xf6d870) }),
    carpet: cgMat('Carpet012', { rep: [1, 1], tint: new THREE.Color(0.85, 0.35, 0.38), env: 0.3, rough: 0.85, ns: 1.8 }),
    wallWood: cgMat('Wood051', { rep: [2, 1], tint: new THREE.Color(0.50, 0.28, 0.18), env: 0.45 }),
    marble: cgMat('Marble014', { rep: [2, 4], env: 0.9 }),
    plaster: new THREE.MeshStandardMaterial({ color: 0x2b1c16, roughness: 0.92, envMapIntensity: 0.3 }),
    mirror: new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.95, roughness: 0.08, envMapIntensity: 1.5 }),
    light: new THREE.MeshStandardMaterial({ color: 0xfff4e0, emissive: 0xffe4b5, emissiveIntensity: 2.2 }),
  };
  pbrLoaded = true;
  return M;
}

class EllipseCurve3 extends THREE.Curve {
  constructor(a, b) { super(); this.a = a; this.b = b; }
  getPoint(t, target = new THREE.Vector3()) {
    const th = t * Math.PI * 2;
    return target.set(this.a * Math.cos(th), 0, this.b * Math.sin(th));
  }
}

function ellipseShape(a, b, seg = 64) {
  const s = new THREE.Shape();
  for (let i = 0; i <= seg; i++) {
    const th = (i / seg) * Math.PI * 2;
    const x = a * Math.cos(th), y = b * Math.sin(th);
    if (i) s.lineTo(x, y); else s.moveTo(x, y);
  }
  return s;
}

function ring(a, b, r, mat, y, seg = 80, radial = 16) {
  const m = new THREE.Mesh(new THREE.TubeGeometry(new EllipseCurve3(a, b), seg, r, radial, true), mat);
  m.position.y = y;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Build Authentic 3D Texas Hold'em Poker Table (Oval)
export function createPBRTable(type = 'poker') {
  const mats = getPBRMaterials();
  const g = new THREE.Group();
  const isRed = type === 'baccarat' || type === 'poker_red';
  const feltMat = isRed ? mats.feltRed : mats.felt;

  // 1. Walnut wood base & subtop
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(ellipseShape(1.22, 0.82, 48), { depth: 0.68, bevelEnabled: false }), mats.walnut);
  body.rotation.x = -Math.PI / 2;
  body.position.y = 0.06;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // Twin heavy turned pedestals
  for (const px of [-0.65, 0.65]) {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.06, 16), mats.brass);
    foot.position.set(px, 0.03, 0);
    g.add(foot);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.64, 16), mats.walnut);
    leg.position.set(px, 0.38, 0);
    g.add(leg);
    const topCap = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.16, 0.04, 16), mats.brass);
    topCap.position.set(px, 0.70, 0);
    g.add(topCap);
  }

  // 2. Real woven PBR felt
  const felt = new THREE.Mesh(new THREE.ExtrudeGeometry(ellipseShape(1.12, 0.72, 48), { depth: 0.05, bevelEnabled: false }), feltMat);
  felt.rotation.x = -Math.PI / 2;
  felt.position.y = 0.73;
  felt.receiveShadow = true;
  g.add(felt);

  // 3. Thick padded leather bolster rail (full oval)
  const rail = ring(1.18, 0.78, 0.088, mats.leather, 0.795, 80, 18);
  rail.scale.y = 0.85;
  g.add(rail);

  // 4. Inlaid brass trim rings
  g.add(ring(1.02, 0.62, 0.005, mats.brass, 0.781, 80, 8));
  g.add(ring(1.24, 0.84, 0.007, mats.brass, 0.745, 80, 8));

  // 5. Embossed gold casino table logo
  try {
    const logoCanvas = document.createElement('canvas');
    logoCanvas.width = 1024;
    logoCanvas.height = 256;
    const ctx = logoCanvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, 1024, 256);
      ctx.fillStyle = 'rgba(216, 180, 106, 0.55)';
      ctx.font = '600 86px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('SALTLINE CASINO', 512, 128);
      const logoTex = new THREE.CanvasTexture(logoCanvas);
      const logoMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.75, 0.18),
        new THREE.MeshStandardMaterial({ map: logoTex, transparent: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2 })
      );
      logoMesh.rotation.x = -Math.PI / 2;
      logoMesh.position.set(0, 0.7815, -0.28);
      g.add(logoMesh);
    }
  } catch {}

  // 6. Suspended Casino Pendant Lamp above table
  const lampGroup = new THREE.Group();
  const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.04, 12), mats.brass);
  canopy.position.y = 2.78;
  lampGroup.add(canopy);

  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.38, 0.20, 16), mats.walnut);
  shade.position.y = 2.05;
  lampGroup.add(shade);

  const shadeRing = new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.03, 16, 1, true), mats.brass);
  shadeRing.position.y = 1.95;
  lampGroup.add(shadeRing);

  const diffuser = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.02, 16), mats.light);
  diffuser.position.y = 1.96;
  lampGroup.add(diffuser);

  const spot = new THREE.SpotLight(0xffecd0, 3.0, 5.0, Math.PI / 3, 0.6, 1.2);
  spot.position.set(0, 2.0, 0);
  spot.target.position.set(0, 0.78, 0);
  lampGroup.add(spot, spot.target);

  g.add(lampGroup);

  return g;
}

// Build Authentic Horseshoe Blackjack / Baccarat Table (100% Solid, NO Cut-outs!)
export function createPBRBlackjackTable(isBaccarat = false) {
  const mats = getPBRMaterials();
  const g = new THREE.Group();
  const feltMat = isBaccarat ? mats.feltRed : mats.felt;

  const rx = 1.18, rz = 0.82, dBack = -0.35, seg = 48;

  // 1. Solid Horseshoe Table Body (Walnut)
  // When rotated by -Math.PI / 2 around X: World Z = -y_shape.
  // Dealer back is at World Z = dBack (-0.35) -> y_shape = +0.35.
  // Flanks are from World Z = -0.35 to 0 -> y_shape from +0.35 to 0.
  // Player arc has World Z = rz * sin(th) (positive) -> y_shape = -rz * sin(th) (negative).
  const s = new THREE.Shape();
  s.moveTo(-rx, -dBack); // (-1.18, 0.35) -> World (-1.18, -0.35)
  s.lineTo(rx, -dBack);  // (+1.18, 0.35) -> World (+1.18, -0.35)
  s.lineTo(rx, 0);       // (+1.18, 0) -> World (+1.18, 0)
  for (let i = 0; i <= seg; i++) {
    const th = (i / seg) * Math.PI; // 0 to PI
    s.lineTo(rx * Math.cos(th), -rz * Math.sin(th));
  }
  s.lineTo(-rx, 0);      // (-1.18, 0) -> World (-1.18, 0)
  s.lineTo(-rx, -dBack);
  s.closePath();

  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.70, bevelEnabled: false }), mats.walnut);
  body.rotation.x = -Math.PI / 2;
  body.position.set(0, 0.06, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // Twin heavy turned walnut pedestal legs with brass trim
  for (const px of [-0.60, 0.60]) {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.06, 16), mats.brass);
    foot.position.set(px, 0.03, 0.18);
    g.add(foot);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.64, 16), mats.walnut);
    leg.position.set(px, 0.38, 0.18);
    g.add(leg);
    const topCap = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.16, 0.04, 16), mats.brass);
    topCap.position.set(px, 0.70, 0.18);
    g.add(topCap);
  }
  const stretcher = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 1.20, 12), mats.brass);
  stretcher.rotation.z = Math.PI / 2;
  stretcher.position.set(0, 0.18, 0.18);
  g.add(stretcher);

  // 2. Sunken Baize Felt (Matching Horseshoe Shape)
  const frx = 1.06, frz = 0.70, fdBack = -0.25;
  const sFelt = new THREE.Shape();
  sFelt.moveTo(-frx, -fdBack);
  sFelt.lineTo(frx, -fdBack);
  sFelt.lineTo(frx, 0);
  for (let i = 0; i <= seg; i++) {
    const th = (i / seg) * Math.PI;
    sFelt.lineTo(frx * Math.cos(th), -frz * Math.sin(th));
  }
  sFelt.lineTo(-frx, 0);
  sFelt.lineTo(-frx, -fdBack);
  sFelt.closePath();

  const felt = new THREE.Mesh(new THREE.ExtrudeGeometry(sFelt, { depth: 0.05, bevelEnabled: false }), feltMat);
  felt.rotation.x = -Math.PI / 2;
  felt.position.set(0, 0.73, 0);
  felt.receiveShadow = true;
  g.add(felt);

  // 3. Continuous Padded Leather Bolster Curve along flanks and player arc
  class HorseshoeArcCurve extends THREE.Curve {
    getPoint(t, target = new THREE.Vector3()) {
      if (t < 0.15) {
        const u = t / 0.15;
        // From dealer right corner (1.14, 0, -0.35) to flank start (1.14, 0, 0)
        return target.set(1.14, 0, dBack + u * (-dBack));
      } else if (t <= 0.85) {
        const u = (t - 0.15) / 0.70;
        const th = u * Math.PI;
        // From (1.14, 0, 0) around the arc through (0, 0, 0.78) to (-1.14, 0, 0)
        return target.set(1.14 * Math.cos(th), 0, 0.78 * Math.sin(th));
      } else {
        const u = (t - 0.85) / 0.15;
        // From flank end (-1.14, 0, 0) back to dealer left corner (-1.14, 0, -0.35)
        return target.set(-1.14, 0, -u * (-dBack));
      }
    }
  }

  const rail = new THREE.Mesh(new THREE.TubeGeometry(new HorseshoeArcCurve(), 80, 0.088, 16, false), mats.leather);
  rail.position.y = 0.795;
  rail.scale.y = 0.85;
  g.add(rail);

  // Seamless straight dealer armrest pad meeting both ends of the curved rail
  const dealerPad = new THREE.Mesh(new THREE.BoxGeometry(2.28, 0.075, 0.12), mats.leather);
  dealerPad.position.set(0, 0.795, dBack);
  g.add(dealerPad);

  // Inlaid Brass Trim Ring along inner edge of bolster
  const brassTrim = new THREE.Mesh(new THREE.TubeGeometry(new HorseshoeArcCurve(), 80, 0.006, 8, false), mats.brass);
  brassTrim.position.y = 0.781;
  brassTrim.scale.set(0.94, 1, 0.94);
  g.add(brassTrim);

  // Inlaid Brass Cup Holders around player spots
  for (let k = 0; k < 5; k++) {
    const th = ((k + 1) / 6) * Math.PI;
    const cx = 0.96 * Math.cos(th), cz = 0.65 * Math.sin(th);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.025, 12), mats.brass);
    cup.position.set(cx, 0.78, cz);
    g.add(cup);
  }

  // 4. Printed Blackjack / Baccarat Layout Canvas Overlay
  try {
    const layoutCanvas = document.createElement('canvas');
    layoutCanvas.width = 1024;
    layoutCanvas.height = 512;
    const ctx = layoutCanvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, 1024, 512);
      ctx.strokeStyle = 'rgba(216, 180, 106, 0.65)';
      ctx.fillStyle = 'rgba(216, 180, 106, 0.75)';
      ctx.lineWidth = 4;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ctx.font = 'bold 36px Georgia, serif';
      ctx.fillText(isBaccarat ? 'BACCARAT — PUNTO BANCO' : 'BLACKJACK PAYS 3 TO 2', 512, 180);
      ctx.font = '22px Georgia, serif';
      ctx.fillText(isBaccarat ? 'BANKER PAYS 1 TO 1 (5% COMM) • PLAYER PAYS 1 TO 1 • TIE 8 TO 1' : 'Dealer must draw to 16 and stand on all 17s', 512, 225);
      ctx.font = 'bold 24px Georgia, serif';
      ctx.fillText(isBaccarat ? 'SALTLINE HIGH LIMIT' : 'INSURANCE PAYS 2 TO 1', 512, 265);

      for (let i = 0; i < 5; i++) {
        const bx = 200 + i * 156, by = 380;
        ctx.strokeRect(bx - 50, by - 35, 100, 70);
        ctx.beginPath();
        ctx.arc(bx, by, 22, 0, Math.PI * 2);
        ctx.stroke();
      }

      const layoutTex = new THREE.CanvasTexture(layoutCanvas);
      const layoutMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.60, 0.80),
        new THREE.MeshStandardMaterial({ map: layoutTex, transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 })
      );
      layoutMesh.rotation.x = -Math.PI / 2;
      layoutMesh.position.set(0, 0.7812, 0.28);
      g.add(layoutMesh);
    }
  } catch {}

  // 5. Dealer Station Accessories
  const chipTray = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.025, 0.18), mats.brass);
  chipTray.position.set(0, 0.745, dBack + 0.16);
  g.add(chipTray);

  const chipCols = [0xd02028, 0x2060d0, 0x20a040, 0x18181c, 0xf0e8d0];
  for (let c = 0; c < 5; c++) {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.035, 12), new THREE.MeshStandardMaterial({ color: chipCols[c], roughness: 0.4 }));
    stack.position.set(-0.16 + c * 0.08, 0.76, dBack + 0.16);
    g.add(stack);
  }

  // Dealing Shoe
  const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.22), mats.brass);
  shoe.position.set(0.42, 0.77, dBack + 0.16);
  shoe.rotation.x = -0.2;
  g.add(shoe);

  // Discard Rack
  const discard = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.08, 0.14), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, roughness: 0.1 }));
  discard.position.set(-0.42, 0.77, dBack + 0.16);
  g.add(discard);

  // 6. Suspended Casino Pendant Lamp above table center
  const lampGroup = new THREE.Group();
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.38, 0.20, 16), mats.walnut);
  shade.position.set(0, 2.05, 0.20);
  lampGroup.add(shade);
  const diffuser = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.02, 16), mats.light);
  diffuser.position.set(0, 1.96, 0.20);
  lampGroup.add(diffuser);
  const spot = new THREE.SpotLight(0xffecd0, 3.0, 5.0, Math.PI / 3, 0.6, 1.2);
  spot.position.set(0, 2.0, 0.20);
  spot.target.position.set(0, 0.78, 0.20);
  lampGroup.add(spot, spot.target);
  g.add(lampGroup);

  return g;
}

// Build Authentic 3D Tournament Roulette Table
export function createPBRRouletteTable() {
  const mats = getPBRMaterials();
  const g = new THREE.Group();
  const w = 2.6, d = 1.6, h = 0.88;
  const wx = -w * 0.28; // Center of roulette wheel bowl (-0.73)

  // 1. Walnut Base Table
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, 0.70, d), mats.walnut);
  body.position.set(0, 0.41, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // Twin Heavy Turned Walnut Pedestal Bases with Brass Collars
  for (const px of [-w * 0.28, w * 0.28]) {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.06, 16), mats.brass);
    foot.position.set(px, 0.03, 0);
    g.add(foot);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.64, 16), mats.walnut);
    leg.position.set(px, 0.38, 0);
    g.add(leg);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.04, 16), mats.brass);
    cap.position.set(px, 0.70, 0);
    g.add(cap);
  }
  const stretcher = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, w * 0.56, 12), mats.brass);
  stretcher.rotation.z = Math.PI / 2;
  stretcher.position.set(0, 0.18, 0);
  g.add(stretcher);

  // 2. Sunken Baize Green Felt
  const felt = new THREE.Mesh(new THREE.BoxGeometry(w * 0.94, 0.04, d * 0.90), mats.felt);
  felt.position.set(0, 0.76, 0);
  felt.receiveShadow = true;
  g.add(felt);

  // 3. Thick Padded Leather Bolster around player edges
  const railFront = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 0.12), mats.leather);
  railFront.position.set(0, 0.80, d / 2 - 0.06);
  g.add(railFront);
  const railBack = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 0.12), mats.leather);
  railBack.position.set(0, 0.80, -d / 2 + 0.06);
  g.add(railBack);
  const railEnd = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, d), mats.leather);
  railEnd.position.set(w / 2 - 0.06, 0.80, 0);
  g.add(railEnd);

  // 4. Authentic Roulette Betting Grid Canvas
  try {
    const rGridCanvas = document.createElement('canvas');
    rGridCanvas.width = 1024;
    rGridCanvas.height = 512;
    const rctx = rGridCanvas.getContext('2d');
    if (rctx) {
      rctx.clearRect(0, 0, 1024, 512);
      rctx.strokeStyle = '#f0d070';
      rctx.lineWidth = 3;
      rctx.textAlign = 'center';
      rctx.textBaseline = 'middle';

      // Zero box (green)
      rctx.fillStyle = '#1e7b34';
      rctx.fillRect(40, 100, 70, 240);
      rctx.strokeRect(40, 100, 70, 240);
      rctx.fillStyle = '#ffffff';
      rctx.font = 'bold 44px Arial, sans-serif';
      rctx.fillText('0', 75, 220);

      // Red numbers set
      const reds = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
      const colW = 68, rowH = 80;
      for (let c = 0; c < 12; c++) {
        for (let r = 0; r < 3; r++) {
          const num = (11 - c) * 3 + (3 - r);
          const x = 110 + c * colW, y = 100 + r * rowH;
          rctx.fillStyle = reds.has(num) ? '#b22222' : '#1a1a1a';
          rctx.fillRect(x, y, colW, rowH);
          rctx.strokeRect(x, y, colW, rowH);
          rctx.fillStyle = '#ffffff';
          rctx.font = 'bold 36px Arial, sans-serif';
          rctx.fillText(String(num), x + colW / 2, y + rowH / 2);
        }
      }

      // Dozens
      const dozNames = ['1st 12', '2nd 12', '3rd 12'];
      for (let d = 0; d < 3; d++) {
        const x = 110 + d * (colW * 4), y = 340;
        rctx.fillStyle = 'rgba(20, 60, 30, 0.6)';
        rctx.fillRect(x, y, colW * 4, 50);
        rctx.strokeRect(x, y, colW * 4, 50);
        rctx.fillStyle = '#f0d070';
        rctx.font = 'bold 26px Georgia, serif';
        rctx.fillText(dozNames[d], x + colW * 2, y + 25);
      }

      // Outside bets
      const outs = ['1 to 18', 'EVEN', 'RED', 'BLACK', 'ODD', '19 to 36'];
      const outW = (colW * 12) / 6;
      for (let o = 0; o < 6; o++) {
        const x = 110 + o * outW, y = 390;
        rctx.fillStyle = o === 2 ? '#b22222' : (o === 3 ? '#1a1a1a' : 'rgba(20, 60, 30, 0.6)');
        rctx.fillRect(x, y, outW, 45);
        rctx.strokeRect(x, y, outW, 45);
        rctx.fillStyle = '#ffffff';
        rctx.font = 'bold 22px Arial, sans-serif';
        rctx.fillText(outs[o], x + outW / 2, y + 22);
      }

      const gridTex = new THREE.CanvasTexture(rGridCanvas);
      const gridMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.45, 0.82),
        new THREE.MeshStandardMaterial({ map: gridTex, transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2 })
      );
      gridMesh.rotation.x = -Math.PI / 2;
      gridMesh.position.set(0.38, 0.7815, 0);
      g.add(gridMesh);
    }
  } catch {}

  // 5. Genuine 3D Mahogany Roulette Wheel Bowl
  const wheelBowl = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.16, 32), mats.walnut);
  wheelBowl.position.set(wx, 0.84, 0);
  g.add(wheelBowl);

  const brassTrimBowl = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.04, 32, 1, true), mats.brass);
  brassTrimBowl.position.set(wx, 0.90, 0);
  g.add(brassTrimBowl);

  const sunkenTrack = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.34, 0.08, 32), mats.brass);
  sunkenTrack.position.set(wx, 0.86, 0);
  g.add(sunkenTrack);

  const wheelHead = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.05, 36), mats.walnut);
  wheelHead.position.set(wx, 0.89, 0);
  g.add(wheelHead);

  const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.14, 16), mats.brass);
  turret.position.set(wx, 0.94, 0);
  g.add(turret);

  for (let a = 0; a < 4; a++) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 8), mats.brass);
    arm.rotation.z = Math.PI / 2;
    arm.rotation.y = a * (Math.PI / 2);
    arm.position.set(wx, 0.99, 0);
    g.add(arm);
  }

  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15 }));
  ball.position.set(wx + 0.26, 0.90, 0.10);
  g.add(ball);

  const dolly = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.08, 12), mats.brass);
  dolly.position.set(0.45, 0.82, 0.08);
  g.add(dolly);

  const chipCols = [0xd02028, 0x2060d0, 0x20a040, 0x18181c, 0xf0e8d0, 0xf6d870];
  for (let c = 0; c < 6; c++) {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.045, 12), new THREE.MeshStandardMaterial({ color: chipCols[c], roughness: 0.4 }));
    stack.position.set(wx + 0.12 + c * 0.07, 0.80, -d * 0.32);
    g.add(stack);
  }

  // 6. Overhead Casino Pendant Lamp
  const lampGroup = new THREE.Group();
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.38, 0.20, 16), mats.walnut);
  shade.position.set(0.20, 2.05, 0);
  lampGroup.add(shade);
  const diffuser = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.02, 16), mats.light);
  diffuser.position.set(0.20, 1.96, 0);
  lampGroup.add(diffuser);
  const spot = new THREE.SpotLight(0xffecd0, 3.0, 5.0, Math.PI / 3, 0.6, 1.2);
  spot.position.set(0.20, 2.0, 0);
  spot.target.position.set(0.20, 0.78, 0);
  lampGroup.add(spot, spot.target);
  g.add(lampGroup);

  return g;
}

// Build Authentic 3D Luxury Casino Bar Counter
export function createPBRBarCounter(w = 5.0, d = 1.0, h = 1.15) {
  const mats = getPBRMaterials();
  const g = new THREE.Group();

  // Dark Walnut Paneled Counter Base
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, h - 0.08, d - 0.10), mats.walnut);
  base.position.set(0, (h - 0.08) / 2, 0);
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);

  // Polished Carrara Marble Top with Beveled Edge
  const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.08, d + 0.08), mats.marble);
  top.position.set(0, h - 0.04, 0);
  top.receiveShadow = true;
  g.add(top);

  // Polished Brass Footrail along the front
  const footrail = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, w, 16), mats.brass);
  footrail.rotation.z = Math.PI / 2;
  footrail.position.set(0, 0.18, d / 2 + 0.04);
  g.add(footrail);

  for (let k = -2; k <= 2; k++) {
    const bracket = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.18, 8), mats.brass);
    bracket.position.set(k * (w / 5), 0.09, d / 2 + 0.04);
    g.add(bracket);
  }

  // Warm LED Under-counter Glow Strip
  const glow = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, 0.04), mats.light);
  glow.position.set(0, h - 0.09, d / 2 + 0.01);
  g.add(glow);

  return g;
}

// Load and place GLTF Props (Chairs, Potted Plants, Chandeliers)
export function loadGLTFProp(name, callback) {
  if (modelCache.has(name)) {
    callback(modelCache.get(name).clone());
    return;
  }
  const url = '/assets/casino/models/' + name + '/' + name + '.gltf';
  try {
  gltfLoader.load(url, (gltf) => {
    const o = gltf.scene;
    o.traverse((m) => {
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    modelCache.set(name, o);
    callback(o.clone());
  }, undefined, (err) => {
    console.warn('[iv2pbr] Failed to load GLTF prop:', name, err);
  });
  } catch (err) { console.warn('[iv2pbr] Failed to load GLTF prop:', name, err); }   // a URL the loader cannot even build (no browser) is a missing prop, not a crash
}

// ----------------------------------------------------------------------------- Royal Casino Custom Textures
let casinoCarpetMatCached = null;
export function getCasinoCarpetMat() {
  if (casinoCarpetMatCached) return casinoCarpetMatCached;
  try {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 1024;
    const ctx = c.getContext('2d');
    if (ctx) {
      // 1. Rich Royal Ruby Velvet Base
      ctx.fillStyle = '#3a0812'; ctx.fillRect(0, 0, 1024, 1024);

      // Fine fabric micro-grain
      for (let i = 0; i < 60000; i++) {
        const x = Math.random() * 1024, y = Math.random() * 1024;
        ctx.fillStyle = Math.random() > 0.5 ? 'rgba(75, 14, 25, 0.35)' : 'rgba(35, 6, 10, 0.45)';
        ctx.fillRect(x, y, 2, 2);
      }

      // 2. Ornate Golden Baroque Acanthus Medallions & Diamond Lattice
      ctx.strokeStyle = '#d4af37'; ctx.lineWidth = 6;
      const step = 256;
      for (let x = 0; x <= 1024; x += step) {
        for (let y = 0; y <= 1024; y += step) {
          // Diamond borders
          ctx.beginPath();
          ctx.moveTo(x, y - step / 2); ctx.lineTo(x + step / 2, y);
          ctx.lineTo(x, y + step / 2); ctx.lineTo(x - step / 2, y);
          ctx.closePath();
          ctx.strokeStyle = '#997a23'; ctx.lineWidth = 4; ctx.stroke();
          ctx.strokeStyle = '#d4af37'; ctx.lineWidth = 2; ctx.stroke();

          // Central Fleur-de-lis / Acanthus Medallion
          ctx.save(); ctx.translate(x, y);
          ctx.fillStyle = 'rgba(212, 175, 55, 0.85)';
          ctx.beginPath(); ctx.arc(0, 0, 32, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#2a050d';
          ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI * 2); ctx.fill();

          // Petals
          ctx.fillStyle = '#d4af37';
          for (let p = 0; p < 8; p++) {
            const ang = (p / 8) * Math.PI * 2;
            ctx.beginPath();
            ctx.arc(Math.cos(ang) * 16, Math.sin(ang) * 16, 6, 0, Math.PI * 2);
            ctx.fill();
          }
          // Center jewel
          ctx.fillStyle = '#0f4c81'; // Sapphire jewel
          ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      }

      const diffTex = new THREE.CanvasTexture(c);
      diffTex.wrapS = diffTex.wrapT = THREE.RepeatWrapping;
      diffTex.colorSpace = THREE.SRGBColorSpace;

      // Normal Map Canvas for 3D woven relief
      const nc = document.createElement('canvas'); nc.width = 512; nc.height = 512;
      const nctx = nc.getContext('2d');
      if (nctx) {
        nctx.fillStyle = '#8080ff'; nctx.fillRect(0, 0, 512, 512);
        // Add normal relief for medallions
        nctx.strokeStyle = '#9070ff'; nctx.lineWidth = 4;
        for (let x = 0; x <= 512; x += 128) {
          for (let y = 0; y <= 512; y += 128) {
            nctx.beginPath();
            nctx.moveTo(x, y - 64); nctx.lineTo(x + 64, y);
            nctx.lineTo(x, y + 64); nctx.lineTo(x - 64, y);
            nctx.closePath(); nctx.stroke();
            nctx.beginPath(); nctx.arc(x, y, 16, 0, Math.PI * 2); nctx.stroke();
          }
        }
      }
      const norTex = new THREE.CanvasTexture(nc);
      norTex.wrapS = norTex.wrapT = THREE.RepeatWrapping;

      casinoCarpetMatCached = new THREE.MeshStandardMaterial({
        map: diffTex,
        normalMap: norTex,
        normalScale: new THREE.Vector2(1.5, 1.5),
        roughness: 0.85,
        envMapIntensity: 0.35,
      });
      return casinoCarpetMatCached;
    }
  } catch {}
  return getPBRMaterials().carpet;
}

let casinoDamaskMatCached = null;
export function getCasinoDamaskMat() {
  if (casinoDamaskMatCached) return casinoDamaskMatCached;
  try {
    const c = document.createElement('canvas'); c.width = 512; c.height = 512;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#32060e'; ctx.fillRect(0, 0, 512, 512);
      ctx.strokeStyle = '#c69c3a'; ctx.lineWidth = 3;
      // Woven Damask filigree
      for (let x = 0; x <= 512; x += 128) {
        for (let y = 0; y <= 512; y += 128) {
          ctx.beginPath();
          ctx.arc(x, y, 38, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(198, 156, 58, 0.45)';
          ctx.beginPath();
          ctx.arc(x, y, 20, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const diffTex = new THREE.CanvasTexture(c);
      diffTex.wrapS = diffTex.wrapT = THREE.RepeatWrapping;
      diffTex.colorSpace = THREE.SRGBColorSpace;

      casinoDamaskMatCached = new THREE.MeshStandardMaterial({
        map: diffTex,
        roughness: 0.90,
        envMapIntensity: 0.3,
      });
      return casinoDamaskMatCached;
    }
  } catch {}
  return getPBRMaterials().feltRed;
}

// ----------------------------------------------------------------------------- 3D Photorealistic Slot Island
export function createPBRSlotIsland(w = 3.2, d = 1.8, h = 1.65) {
  const mats = getPBRMaterials();
  const g = new THREE.Group();

  const cabinetMat = new THREE.MeshStandardMaterial({ color: 0x16161a, metalness: 0.85, roughness: 0.25, envMapIntensity: 1.0 });
  const chromeMat = mats.brass; // Rich golden chrome / polished brass
  const glowMat = mats.light;

  // Build Slot Machine Reel Canvas Texture
  let reelTex = null;
  try {
    const rc = document.createElement('canvas'); rc.width = 512; rc.height = 256;
    const rctx = rc.getContext('2d');
    if (rctx) {
      rctx.fillStyle = '#f8f6f0'; rctx.fillRect(0, 0, 512, 256);
      rctx.strokeStyle = '#222'; rctx.lineWidth = 3;
      for (let i = 0; i < 3; i++) {
        const rx = 40 + i * 150;
        rctx.strokeRect(rx, 20, 130, 216);
        rctx.fillStyle = '#ff1122'; rctx.font = 'bold 80px Arial, sans-serif'; rctx.textAlign = 'center'; rctx.textBaseline = 'middle';
        rctx.fillText('7', rx + 65, 80);
        rctx.fillStyle = '#111'; rctx.font = 'bold 36px Arial, sans-serif';
        rctx.fillText('BAR', rx + 65, 170);
      }
      reelTex = new THREE.CanvasTexture(rc);
      reelTex.colorSpace = THREE.SRGBColorSpace;
    }
  } catch {}
  const reelMat = reelTex ? new THREE.MeshStandardMaterial({ map: reelTex, roughness: 0.3 }) : mats.light;

  // Build Marquee Canvas Texture
  let marqueeTex = null;
  try {
    const mc = document.createElement('canvas'); mc.width = 512; mc.height = 128;
    const mctx = mc.getContext('2d');
    if (mctx) {
      mctx.fillStyle = '#100508'; mctx.fillRect(0, 0, 512, 128);
      mctx.strokeStyle = '#ffd700'; mctx.lineWidth = 6; mctx.strokeRect(6, 6, 500, 116);
      mctx.fillStyle = '#ffe040'; mctx.font = 'bold 36px Georgia, serif'; mctx.textAlign = 'center'; mctx.textBaseline = 'middle';
      mctx.fillText('★ ROYAL CASINO ★', 256, 42);
      mctx.fillStyle = '#00ffcc'; mctx.font = 'bold 28px "Courier New", monospace';
      mctx.fillText('JACKPOT $2,485,910', 256, 88);
      marqueeTex = new THREE.CanvasTexture(mc);
      marqueeTex.colorSpace = THREE.SRGBColorSpace;
    }
  } catch {}
  const marqueeMat = marqueeTex ? new THREE.MeshStandardMaterial({ map: marqueeTex, roughness: 0.4, emissive: 0x443311 }) : glowMat;

  // 6 Slot Stations (3 facing +z, 3 facing -z)
  for (const dir of [1, -1]) {
    const rotY = dir === 1 ? 0 : Math.PI;
    for (const sx of [-1.0, 0, 1.0]) {
      const slot = new THREE.Group();
      slot.position.set(sx, 0, dir * 0.45);
      slot.rotation.y = rotY;

      // 1. Lower Cabinet & Pedestal
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.72, 0.58), cabinetMat);
      base.position.set(0, 0.36, 0);
      slot.add(base);

      // Chrome Foot Trim
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.06, 0.60), chromeMat);
      foot.position.set(0, 0.03, 0);
      slot.add(foot);

      // 2. Slanted Button Deck
      const deck = new THREE.Mesh(new THREE.BoxGeometry(0.80, 0.10, 0.28), cabinetMat);
      deck.position.set(0, 0.76, 0.22);
      deck.rotation.x = 0.22;
      slot.add(deck);

      // Glowing SPIN Button
      const spinBtn = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 16), new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00a0b0, emissiveIntensity: 1.5 }));
      spinBtn.position.set(0.24, 0.81, 0.22);
      slot.add(spinBtn);

      // Bet Buttons
      for (let b = 0; b < 4; b++) {
        const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.015, 12), new THREE.MeshStandardMaterial({ color: 0xffd700, emissive: 0x886600, emissiveIntensity: 1.2 }));
        btn.position.set(-0.25 + b * 0.09, 0.80, 0.22);
        slot.add(btn);
      }

      // 3. Main Reel Display Screen
      const screenHousing = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.44, 0.48), cabinetMat);
      screenHousing.position.set(0, 1.02, -0.04);
      slot.add(screenHousing);

      const reels = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.34), reelMat);
      reels.position.set(0, 1.02, 0.21);
      slot.add(reels);

      const glassBezel = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.38, 0.02), chromeMat);
      glassBezel.position.set(0, 1.02, 0.205);
      slot.add(glassBezel);

      // 4. Upper Jackpot Marquee
      const marqueeBox = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.32, 0.44), cabinetMat);
      marqueeBox.position.set(0, 1.40, -0.06);
      slot.add(marqueeBox);

      const marqueeScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.74, 0.24), marqueeMat);
      marqueeScreen.position.set(0, 1.40, 0.17);
      slot.add(marqueeScreen);

      // Chrome Marquee Crown Arch
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.04, 16, 1, false, 0, Math.PI), chromeMat);
      crown.rotation.x = -Math.PI / 2;
      crown.position.set(0, 1.58, 0.15);
      slot.add(crown);

      // 5. Classic Chrome Pull Lever
      const armBase = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.05, 12), chromeMat);
      armBase.rotation.z = Math.PI / 2;
      armBase.position.set(0.43, 0.88, 0.05);
      slot.add(armBase);

      const armRod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.26, 8), chromeMat);
      armRod.rotation.x = 0.25;
      armRod.position.set(0.46, 0.98, 0.08);
      slot.add(armRod);

      const armBall = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 10), new THREE.MeshStandardMaterial({ color: 0xd02028, roughness: 0.2, metalness: 0.1 }));
      armBall.position.set(0.46, 1.11, 0.12);
      slot.add(armBall);

      // 6. Coin Tray with 3D Gold Coins
      const tray = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.06, 0.14), chromeMat);
      tray.position.set(0, 0.42, 0.32);
      slot.add(tray);

      // Swivel Casino Stool
      const stool = new THREE.Group();
      const stoolBase = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.04, 16), chromeMat);
      stoolBase.position.y = 0.02;
      stool.add(stoolBase);
      const stoolPost = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.50, 12), chromeMat);
      stoolPost.position.y = 0.27;
      stool.add(stoolPost);
      const footRing = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.015, 8, 16), chromeMat);
      footRing.rotation.x = Math.PI / 2;
      footRing.position.y = 0.20;
      stool.add(footRing);
      const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.17, 0.08, 16), mats.leatherDark);
      seat.position.y = 0.54;
      stool.add(seat);
      const backrest = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.24, 0.06), mats.leatherDark);
      backrest.position.set(0, 0.70, -0.14);
      stool.add(backrest);

      stool.position.set(0, 0, 0.72);
      slot.add(stool);

      g.add(slot);
    }
  }

  return g;
}

// ----------------------------------------------------------------------------- Luxury Coffered Casino Ceiling
export function createPBRCasinoCeiling(r, pbrMats) {
  const g = new THREE.Group();
  const cw = r.x1 - r.x0, cd = r.z1 - r.z0;
  const cy = r.y + r.h;

  // 1. Dark Walnut Main Ceiling Plane
  const ceilGeo = new THREE.PlaneGeometry(cw, cd);
  ceilGeo.rotateX(Math.PI / 2);
  const ceilMesh = new THREE.Mesh(ceilGeo, pbrMats.walnut);
  ceilMesh.position.set((r.x0 + r.x1) / 2, cy, (r.z0 + r.z1) / 2);
  g.add(ceilMesh);

  // 2. Grid of Inset Gold-Leaf Coffered Ceiling Trays
  const nx = Math.max(2, Math.floor(cw / 4.0));
  const nz = Math.max(2, Math.floor(cd / 4.0));
  const pw = (cw - 1.2) / nx;
  const pd = (cd - 1.2) / nz;

  const cofferMat = new THREE.MeshStandardMaterial({
    color: 0x3a2214,
    roughness: 0.70,
    metalness: 0.15,
    envMapIntensity: 0.6
  });
  const coveGlowMat = new THREE.MeshStandardMaterial({
    color: 0xffdfa0,
    emissive: 0xffcc77,
    emissiveIntensity: 2.5
  });

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const cx = r.x0 + 0.6 + (i + 0.5) * pw;
      const cz = r.z0 + 0.6 + (j + 0.5) * pd;

      // Recessed gold-leaf tray
      const tray = new THREE.Mesh(new THREE.PlaneGeometry(pw - 0.35, pd - 0.35), cofferMat);
      tray.rotateX(Math.PI / 2);
      tray.position.set(cx, cy + 0.08, cz);
      g.add(tray);

      // Gold Molded Border Frame
      const frame = new THREE.Mesh(new THREE.BoxGeometry(pw - 0.30, 0.06, pd - 0.30), pbrMats.brass);
      frame.position.set(cx, cy + 0.03, cz);
      g.add(frame);

      // Perimeter LED Cove Lighting Strip
      const cove = new THREE.Mesh(new THREE.BoxGeometry(pw - 0.38, 0.02, pd - 0.38), coveGlowMat);
      cove.position.set(cx, cy + 0.06, cz);
      g.add(cove);
    }
  }

  return g;
}
