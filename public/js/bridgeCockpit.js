// Realistic High-Detail Cockpit & Bridge for Saltline Interior
// Implements photorealistic PBR materials, multi-function glass cockpit screens (ECDIS, Radar, Conning),
// dual-lever engine order telegraph, authentic ship's wheel, magnetic binnacle compass,
// overhead avionics rack with VHF radio & annunciator panel, captain's ergonomic helm chair,
// chart table with brass gooseneck lamp & nautical tools, and atmospheric bridge lighting.

import * as THREE from 'three';

let cockpitState = null;

// Helper: load PBR texture with repeat and anisotropy
function createTexLoader() {
  const TL = new THREE.TextureLoader();
  return function loadTex(url, rep = [1, 1], srgb = false) {
    const t = TL.load(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rep[0], rep[1]);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
}

export function buildRealisticBridgeCockpit(interior, ctx, p) {
  const { g, M, plan } = ctx;
  const loadTex = createTexLoader();
  const facing = p.facing ?? -1;
  const { x, y, z, w } = p;
  const depth = 0.85;

  // Find bridge room dimensions for ceiling and wall features
  const bridgeRoom = plan.rooms.find((r) => r.kind === 'bridge' || r.id === 'bridge') || {
    x0: x - w, x1: x + w, z0: z - 2, z1: z + 2, y, h: 2.2
  };

  // 1. High-Detail PBR Materials
  const mats = {
    // Rich Walnut Console Wood (from casino asset suite)
    walnut: new THREE.MeshStandardMaterial({
      map: loadTex('/assets/casino/textures/PH_black_walnut_veneer_01/Diffuse.jpg', [2, 1], true),
      normalMap: loadTex('/assets/casino/textures/PH_black_walnut_veneer_01/nor_gl.jpg', [2, 1]),
      roughnessMap: loadTex('/assets/casino/textures/PH_black_walnut_veneer_01/arm.jpg', [2, 1]),
      roughness: 0.35,
      metalness: 0.05,
      color: new THREE.Color(0x6a3b22)
    }),
    // Marine Console Composite (satin dark charcoal)
    consoleBody: new THREE.MeshStandardMaterial({
      color: 0x181c20,
      roughness: 0.4,
      metalness: 0.25
    }),
    // Marine Leather (padded armrests & helm chair)
    leather: new THREE.MeshStandardMaterial({
      map: loadTex('/assets/casino/textures/CG_Leather034C/Leather034C_2K-JPG_Color.jpg', [4, 4], true),
      normalMap: loadTex('/assets/casino/textures/CG_Leather034C/Leather034C_2K-JPG_NormalGL.jpg', [4, 4]),
      roughnessMap: loadTex('/assets/casino/textures/CG_Leather034C/Leather034C_2K-JPG_Roughness.jpg', [4, 4]),
      color: new THREE.Color(0x222426),
      roughness: 0.6,
      metalness: 0.05
    }),
    // Polished Marine Brass
    brass: new THREE.MeshStandardMaterial({
      map: loadTex('/assets/casino/textures/CG_Metal048A/Metal048A_2K-JPG_Color.jpg', [2, 2], true),
      normalMap: loadTex('/assets/casino/textures/CG_Metal048A/Metal048A_2K-JPG_NormalGL.jpg', [2, 2]),
      roughness: 0.25,
      metalness: 0.9,
      color: new THREE.Color(0xd4af37)
    }),
    // Polished Marine Chrome / Stainless Steel
    chrome: new THREE.MeshStandardMaterial({
      color: 0xe8ecef,
      roughness: 0.15,
      metalness: 0.95
    }),
    // Teak Wood Rim
    teak: new THREE.MeshStandardMaterial({
      map: loadTex('/assets/casino/textures/CG_Wood051/Wood051_2K-JPG_Color.jpg', [3, 1], true),
      normalMap: loadTex('/assets/casino/textures/CG_Wood051/Wood051_2K-JPG_NormalGL.jpg', [3, 1]),
      roughness: 0.4,
      color: new THREE.Color(0x8a532d)
    }),
    // Screen Bezel & Housing
    bezel: new THREE.MeshStandardMaterial({
      color: 0x0d1114,
      roughness: 0.5,
      metalness: 0.5
    }),
    // Knobs, Switches & Indicators
    blackPlastic: new THREE.MeshStandardMaterial({ color: 0x111315, roughness: 0.6, metalness: 0.1 }),
    redHandle: new THREE.MeshStandardMaterial({ color: 0xbb2525, roughness: 0.3, metalness: 0.2 }),
    blackHandle: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.3, metalness: 0.2 }),
    amberLed: new THREE.MeshStandardMaterial({ color: 0xffaa00, emissive: 0xff9900, emissiveIntensity: 1.4 }),
    greenLed: new THREE.MeshStandardMaterial({ color: 0x22ee66, emissive: 0x22ee66, emissiveIntensity: 1.5 }),
    redLed: new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff2222, emissiveIntensity: 1.6 }),
    cyanLed: new THREE.MeshStandardMaterial({ color: 0x33ddff, emissive: 0x33ddff, emissiveIntensity: 1.4 }),
    glassCover: new THREE.MeshStandardMaterial({
      color: 0x99ccff,
      transparent: true,
      opacity: 0.3,
      roughness: 0.05,
      metalness: 0.8
    })
  };

  const cockpitGroup = new THREE.Group();
  cockpitGroup.name = 'realisticBridgeCockpit';
  g.add(cockpitGroup);

  // 2. Main Helm Console Plinth & Body
  const baseBox = new THREE.Mesh(new THREE.BoxGeometry(w, 0.96, depth), mats.consoleBody);
  baseBox.position.set(x, y + 0.48, z);
  cockpitGroup.add(baseBox);

  // Walnut veneer desktop with beveled front lip
  const deskTop = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.08, depth + 0.12), mats.walnut);
  deskTop.position.set(x, y + 0.98, z + facing * 0.02);
  cockpitGroup.add(deskTop);

  // Padded Marine Leather Bolster (Armrest Crash Rail along aft skipper side)
  const bolsterGeo = new THREE.CylinderGeometry(0.045, 0.045, w + 0.06, 16);
  bolsterGeo.rotateZ(Math.PI / 2);
  const bolster = new THREE.Mesh(bolsterGeo, mats.leather);
  bolster.position.set(x, y + 1.02, z - facing * (depth / 2 + 0.04));
  cockpitGroup.add(bolster);

  // Slanted Instrument Dashboard (Houses the Glass Cockpit screens)
  const dashAngle = facing * -0.32; // ~18 degrees tilt towards the helmsman
  const dashWidth = Math.min(w * 0.92, 3.8);
  const dashH = 0.48;
  const dashD = 0.12;
  const dashMesh = new THREE.Mesh(new THREE.BoxGeometry(dashWidth, dashH, dashD), mats.consoleBody);
  dashMesh.position.set(x, y + 1.26, z + facing * 0.08);
  dashMesh.rotation.x = dashAngle;
  cockpitGroup.add(dashMesh);

  // Brass/chrome trim along the top edge of the dashboard
  const trimRod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, dashWidth + 0.02, 12), mats.brass);
  trimRod.rotation.z = Math.PI / 2;
  trimRod.position.set(x, y + 1.48, z + facing * 0.14);
  cockpitGroup.add(trimRod);

  // 3. Dynamic Glass Cockpit MFD Screens (Canvases)
  // Screen A: Center Conning & Engine Information Display (EID)
  const conCv = document.createElement('canvas');
  conCv.width = 512; conCv.height = 320;
  const conTex = new THREE.CanvasTexture(conCv);
  conTex.colorSpace = THREE.SRGBColorSpace;
  const conMat = new THREE.MeshBasicMaterial({ map: conTex });
  const scrW = Math.min(0.68, (dashWidth - 0.2) / 3);
  const scrH = scrW * 0.62;

  const portOffset = scrW + 0.12;
  const stbdOffset = scrW + 0.12;

  // Screen A: Center Conning & Engine Information Display (attached directly to dashMesh)
  conMat.side = THREE.DoubleSide;
  conMat.polygonOffset = true;
  conMat.polygonOffsetFactor = -2;
  const conScr = new THREE.Mesh(new THREE.PlaneGeometry(scrW, scrH), conMat);
  conScr.position.set(0, 0.01, (dashD / 2) + 0.003);
  dashMesh.add(conScr);

  // Screen B: Port Electronic Chart Display (ECDIS)
  const ecdisCv = document.createElement('canvas');
  ecdisCv.width = 512; ecdisCv.height = 320;
  const ecdisTex = new THREE.CanvasTexture(ecdisCv);
  ecdisTex.colorSpace = THREE.SRGBColorSpace;
  const ecdisMat = new THREE.MeshBasicMaterial({ map: ecdisTex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });

  const ecdisScr = new THREE.Mesh(new THREE.PlaneGeometry(scrW, scrH), ecdisMat);
  ecdisScr.position.set(-portOffset, 0.01, (dashD / 2) + 0.003);
  dashMesh.add(ecdisScr);

  // Screen C: Starboard ARPA Radar Display
  const radCv = document.createElement('canvas');
  radCv.width = 512; radCv.height = 320;
  const radTex = new THREE.CanvasTexture(radCv);
  radTex.colorSpace = THREE.SRGBColorSpace;
  const radMat = new THREE.MeshBasicMaterial({ map: radTex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });

  const radScr = new THREE.Mesh(new THREE.PlaneGeometry(scrW, scrH), radMat);
  radScr.position.set(stbdOffset, 0.01, (dashD / 2) + 0.003);
  dashMesh.add(radScr);

  // Bezel frames and pushbuttons around all 3 screens
  [0, -portOffset, stbdOffset].forEach((sx) => {
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(scrW + 0.05, scrH + 0.05, 0.02), mats.bezel);
    bezel.position.set(sx, 0.01, (dashD / 2) + 0.001);
    dashMesh.add(bezel);
    for (let b = 0; b < 4; b++) {
      const btn = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.015, 0.015), mats.blackPlastic);
      btn.position.set(sx - scrW * 0.36 + b * (scrW * 0.24), -scrH / 2 - 0.04, (dashD / 2) + 0.008);
      dashMesh.add(btn);
    }
  });

  // 4. Authentic Ship's Wheel & Steering Pedestal
  const wheelGroup = new THREE.Group();
  wheelGroup.position.set(x, y + 1.24, z - facing * 0.42);
  wheelGroup.rotation.x = facing * -0.32;

  // Steering pedestal base
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 0.42, 20), mats.consoleBody);
  ped.rotation.x = Math.PI / 2;
  ped.position.z = facing * 0.18;
  wheelGroup.add(ped);

  // Brass wheel hub
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 24), mats.brass);
  hub.rotation.x = Math.PI / 2;
  wheelGroup.add(hub);

  // Teak wood rim with turned cylindrical handles
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.024, 16, 36), mats.teak);
  wheelGroup.add(rim);

  // 6 Turned Spokes with Brass ferrules and Teak handgrips
  for (let i = 0; i < 6; i++) {
    const ang = (i * Math.PI) / 3;
    // Inner spoke rod
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.014, 0.54, 12), mats.brass);
    spoke.rotation.z = ang;
    wheelGroup.add(spoke);
    // Outer turned wooden handle extending beyond the rim
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.012, 0.14, 12), mats.teak);
    handle.position.set(Math.sin(ang) * 0.34, -Math.cos(ang) * 0.34, 0);
    handle.rotation.z = ang;
    wheelGroup.add(handle);
  }
  cockpitGroup.add(wheelGroup);

  // Connect wheel reference to Interior for live steering animation
  interior.wheel = wheelGroup;

  // Rudder Angle Indicator (miniature curved gauge directly above the steering hub)
  const raiBase = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.08, 0.04), mats.bezel);
  raiBase.position.set(x, y + 1.48, z - facing * 0.38);
  raiBase.rotation.x = dashAngle;
  cockpitGroup.add(raiBase);
  const raiFace = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.06), new THREE.MeshBasicMaterial({ color: 0x071118 }));
  raiFace.position.set(x, y + 1.48, z - facing * 0.38 - facing * 0.022);
  raiFace.rotation.x = dashAngle;
  if (facing > 0) raiFace.rotation.y = Math.PI;
  cockpitGroup.add(raiFace);

  // 5. Heavy-Duty Engine Order Telegraph & Throttle Quadrant
  const leverGroup = new THREE.Group();
  const leverX = x + Math.min(0.85, w * 0.28);
  leverGroup.position.set(leverX, y + 1.05, z);

  // Polished quadrant base with dual slots and brass top plate
  const quadBase = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.34), mats.walnut);
  quadBase.position.y = 0.06;
  leverGroup.add(quadBase);
  const quadPlate = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.01, 0.32), mats.brass);
  quadPlate.position.y = 0.125;
  leverGroup.add(quadPlate);

  // Port Engine Lever (Red handle)
  const portLeverArm = new THREE.Group();
  const rodPort = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 12), mats.chrome);
  rodPort.position.y = 0.16;
  const knobPort = new THREE.Mesh(new THREE.SphereGeometry(0.038, 16, 16), mats.redHandle);
  knobPort.position.y = 0.32;
  portLeverArm.add(rodPort, knobPort);
  portLeverArm.position.x = -0.05;
  leverGroup.add(portLeverArm);

  // Starboard Engine Lever (Black handle)
  const stbdLeverArm = new THREE.Group();
  const rodStbd = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 12), mats.chrome);
  rodStbd.position.y = 0.16;
  const knobStbd = new THREE.Mesh(new THREE.SphereGeometry(0.038, 16, 16), mats.blackHandle);
  knobStbd.position.y = 0.32;
  stbdLeverArm.add(rodStbd, knobStbd);
  stbdLeverArm.position.x = 0.05;
  leverGroup.add(stbdLeverArm);

  cockpitGroup.add(leverGroup);
  // Connect lever reference to Interior for live throttle animation
  interior.lever = leverGroup;

  // Engine Order Telegraph dial from telegraph.js
  try {
    interior.app.telegraph?.attachBridge?.(
      cockpitGroup,
      leverX + (facing > 0 ? -0.42 : 0.42),
      y + 1.34,
      z,
      facing
    );
  } catch (e) {
    console.warn('[cockpit] telegraph attach', e);
  }

  // Dual Bow & Stern Thruster Mini-Joysticks
  [-0.06, 0.06].forEach((jx, idx) => {
    const joyBase = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.03, 14), mats.bezel);
    joyBase.position.set(leverX + jx, y + 1.05 + 0.13, z - facing * 0.18);
    cockpitGroup.add(joyBase);
    const joyStick = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.09, 10), mats.chrome);
    joyStick.position.set(leverX + jx, y + 1.05 + 0.17, z - facing * 0.18);
    const joyKnob = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 12), mats.blackPlastic);
    joyKnob.position.set(leverX + jx, y + 1.05 + 0.22, z - facing * 0.18);
    cockpitGroup.add(joyStick, joyKnob);
  });

  // Emergency Engine Stop Pushbutton (Red mushroom cap with yellow collar)
  const eStopCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.02, 18), mats.amberLed);
  eStopCollar.position.set(leverX + 0.16, y + 1.05 + 0.13, z - facing * 0.1);
  const eStopCap = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.03, 18), mats.redHandle);
  eStopCap.position.set(leverX + 0.16, y + 1.05 + 0.155, z - facing * 0.1);
  cockpitGroup.add(eStopCollar, eStopCap);

  // 6. Magnetic Binnacle Compass
  const binGroup = new THREE.Group();
  binGroup.position.set(x, y + 1.04, z + facing * 0.32);

  // Cylindrical brass & wood binnacle pedestal
  const binPed = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.36, 24), mats.walnut);
  binPed.position.y = 0.18;
  const binHood = new THREE.Mesh(new THREE.SphereGeometry(0.14, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), mats.brass);
  binHood.position.y = 0.36;
  const binGlass = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.04, 24), mats.glassCover);
  binGlass.position.y = 0.37;

  // Floating compass card inside
  const cardGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.01, 32);
  const cardMat = new THREE.MeshBasicMaterial({ color: 0x11221c });
  const compCard = new THREE.Mesh(cardGeo, cardMat);
  compCard.position.y = 0.365;
  binGroup.add(binPed, binHood, binGlass, compCard);

  // Kelvin Quadrantal Corrector Spheres on lateral brass arms
  // Port = Red Sphere, Starboard = Green Sphere
  [
    { side: -1, mat: mats.redHandle },
    { side: 1, mat: mats.greenLed }
  ].forEach(({ side, mat }) => {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.22, 12), mats.brass);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(side * 0.22, 0.32, 0);
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.075, 18, 18), mat);
    sphere.position.set(side * 0.32, 0.32, 0);
    binGroup.add(arm, sphere);
  });
  cockpitGroup.add(binGroup);

  // 7. Toggle Switchboards & Status Annunciators
  const swX = x - Math.min(0.85, w * 0.28);
  const swBase = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 0.32), mats.consoleBody);
  swBase.position.set(swX, y + 1.04, z);
  cockpitGroup.add(swBase);

  // 8 Metal toggle switches with safety guards
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const tx = swX - 0.09 + col * 0.06;
      const tz = z - 0.08 + row * 0.14;
      const guard = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.04), mats.chrome);
      guard.position.set(tx, y + 1.08, tz);
      const tog = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.04, 8), mats.chrome);
      tog.rotation.x = 0.4;
      tog.position.set(tx, y + 1.09, tz);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 8), col % 2 === 0 ? mats.greenLed : mats.amberLed);
      led.position.set(tx, y + 1.07, tz + 0.035);
      cockpitGroup.add(guard, tog, led);
    }
  }

  // 8. Overhead Bridge Electronics Console (Deckhead Rack)
  const ceilY = bridgeRoom.y + bridgeRoom.h;
  const rackY = ceilY - 0.24;
  const rackZ = z + facing * 0.48;
  const rackW = Math.min(w * 0.85, 3.2);

  const rackGroup = new THREE.Group();
  rackGroup.position.set(x, rackY, rackZ);
  rackGroup.rotation.x = facing * 0.22; // angled downwards toward helmsman

  const rackBox = new THREE.Mesh(new THREE.BoxGeometry(rackW, 0.36, 0.42), mats.consoleBody);
  rackGroup.add(rackBox);

  // Marine VHF Radio Chassis in Overhead
  const vhfChassis = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.18, 0.05), mats.bezel);
  vhfChassis.position.set(-rackW * 0.25, 0.02, -facing * 0.22);
  const vhfLcd = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.08), new THREE.MeshBasicMaterial({ color: 0x0e2f18 }));
  vhfLcd.position.set(-rackW * 0.25 - 0.08, 0.02, -facing * 0.25);
  if (facing > 0) vhfLcd.rotation.y = Math.PI;
  rackGroup.add(vhfChassis, vhfLcd);

  // Master Warning & Annunciator Panel (Glowing tiles)
  const annBox = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.16, 0.04), mats.bezel);
  annBox.position.set(0.12, 0.02, -facing * 0.22);
  rackGroup.add(annBox);

  const tileMats = [mats.greenLed, mats.cyanLed, mats.greenLed, mats.amberLed, mats.greenLed, mats.cyanLed];
  for (let t = 0; t < 6; t++) {
    const tile = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.05), tileMats[t]);
    tile.position.set(-0.18 + t * 0.13, 0.02, -facing * 0.245);
    if (facing > 0) tile.rotation.y = Math.PI;
    rackGroup.add(tile);
  }

  // Two Recessed Red Night-Vision LED Spotlights in the Overhead Rack
  [-rackW * 0.36, rackW * 0.36].forEach((lx) => {
    const spotBezel = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.02, 16), mats.bezel);
    spotBezel.position.set(lx, -0.17, 0);
    rackGroup.add(spotBezel);

    const redSpot = new THREE.PointLight(0xff2211, 1.2, 3.5, 1.8);
    redSpot.position.set(x + lx, rackY - 0.22, rackZ);
    cockpitGroup.add(redSpot);
  });
  cockpitGroup.add(rackGroup);

  // 9. Captain's Ergonomic Marine Helm Chair
  const chairZ = z - facing * 1.55;
  const chairGroup = new THREE.Group();
  chairGroup.position.set(x, y, chairZ);

  // Polished chrome circular floor mounting base & pedestal
  const chairBase = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.04, 24), mats.chrome);
  chairBase.position.y = 0.02;
  const chairPillar = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.58, 20), mats.chrome);
  chairPillar.position.y = 0.32;
  const footRing = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.016, 12, 24), mats.chrome);
  footRing.rotation.x = Math.PI / 2;
  footRing.position.y = 0.26;
  chairGroup.add(chairBase, chairPillar, footRing);

  // Contoured Leather Seat Cushion with diamond-tufted accents
  const seatCushion = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.12, 0.54), mats.leather);
  seatCushion.position.set(0, 0.62, 0);
  chairGroup.add(seatCushion);

  // High Ergonomic Backrest with Integrated Headrest
  const backCushion = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.58, 0.1), mats.leather);
  backCushion.position.set(0, 0.96, facing * 0.24);
  const headrest = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.18, 0.09), mats.leather);
  headrest.position.set(0, 1.3, facing * 0.24);
  chairGroup.add(backCushion, headrest);

  // Flip-up Leather Armrests with Brass Cup Holders
  [-0.32, 0.32].forEach((ax) => {
    const armRest = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.38), mats.leather);
    armRest.position.set(ax, 0.78, 0);
    const armPost = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.18, 12), mats.chrome);
    armPost.position.set(ax, 0.68, facing * 0.12);
    const cupHolder = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.034, 0.04, 16), mats.brass);
    cupHolder.position.set(ax, 0.81, -facing * 0.14);
    chairGroup.add(armRest, armPost, cupHolder);
  });
  cockpitGroup.add(chairGroup);

  // 10. Dedicated Navigation Chart Station (Chart Table)
  if (Math.abs(bridgeRoom.x1 - bridgeRoom.x0) > 3.2) {
    const chartX = bridgeRoom.x1 - 1.25;
    const chartZ = bridgeRoom.z1 - 1.1;
    const chartW = 1.4;
    const chartD = 0.85;

    const chartGroup = new THREE.Group();
    chartGroup.position.set(chartX, y, chartZ);

    // Walnut chart desk with paper drawers
    const chartTableTop = new THREE.Mesh(new THREE.BoxGeometry(chartW, 0.06, chartD), mats.walnut);
    chartTableTop.position.y = 0.94;
    const chartCabinet = new THREE.Mesh(new THREE.BoxGeometry(chartW - 0.1, 0.88, chartD - 0.1), mats.consoleBody);
    chartCabinet.position.y = 0.45;
    chartGroup.add(chartTableTop, chartCabinet);

    // Navigation Nautical Sea Chart unrolled on desk
    const chartPaperGeo = new THREE.PlaneGeometry(chartW - 0.25, chartD - 0.22);
    chartPaperGeo.rotateX(-Math.PI / 2);
    const chartPaperMat = new THREE.MeshStandardMaterial({
      color: 0xf5f2e8,
      roughness: 0.9,
      map: loadTex('/assets/casino/textures/PH_black_walnut_veneer_01/Diffuse.jpg', [1, 1], true) // fallback or chart image
    });
    // Attempt live chart region map
    try {
      new THREE.TextureLoader().load('/api/chart/region.png', (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        chartPaperMat.map = t;
        chartPaperMat.color.set(0xffffff);
        chartPaperMat.needsUpdate = true;
      });
    } catch {}
    const chartPaper = new THREE.Mesh(chartPaperGeo, chartPaperMat);
    chartPaper.position.y = 0.975;
    chartGroup.add(chartPaper);

    // Brass Gooseneck Chart Lamp with warm cone of light
    const lampBase = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.02, 16), mats.brass);
    lampBase.position.set(chartW * 0.38, 0.98, chartD * 0.3);
    const lampArm = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.32, 10), mats.brass);
    lampArm.position.set(chartW * 0.38, 1.12, chartD * 0.26);
    lampArm.rotation.x = -0.4;
    const lampShade = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.1, 16), mats.brass);
    lampShade.position.set(chartW * 0.38, 1.25, chartD * 0.18);
    lampShade.rotation.x = Math.PI - 0.4;
    chartGroup.add(lampBase, lampArm, lampShade);

    const warmLamp = new THREE.PointLight(0xffe8ba, 1.8, 3.2, 1.6);
    warmLamp.position.set(chartX + chartW * 0.38, y + 1.24, chartZ + chartD * 0.18);
    cockpitGroup.add(warmLamp);

    // Nautical Tools: Parallel ruler, dividers, marine binoculars
    const ruler = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.008, 0.05), mats.chrome);
    ruler.position.set(-0.1, 0.98, -0.05);
    ruler.rotation.y = 0.25;
    const divider1 = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 0.14, 8), mats.brass);
    divider1.position.set(0.18, 0.98, 0.08);
    divider1.rotation.z = Math.PI / 2;
    chartGroup.add(ruler, divider1);

    cockpitGroup.add(chartGroup);
  }

  // 11. Soft Ambient Bridge Illumination (Realistic Warm Maritime Ambience)
  const bridgeSpot = new THREE.SpotLight(0xfff5e6, 2.5, 6.0, Math.PI / 3, 0.5, 1.5);
  bridgeSpot.position.set(x, ceilY - 0.15, z - facing * 0.6);
  bridgeSpot.target.position.set(x, y + 1.1, z);
  cockpitGroup.add(bridgeSpot, bridgeSpot.target);

  // 12. Forward Windscreen Wiper Motors & Clear-View Screen
  if (p.windscreen || true) {
    const glassZ = z + facing * (depth / 2 + 0.18);
    const winY = y + 1.55;
    // Window wiper motors above the glass panes
    [-0.8, 0.8].forEach((wx) => {
      const wiperMotor = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.08), mats.consoleBody);
      wiperMotor.position.set(x + wx, winY + 0.38, glassZ);
      const wiperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.38, 6), mats.blackPlastic);
      wiperArm.position.set(x + wx, winY + 0.18, glassZ - facing * 0.04);
      const wiperBlade = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.42, 0.015), mats.blackPlastic);
      wiperBlade.position.set(x + wx + 0.08, winY + 0.18, glassZ - facing * 0.04);
      cockpitGroup.add(wiperMotor, wiperArm, wiperBlade);
    });

    // Clear-view centrifugal rotating screen on center pane
    const cvsRing = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.015, 12, 32), mats.brass);
    cvsRing.position.set(x, winY + 0.1, glassZ - facing * 0.02);
    cockpitGroup.add(cvsRing);
  }

  // Store state for frame updates
  cockpitState = {
    interior,
    app: interior.app,
    conCv, conTex,
    ecdisCv, ecdisTex,
    radCv, radTex,
    portLeverArm, stbdLeverArm,
    wheelGroup,
    lastUpdate: 0,
    radarSweep: 0,
    textures: [conTex, ecdisTex, radTex]
  };

  // Perform initial canvas draw
  drawConningScreen(conCv, cockpitState.app);
  conTex.needsUpdate = true;
  drawEcdisScreen(ecdisCv, cockpitState.app);
  ecdisTex.needsUpdate = true;
  drawRadarScreen(radCv, cockpitState.app, 0);
  radTex.needsUpdate = true;
}

// -------------------------------------------------------------------------
// Live Screen Drawing Functions
// -------------------------------------------------------------------------

function drawConningScreen(cv, app) {
  const c = cv.getContext('2d');
  const W = cv.width, H = cv.height;

  // Background Glass Gradient
  const grad = c.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#040d18');
  grad.addColorStop(1, '#02060b');
  c.fillStyle = grad;
  c.fillRect(0, 0, W, H);

  // Top Status Header Bar
  c.fillStyle = 'rgba(10, 32, 54, 0.8)';
  c.fillRect(0, 0, W, 32);
  c.fillStyle = '#48c2ff';
  c.font = 'bold 13px "Courier New", monospace';
  c.fillText('INTEGRATED BRIDGE SYSTEM — CONNING', 14, 21);
  c.fillStyle = '#00ff88';
  c.fillText('SYS OK', W - 74, 21);

  const ship = app?.ship || { spd: 0, hdg: 0, throttle: 0, depth: 12.5, rudder: 0 };
  const sog = Math.abs(ship.spd || 0);
  const hdg = Math.round(ship.hdg || 0);
  const thr = Math.round((ship.throttle || 0) * 100);
  const depth = ship.depth != null ? ship.depth.toFixed(1) : '15.2';
  const rud = Math.round((ship.rudder || 0) * 35);

  // 1. Heading Gyro Tape (Top Center)
  c.fillStyle = 'rgba(7, 22, 38, 0.85)';
  c.fillRect(60, 42, W - 120, 44);
  c.strokeStyle = '#225577';
  c.strokeRect(60, 42, W - 120, 44);

  c.fillStyle = '#ffffff';
  c.font = 'bold 24px "Courier New", monospace';
  c.textAlign = 'center';
  c.fillText(`${String(hdg).padStart(3, '0')}°`, W / 2, 73);

  c.fillStyle = '#f5a623';
  c.font = '11px sans-serif';
  c.fillText('GYRO 1 — TRUE HEADING', W / 2, 98);

  // 2. Speed Over Ground Gauge (Left Box)
  c.fillStyle = 'rgba(6, 20, 34, 0.85)';
  c.fillRect(20, 115, 140, 120);
  c.strokeStyle = '#1b415e';
  c.strokeRect(20, 115, 140, 120);

  c.fillStyle = '#7ec5f8';
  c.font = 'bold 11px sans-serif';
  c.fillText('SOG (SPEED)', 90, 134);

  c.fillStyle = '#00ffcc';
  c.font = 'bold 38px "Courier New", monospace';
  c.fillText(sog.toFixed(1), 90, 180);

  c.fillStyle = '#89aabf';
  c.font = '12px sans-serif';
  c.fillText('KNOTS', 90, 204);

  // 3. Engine RPM & Telegraph Order (Center Box)
  c.fillStyle = 'rgba(6, 20, 34, 0.85)';
  c.fillRect(180, 115, 150, 120);
  c.strokeStyle = '#1b415e';
  c.strokeRect(180, 115, 150, 120);

  c.fillStyle = '#7ec5f8';
  c.font = 'bold 11px sans-serif';
  c.fillText('MAIN PROPULSION', 255, 134);

  c.fillStyle = thr >= 0 ? '#00ff88' : '#ff9900';
  c.font = 'bold 30px "Courier New", monospace';
  c.fillText(`${thr > 0 ? '+' : ''}${thr}%`, 255, 176);

  c.fillStyle = '#ffffff';
  c.font = '12px "Courier New", monospace';
  c.fillText(thr === 0 ? 'ALL STOP' : thr > 0 ? 'AHEAD' : 'ASTERN', 255, 202);

  // 4. Echo Sounder / Depth (Right Box)
  c.fillStyle = 'rgba(6, 20, 34, 0.85)';
  c.fillRect(350, 115, 140, 120);
  c.strokeStyle = '#1b415e';
  c.strokeRect(350, 115, 140, 120);

  c.fillStyle = '#7ec5f8';
  c.font = 'bold 11px sans-serif';
  c.fillText('DEPTH SOUNDER', 420, 134);

  c.fillStyle = '#ffffff';
  c.font = 'bold 38px "Courier New", monospace';
  c.fillText(depth, 420, 180);

  c.fillStyle = '#89aabf';
  c.font = '12px sans-serif';
  c.fillText('METRES (UKC)', 420, 204);

  // 5. Rudder Angle Bar Indicator (Bottom)
  c.fillStyle = 'rgba(7, 22, 38, 0.9)';
  c.fillRect(20, 252, W - 40, 52);
  c.strokeStyle = '#225577';
  c.strokeRect(20, 252, W - 40, 52);

  c.fillStyle = '#89aabf';
  c.font = '11px sans-serif';
  c.textAlign = 'left';
  c.fillText('PORT ◄ 35°', 32, 272);
  c.textAlign = 'right';
  c.fillText('35° ► STBD', W - 32, 272);
  c.textAlign = 'center';
  c.fillStyle = '#ffffff';
  c.fillText(`RUDDER: ${rud > 0 ? '+' : ''}${rud}°`, W / 2, 272);

  // Rudder bar graph
  const barMid = W / 2;
  const barLen = (rud / 35) * (W / 2 - 50);
  c.fillStyle = rud < 0 ? '#ff4444' : rud > 0 ? '#00dd66' : '#ffffff';
  c.fillRect(barMid, 282, barLen, 12);
  c.fillStyle = '#ffffff';
  c.fillRect(barMid - 1, 278, 2, 20); // zero center tick
}

function drawEcdisScreen(cv, app) {
  const c = cv.getContext('2d');
  const W = cv.width, H = cv.height;

  // Hydrographic Blue Chart Background
  c.fillStyle = '#0b233a';
  c.fillRect(0, 0, W, H);

  // Depth contours
  c.fillStyle = '#08314e';
  c.beginPath();
  c.arc(W * 0.4, H * 0.6, 180, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#074266';
  c.beginPath();
  c.arc(W * 0.4, H * 0.6, 110, 0, Math.PI * 2);
  c.fill();

  // Navigation Grid
  c.strokeStyle = 'rgba(50, 120, 180, 0.25)';
  c.lineWidth = 1;
  for (let x = 40; x < W; x += 60) {
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
  }
  for (let y = 30; y < H; y += 50) {
    c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
  }

  // Header
  c.fillStyle = 'rgba(5, 18, 30, 0.88)';
  c.fillRect(0, 0, W, 28);
  c.fillStyle = '#00e1ff';
  c.font = 'bold 12px "Courier New", monospace';
  c.textAlign = 'left';
  c.fillText('ECDIS — ELECTRONIC NAVIGATIONAL CHART', 12, 19);

  // Waypoints & Magenta Voyage Leg
  c.strokeStyle = '#ff00bb';
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(80, 240);
  c.lineTo(W / 2, H / 2);
  c.lineTo(380, 100);
  c.stroke();

  // Waypoint markers
  c.fillStyle = '#ffffff';
  c.font = 'bold 11px sans-serif';
  c.fillText('WP 01', 80, 258);
  c.fillText('WP 02 (NEXT)', 380, 88);

  // Vessel symbol at center
  const ship = app?.ship || { hdg: 0 };
  const rad = ((ship.hdg || 0) * Math.PI) / 180;

  c.save();
  c.translate(W / 2, H / 2);
  c.rotate(rad);

  // Heading line
  c.strokeStyle = '#ffff00';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(0, -70);
  c.stroke();

  // Vessel icon
  c.fillStyle = '#ff3333';
  c.strokeStyle = '#ffffff';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(0, -18);
  c.lineTo(10, 14);
  c.lineTo(-10, 14);
  c.closePath();
  c.fill();
  c.stroke();
  c.restore();

  // Position readout at bottom
  c.fillStyle = 'rgba(4, 14, 24, 0.9)';
  c.fillRect(0, H - 32, W, 32);
  c.fillStyle = '#a6cce8';
  c.font = '11px "Courier New", monospace';
  const lat = ship.lat != null ? Math.abs(ship.lat).toFixed(4) : '51.9214';
  const lon = ship.lon != null ? Math.abs(ship.lon).toFixed(4) : '04.1482';
  c.fillText(`POS: ${lat}°N  ${lon}°E  ·  CRS: ${(ship.hdg || 0).toFixed(0)}°  ·  SCALE: 1:25,000`, 12, H - 12);
}

function drawRadarScreen(cv, app, sweep) {
  const c = cv.getContext('2d');
  const W = cv.width, H = cv.height;

  // Radar Dark Phosphor Scope
  c.fillStyle = '#020b06';
  c.fillRect(0, 0, W, H);

  const cx = W / 2, cy = H / 2 + 10;
  const R = 130;

  // Header
  c.fillStyle = 'rgba(3, 16, 9, 0.85)';
  c.fillRect(0, 0, W, 28);
  c.fillStyle = '#00ff66';
  c.font = 'bold 12px "Courier New", monospace';
  c.textAlign = 'left';
  c.fillText('ARPA RADAR — 6.0 NM  HEAD-UP', 12, 19);

  // Range rings
  c.strokeStyle = 'rgba(0, 255, 100, 0.28)';
  c.lineWidth = 1;
  for (let r = 1; r <= 4; r++) {
    c.beginPath();
    c.arc(cx, cy, (R * r) / 4, 0, Math.PI * 2);
    c.stroke();
  }

  // Crosshairs
  c.beginPath();
  c.moveTo(cx, cy - R); c.lineTo(cx, cy + R);
  c.moveTo(cx - R, cy); c.lineTo(cx + R, cy);
  c.stroke();

  // Rotating Radar Sweep with phosphor gradient
  c.save();
  c.translate(cx, cy);
  c.rotate(sweep);

  const sweepGrad = c.createConicGradient ? c.createConicGradient(0, 0, 0) : null;
  if (sweepGrad) {
    sweepGrad.addColorStop(0, 'rgba(0, 255, 100, 0.0)');
    sweepGrad.addColorStop(0.85, 'rgba(0, 255, 100, 0.05)');
    sweepGrad.addColorStop(1, 'rgba(0, 255, 100, 0.35)');
    c.fillStyle = sweepGrad;
    c.beginPath();
    c.arc(0, 0, R, 0, Math.PI * 2);
    c.fill();
  }

  // Sweep line
  c.strokeStyle = 'rgba(100, 255, 150, 0.85)';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(0, -R);
  c.stroke();
  c.restore();

  // Simulated target echoes / AIS blips
  const targets = [
    { x: cx + 45, y: cy - 60, label: 'AIS 1' },
    { x: cx - 75, y: cy - 25, label: 'BUOY' },
    { x: cx + 85, y: cy + 40, label: 'FERRY' }
  ];
  c.fillStyle = '#00ff88';
  c.font = '10px monospace';
  for (const t of targets) {
    c.fillRect(t.x - 3, t.y - 3, 6, 6);
    c.fillText(t.label, t.x + 6, t.y + 4);
    // Speed vector line
    c.strokeStyle = '#00ff88';
    c.beginPath(); c.moveTo(t.x, t.y); c.lineTo(t.x + 8, t.y - 12); c.stroke();
  }
}

// -------------------------------------------------------------------------
// Per-Frame Update
// -------------------------------------------------------------------------

export function updateBridgeCockpit(dt, app) {
  if (!cockpitState) return;
  const now = performance.now();

  // Throttle dynamic canvas repaints to ~4 Hz for optimal rendering performance
  if (now - cockpitState.lastUpdate > 250) {
    cockpitState.lastUpdate = now;
    cockpitState.radarSweep = (cockpitState.radarSweep + dt * 1.8) % (Math.PI * 2);

    try {
      drawConningScreen(cockpitState.conCv, app);
      cockpitState.conTex.needsUpdate = true;

      drawEcdisScreen(cockpitState.ecdisCv, app);
      cockpitState.ecdisTex.needsUpdate = true;

      drawRadarScreen(cockpitState.radCv, app, cockpitState.radarSweep);
      cockpitState.radTex.needsUpdate = true;
    } catch (e) {
      console.warn('[cockpit] screen update', e);
    }
  }
}

export function disposeBridgeCockpit() {
  if (!cockpitState) return;
  for (const t of cockpitState.textures) t?.dispose?.();
  cockpitState = null;
}
