// ===== CampPropKit.js =====
// Shared camp prop library plus the plumbing props are built with.
//
//   CampContext   one per camp: the merged static mesh, the group for
//                 animated parts (flames, banners ...), the animation list
//                 and a seeded RNG.
//   Local         a placement frame (x, z, yaw, scale). Props draw in local
//                 coordinates and Local maps them into the world, so every
//                 prop can be placed, rotated and scaled freely while still
//                 landing in the single merged mesh.
//
// Local space: +x right, +y up, +z toward the viewer ("front" of a prop).
// Props never read the clock; animation closures are driven by
// CampContext.update(t).

import * as THREE from 'three';
import { MergedMesh, getGlowTexture } from './CampGeometry.js';
import { mulberry32 } from './CampMath.js';

export const C = {
  canvas: 0xdcd0aa, canvasShade: 0xbfb088, canvasDark: 0x8a7c5a,
  wood: 0x6e4e2c, woodDark: 0x48301c, woodLight: 0x8a6a3e,
  iron: 0x4a4f58, ironLight: 0x7a808a,
  gold: 0xd8b04a, bone: 0xdcd4b8, boneShade: 0xb0a88c,
  stone: 0x7a766c, stoneDark: 0x585650, stoneLight: 0x9a968a,
  straw: 0xc4a95a, hide: 0x7a5a34, dark: 0x16110c,
  red: 0xa83a32, blue: 0x2f5a98, hemp: 0xb89a62, rope: 0xa08a5a
};

export const FIRE = { outer: 0xff5a14, mid: 0xff9a2a, core: 0xffe070, glow: 0xff8a30, smoke: true };
export const GREEN_FIRE = { outer: 0x1f8a3a, mid: 0x5ae060, core: 0xd8ffc0, glow: 0x50ff70, smoke: false };

export function shade(hex, f) {
  return new THREE.Color(hex).multiplyScalar(f);
}

const SCALE_KEYS = ['x', 'y', 'z', 'cy', 'w', 'h', 'd', 'r', 'r2', 'R', 'tube'];

export class CampContext {
  constructor(seed) {
    this.merged = new MergedMesh();
    this.group = new THREE.Group();
    this.rng = mulberry32(seed);
    this._anim = [];
    this._mats = new Map();
  }

  local(x = 0, z = 0, ry = 0, k = 1) {
    return new Local(this, x, 0, z, ry, k);
  }

  animate(fn) {
    this._anim.push(fn);
  }

  update(t) {
    for (let i = 0; i < this._anim.length; i++) this._anim[i](t);
  }

  // Material cache keyed by string, so repeated props share materials.
  mat(key, factory) {
    let m = this._mats.get(key);
    if (!m) {
      m = factory();
      this._mats.set(key, m);
    }
    return m;
  }

  finish() {
    this.group.add(this.merged.build());
    return this.group;
  }
}

export class Local {
  constructor(ctx, x, y, z, ry, k) {
    this.ctx = ctx;
    this.m = ctx.merged;
    this.ox = x;
    this.oy = y;
    this.oz = z;
    this.ry = ry;
    this.k = k;
    this.c = Math.cos(ry);
    this.s = Math.sin(ry);
  }

  world(x, y, z) {
    const k = this.k;
    const lx = x * k;
    const lz = z * k;
    return [
      this.ox + lx * this.c + lz * this.s,
      this.oy + y * k,
      this.oz - lx * this.s + lz * this.c
    ];
  }

  // Child frame (offset / extra yaw / extra scale / lift) in local units.
  sub(x = 0, z = 0, ry = 0, k = 1, y = 0) {
    const w = this.world(x, y, z);
    return new Local(this.ctx, w[0], w[1], w[2], this.ry + ry, this.k * k);
  }

  _o(o) {
    const n = { ...o };
    for (const key of SCALE_KEYS) {
      if (n[key] !== undefined) n[key] *= this.k;
    }
    const x = n.x || 0;
    const z = n.z || 0;
    n.x = this.ox + x * this.c + z * this.s;
    n.z = this.oz - x * this.s + z * this.c;
    n.ry = (o.ry || 0) + this.ry;
    if (n.cy !== undefined) n.cy += this.oy;
    else n.y = (n.y || 0) + this.oy;
    return n;
  }

  box(o) { this.m.box(this._o(o)); return this; }
  cyl(o) { this.m.cyl(this._o(o)); return this; }
  cone(o) { this.m.cone(this._o(o)); return this; }
  ball(o) { this.m.ball(this._o(o)); return this; }
  rock(o) { this.m.rock(this._o(o)); return this; }
  ico(o) { this.m.ico(this._o(o)); return this; }
  torus(o) { this.m.torus(this._o(o)); return this; }
  disc(o) {
    this.m.disc(this._o({ ...o, y: o.y !== undefined ? o.y : 0.04 }));
    return this;
  }
  strut(a, b, r, color, seg, r2) {
    this.m.strut(
      this.world(a[0], a[1], a[2]),
      this.world(b[0], b[1], b[2]),
      r * this.k, color, seg, r2 === undefined ? undefined : r2 * this.k
    );
    return this;
  }
}

// --- animated effects -------------------------------------------------------

let _flameGeo = null;
function flameGeo() {
  if (!_flameGeo) {
    _flameGeo = new THREE.ConeGeometry(0.3, 1, 7, 1, true);
    _flameGeo.translate(0, 0.5, 0);
  }
  return _flameGeo;
}

// Soft additive glow that can pulse. Used for lanterns, orbs, wisps.
export function glowSprite(L, o = {}) {
  const ctx = L.ctx;
  const size = (o.size ?? 1.5) * L.k;
  const w = L.world(o.x || 0, o.y || 0, o.z || 0);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getGlowTexture(), color: o.color ?? 0xffc060,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    opacity: o.opacity ?? 0.8
  }));
  sprite.position.set(w[0], w[1], w[2]);
  sprite.scale.set(size, size, 1);
  ctx.group.add(sprite);
  if (o.pulse !== false) {
    const ph = ctx.rng() * 10;
    ctx.animate((t) => {
      const s = size * (1 + 0.1 * Math.sin(t * 7 + ph) + 0.05 * Math.sin(t * 19 + ph));
      sprite.scale.set(s, s, 1);
    });
  }
  return sprite;
}

// Flickering flame stack + glow + (optional) rising smoke.
export function fireFx(L, o = {}) {
  const ctx = L.ctx;
  const pal = o.palette || FIRE;
  const k = (o.size ?? 1) * L.k;
  const w = L.world(o.x || 0, o.y || 0, o.z || 0);
  const ph = ctx.rng() * 20;

  const g = new THREE.Group();
  g.position.set(w[0], w[1], w[2]);
  ctx.group.add(g);

  const spec = [[pal.outer, 0.8, 1.15], [pal.mid, 0.55, 0.85], [pal.core, 0.34, 0.55]];
  const flames = spec.map(([c, wd, ht]) => {
    const mesh = new THREE.Mesh(flameGeo(), ctx.mat('flame' + c, () => new THREE.MeshBasicMaterial({
      color: c, transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false
    })));
    g.add(mesh);
    return { mesh, wd, ht };
  });

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getGlowTexture(), color: pal.glow, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, opacity: 0.85
  }));
  glow.position.y = 0.6 * k;
  g.add(glow);

  const puffs = [];
  if (pal.smoke !== false && o.smoke !== false) {
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getGlowTexture(), color: 0x7a7470, transparent: true, depthWrite: false, opacity: 0
      }));
      g.add(p);
      puffs.push(p);
    }
  }

  ctx.animate((t) => {
    for (let i = 0; i < flames.length; i++) {
      const f = flames[i];
      const s = 0.85 + 0.22 * Math.sin(t * 9 + ph + i * 1.9) + 0.12 * Math.sin(t * 23 + ph * 2 + i);
      f.mesh.scale.set(
        f.wd * k * (0.92 + 0.1 * Math.sin(t * 7 + i + ph)),
        f.ht * k * s,
        f.wd * k * (0.92 + 0.1 * Math.cos(t * 8 + i + ph))
      );
      f.mesh.rotation.y = t * 1.5 + i;
    }
    const gs = 3.4 * k * (1 + 0.08 * Math.sin(t * 13 + ph) + 0.05 * Math.sin(t * 31));
    glow.scale.set(gs, gs, 1);
    for (let i = 0; i < puffs.length; i++) {
      const u = (((t * 0.22 + i / puffs.length + ph) % 1) + 1) % 1;
      const p = puffs[i];
      p.position.set(Math.sin(u * 5 + ph + i) * 0.3 * k, (0.9 + u * 3.2) * k, 0);
      const sc = (0.7 + u * 2.2) * k;
      p.scale.set(sc, sc, 1);
      p.material.opacity = 0.2 * Math.sin(u * Math.PI);
    }
  });
}

// --- flags -------------------------------------------------------------------

let _flagGeo = null;
let _emblemGeo = null;
function flagGeo() {
  if (!_flagGeo) {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(1.15, 0);
    s.lineTo(0.93, -0.36);
    s.lineTo(1.15, -0.72);
    s.lineTo(0, -0.72);
    s.closePath();
    _flagGeo = new THREE.ShapeGeometry(s);
  }
  return _flagGeo;
}
function emblemGeo() {
  if (!_emblemGeo) _emblemGeo = new THREE.CircleGeometry(0.17, 10);
  return _emblemGeo;
}

// Pole with a swallow-tail banner that sways in the wind.
export function banner(L, o = {}) {
  const ctx = L.ctx;
  const h = o.h ?? 4.4;
  const col = new THREE.Color(o.color ?? C.blue).getHex();
  const trim = new THREE.Color(o.trim ?? C.gold).getHex();

  L.cyl({ r: 0.09, r2: 0.06, h, seg: 6, color: C.wood });
  L.cyl({ r: 0.2, r2: 0.14, h: 0.25, seg: 6, color: C.woodDark });
  L.ball({ r: 0.11, y: h + 0.1, seg: 6, color: C.gold });
  L.box({ x: 0.55, y: h - 0.3, w: 1.25, h: 0.06, d: 0.06, color: C.woodDark });

  const w = L.world(0, h - 0.32, 0);
  const pivot = new THREE.Group();
  pivot.position.set(w[0], w[1], w[2]);
  pivot.scale.setScalar(L.k);
  ctx.group.add(pivot);

  const flag = new THREE.Mesh(flagGeo(), ctx.mat('flag' + col,
    () => new THREE.MeshLambertMaterial({ color: col, side: THREE.DoubleSide })));
  flag.position.x = 0.04;
  pivot.add(flag);
  const emblem = new THREE.Mesh(emblemGeo(), ctx.mat('emb' + trim,
    () => new THREE.MeshLambertMaterial({ color: trim, side: THREE.DoubleSide })));
  emblem.position.set(0.5, -0.36, 0.012);
  flag.add(emblem);

  const ph = ctx.rng() * 10;
  ctx.animate((t) => {
    pivot.rotation.y = L.ry + 0.18 * Math.sin(t * 1.6 + ph);
    flag.rotation.z = 0.05 * Math.sin(t * 3.1 + ph);
    flag.rotation.y = 0.12 * Math.sin(t * 2.3 + ph * 2);
  });
}

// --- tents --------------------------------------------------------------------

// Large striped command pavilion with trim, finial, door flaps and ropes.
export function pavilion(L, o = {}) {
  const c1 = o.c1 ?? 0xe8dfc4;
  const c2 = o.c2 ?? 0xa4322e;
  const R = 3.2;
  const wallH = 1.5;

  L.disc({ r: R + 1.1, y: 0.035, seg: 24, color: 0x5a3a2a });
  const T = L.sub(0, 0, -Math.PI / 8);
  T.cyl({ r: R, h: wallH, seg: 8, open: true, color: (t) => (((t >> 1) % 2) ? c1 : c2) });
  T.cone({ r: R + 0.45, h: 2.9, y: wallH - 0.05, seg: 8, color: (t) => ((t % 2) ? c1 : c2) });
  T.cyl({ r: R + 0.47, h: 0.14, y: wallH - 0.1, seg: 8, open: true, color: C.gold });
  T.cyl({ r: 0.07, r2: 0.05, h: 1.3, y: wallH + 2.7, seg: 5, color: C.wood });
  T.ball({ r: 0.2, y: wallH + 4.1, seg: 6, color: C.gold });

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const s = Math.sin(a);
    const c = Math.cos(a);
    T.strut([s * (R + 0.4), 1.4, c * (R + 0.4)], [s * (R + 1.7), 0.05, c * (R + 1.7)], 0.025, C.rope, 4);
    T.cone({ x: s * (R + 1.7), z: c * (R + 1.7), y: 0, r: 0.06, h: 0.25, seg: 4, color: C.woodDark });
  }

  const dz = R * Math.cos(Math.PI / 8) + 0.03;
  L.box({ z: dz, w: 1.5, h: 1.25, d: 0.08, color: C.dark });
  L.box({ x: -0.95, z: dz + 0.05, w: 0.55, h: 1.3, d: 0.07, ry: -0.45, color: c2 });
  L.box({ x: 0.95, z: dz + 0.05, w: 0.55, h: 1.3, d: 0.07, ry: 0.45, color: c2 });
  L.box({ z: dz + 0.06, y: 1.25, w: 1.9, h: 0.12, d: 0.1, color: C.gold });
}

// Round bell tent with door, finial and guy ropes.
export function bellTent(L, o = {}) {
  const col = o.color ?? C.canvas;
  const dark = shade(col, 0.82);
  const light = new THREE.Color(col);
  L.cyl({ r: 1.45, h: 0.95, seg: 10, open: true, color: col });
  L.cone({ r: 1.72, h: 1.7, y: 0.9, seg: 10, color: (t) => ((t % 2) ? light : dark) });
  L.cyl({ r: 0.05, r2: 0.03, h: 0.55, y: 2.5, seg: 4, color: C.wood });
  L.ball({ r: 0.1, y: 3.05, seg: 5, color: C.gold });
  L.box({ z: 1.44, w: 0.8, h: 0.95, d: 0.06, color: C.dark });
  L.box({ z: 1.46, y: 0.95, w: 0.9, h: 0.08, d: 0.06, color: C.wood });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const s = Math.sin(a);
    const c = Math.cos(a);
    L.strut([s * 0.95, 1.55, c * 0.95], [s * 2.5, 0.05, c * 2.5], 0.02, C.rope, 4);
    L.cone({ x: s * 2.5, z: c * 2.5, y: 0, r: 0.05, h: 0.2, seg: 4, color: C.woodDark });
  }
}

// --- camp life ------------------------------------------------------------------

export function campfire(L, o = {}) {
  const rng = L.ctx.rng;
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    L.rock({
      x: Math.cos(a) * 0.62, z: Math.sin(a) * 0.62, y: 0.1,
      r: 0.17 + rng() * 0.06, sy: 0.75, rx: rng() * 3, ry: rng() * 3,
      color: shade(C.stone, 0.8 + rng() * 0.4)
    });
  }
  L.disc({ r: 0.5, y: 0.05, seg: 10, color: 0x1c1612 });
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + 0.5;
    L.strut([Math.cos(a) * 0.55, 0.16, Math.sin(a) * 0.55], [Math.cos(a) * 0.05, 0.34, Math.sin(a) * 0.05],
      0.075, C.woodDark, 5);
  }
  L.disc({ r: 0.3, y: 0.08, seg: 8, color: 0xd8642a });
  if (o.seats !== false) {
    L.cyl({ x: 1.45, z: 0.2, cy: 0.18, r: 0.16, h: 1.3, rx: Math.PI / 2, ry: 0.25, seg: 6, color: C.wood });
    L.cyl({ x: -1.3, z: 0.6, cy: 0.18, r: 0.16, h: 1.2, rx: Math.PI / 2, ry: -0.3, seg: 6, color: C.wood });
  }
  fireFx(L, { y: 0.2, size: o.size ?? 1 });
}

export function crate(L, o = {}) {
  const s = o.s ?? 0.7;
  L.box({ w: s, h: s, d: s, color: C.wood });
  L.box({ w: s + 0.04, h: 0.07, d: s + 0.04, color: C.woodDark });
  L.box({ y: s - 0.07, w: s + 0.04, h: 0.07, d: s + 0.04, color: C.woodDark });
  L.box({ z: s / 2 + 0.01, y: 0.05, w: 0.08, h: s - 0.1, d: 0.02, color: C.woodDark });
}

export function barrel(L) {
  L.cyl({ r: 0.3, r2: 0.27, h: 0.9, seg: 8, color: C.wood });
  L.cyl({ r: 0.34, r2: 0.34, h: 0.05, y: 0.2, seg: 8, color: C.iron });
  L.cyl({ r: 0.34, r2: 0.34, h: 0.05, y: 0.62, seg: 8, color: C.iron });
  L.disc({ r: 0.26, y: 0.9, seg: 8, color: C.woodLight });
}

export function sacks(L) {
  L.ball({ x: 0, y: 0.25, r: 0.32, sy: 0.8, seg: 6, color: C.hemp });
  L.ball({ x: 0.5, z: 0.1, y: 0.24, r: 0.3, sy: 0.8, seg: 6, color: shade(C.hemp, 0.9) });
  L.ball({ x: 0.25, z: -0.2, y: 0.62, r: 0.28, sy: 0.8, seg: 6, color: shade(C.hemp, 1.05) });
}

export function hayBale(L) {
  L.box({ w: 1.1, h: 0.58, d: 0.65, color: C.straw });
  L.box({ x: -0.25, w: 0.05, h: 0.6, d: 0.67, color: C.rope });
  L.box({ x: 0.25, w: 0.05, h: 0.6, d: 0.67, color: C.rope });
}

export function weaponRack(L) {
  for (const x of [-1.05, 1.05]) L.box({ x, w: 0.12, h: 1.5, d: 0.12, color: C.woodDark });
  L.box({ y: 0.45, w: 2.3, h: 0.08, d: 0.1, color: C.wood });
  L.box({ y: 1.05, w: 2.3, h: 0.08, d: 0.1, color: C.wood });
  for (let i = 0; i < 5; i++) {
    const x = -0.8 + i * 0.4;
    L.strut([x, 0.1, -0.12], [x + 0.05, 2.1, 0], 0.025, C.wood, 4);
    L.cone({ x: x + 0.05, z: 0, y: 2.1, r: 0.05, h: 0.22, seg: 4, color: C.ironLight });
  }
  L.cyl({ x: -0.55, z: 0.12, cy: 0.8, r: 0.3, h: 0.05, rx: Math.PI / 2, seg: 10, color: C.red });
  L.cyl({ x: 0.55, z: 0.12, cy: 0.8, r: 0.3, h: 0.05, rx: Math.PI / 2, seg: 10, color: C.blue });
  L.ball({ x: -0.55, z: 0.16, y: 0.8, r: 0.08, seg: 5, color: C.gold });
  L.ball({ x: 0.55, z: 0.16, y: 0.8, r: 0.08, seg: 5, color: C.gold });
}

export function dummy(L) {
  L.cyl({ r: 0.08, h: 1.7, seg: 5, color: C.wood });
  L.cyl({ r: 0.28, r2: 0.22, h: 0.08, seg: 6, color: C.woodDark });
  L.box({ y: 0.85, w: 0.52, h: 0.7, d: 0.26, color: C.straw });
  L.box({ y: 1.38, w: 1.1, h: 0.1, d: 0.1, color: C.wood });
  L.ball({ y: 1.75, r: 0.17, seg: 6, color: C.hemp });
  L.cyl({ x: 0.3, z: 0.16, cy: 1.0, r: 0.2, h: 0.04, rx: Math.PI / 2, seg: 8, color: C.iron });
}

// Open supply cart with a load and a drawbar.
export function wagon(L) {
  L.box({ y: 0.55, w: 1.6, h: 0.18, d: 3.1, color: C.wood });
  for (const sx of [-1, 1]) {
    L.box({ x: sx * 0.8, y: 0.7, w: 0.08, h: 0.45, d: 3.1, color: C.woodLight });
  }
  L.box({ y: 0.7, z: -1.55, w: 1.6, h: 0.45, d: 0.08, color: C.woodLight });
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const x = sx * 0.95;
      const z = sz * 0.95;
      L.torus({ x, y: 0.5, z, R: 0.5, tube: 0.06, ry: Math.PI / 2, seg: 14, color: C.woodDark });
      L.strut([x, 0.5, z - 0.5], [x, 0.5, z + 0.5], 0.035, C.wood, 4);
      L.strut([x, 0, z], [x, 1.0, z], 0.035, C.wood, 4);
      L.ball({ x, y: 0.5, z, r: 0.1, seg: 5, color: C.iron });
    }
  }
  L.strut([0, 0.5, 1.5], [0, 0.35, 3.3], 0.06, C.woodDark, 5);
  const S = L.sub(0, -0.3, 0.2, 1, 0.64);
  crate(S.sub(-0.3, 0.3, 0.1), { s: 0.62 });
  barrel(S.sub(0.38, -0.2));
  sacks(S.sub(-0.1, -0.85, 0.3));
}

export function watchtower(L) {
  const H = 5.2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) L.strut([sx * 1.15, 0, sz * 1.15], [sx * 0.9, H, sz * 0.9], 0.11, C.wood, 5);
  }
  for (const y of [1.8, 3.5]) {
    const f = 1.15 - (y / H) * 0.25;
    L.box({ y, z: f, w: f * 2, h: 0.1, d: 0.1, color: C.woodDark });
    L.box({ y, z: -f, w: f * 2, h: 0.1, d: 0.1, color: C.woodDark });
    L.box({ y, x: f, w: 0.1, h: 0.1, d: f * 2, color: C.woodDark });
    L.box({ y, x: -f, w: 0.1, h: 0.1, d: f * 2, color: C.woodDark });
  }
  L.strut([-1.1, 0.2, 1.1], [0.9, 3.4, 0.95], 0.05, C.woodDark, 4);
  L.strut([1.1, 0.2, 1.1], [-0.9, 3.4, 0.95], 0.05, C.woodDark, 4);
  L.box({ y: H, w: 2.7, h: 0.14, d: 2.7, color: C.woodLight });
  for (const [x, z, w, d] of [[0, 1.3, 2.7, 0.1], [0, -1.3, 2.7, 0.1], [1.3, 0, 0.1, 2.7], [-1.3, 0, 0.1, 2.7]]) {
    L.box({ x, z, y: H + 0.14, w, h: 0.55, d, color: C.wood });
    L.box({ x, z, y: H + 0.85, w, h: 0.08, d, color: C.woodDark });
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) L.strut([sx * 1.25, H, sz * 1.25], [sx * 1.25, H + 2.2, sz * 1.25], 0.07, C.woodDark, 4);
  }
  L.cone({ r: 2.3, h: 1.4, y: H + 2.1, seg: 4, ry: Math.PI / 4, color: (t) => ((t % 2) ? 0x6a3a2a : 0x5a3024) });
  for (const x of [-0.25, 0.25]) L.strut([x, 0, 1.4], [x, H, 1.05], 0.05, C.wood, 4);
  for (let i = 1; i < 7; i++) L.box({ y: (i / 7) * H, z: 1.4 - (i / 7) * 0.35, w: 0.55, h: 0.05, d: 0.06, color: C.wood });
  glowSprite(L, { y: H + 1.2, z: 1.3, x: 1.2, size: 1.6, color: 0xffa050 });
}

// Row of sharpened stakes along local +x.
export function palisade(L, o = {}) {
  const len = o.len ?? 12;
  const h = o.h ?? 2.4;
  const rng = L.ctx.rng;
  const n = Math.round(len / 0.42);
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * len;
    const hh = h * (0.9 + rng() * 0.2);
    L.cyl({ x, r: 0.14, r2: 0.13, h: hh, seg: 5, color: shade(C.wood, 0.85 + rng() * 0.3) });
    L.cone({ x, y: hh, r: 0.14, h: 0.38, seg: 5, color: shade(C.woodLight, 0.9 + rng() * 0.2) });
  }
  L.box({ x: len / 2, z: 0.15, y: 0.6, w: len, h: 0.12, d: 0.1, color: C.woodDark });
  L.box({ x: len / 2, z: 0.15, y: 1.5, w: len, h: 0.12, d: 0.1, color: C.woodDark });
}

export function fence(L, o = {}) {
  const len = o.len ?? 6;
  const n = Math.max(1, Math.round(len / 1.4));
  for (let i = 0; i <= n; i++) L.cyl({ x: (i / n) * len, r: 0.07, h: 1.3, seg: 5, color: C.woodDark });
  L.box({ x: len / 2, y: 0.55, w: len, h: 0.07, d: 0.07, color: C.wood });
  L.box({ x: len / 2, y: 1.0, w: len, h: 0.07, d: 0.07, color: C.wood });
}

export function table(L) {
  L.box({ y: 0.78, w: 2.6, h: 0.09, d: 1.0, color: C.woodLight });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) L.box({ x: sx * 1.15, z: sz * 0.38, w: 0.1, h: 0.78, d: 0.1, color: C.woodDark });
  }
  L.box({ x: -0.3, y: 0.87, w: 0.9, h: 0.015, d: 0.6, color: 0xd8c89a });
  for (const [x, z] of [[0.7, 0.2], [0.95, -0.15]]) {
    L.cyl({ x, z, y: 0.87, r: 0.06, h: 0.12, seg: 6, color: C.ironLight });
  }
  L.cyl({ x: -0.95, z: -0.2, y: 0.87, r: 0.03, h: 0.2, seg: 5, color: 0xeadfb8 });
  glowSprite(L, { x: -0.95, y: 1.1, z: -0.2, size: 0.8, color: 0xffd080 });
  for (const sz of [-1, 1]) {
    L.box({ z: sz * 0.95, y: 0.42, w: 2.4, h: 0.08, d: 0.32, color: C.wood });
    for (const sx of [-1, 1]) L.box({ x: sx * 1.0, z: sz * 0.95, w: 0.08, h: 0.42, d: 0.28, color: C.woodDark });
  }
}

// Low-poly horse, body along local x.
export function horse(L, o = {}) {
  const body = o.color ?? 0x6a4428;
  const mane = shade(body, 0.55);
  L.ball({ y: 1.15, r: 0.5, sx: 1.55, sy: 0.8, sz: 0.75, seg: 7, color: body });
  L.strut([0.65, 1.3, 0], [1.1, 1.95, 0], 0.17, body, 5, 0.12);
  L.strut([1.1, 1.95, 0], [1.55, 1.7, 0], 0.12, body, 5, 0.08);
  L.cone({ x: 1.05, z: 0.07, y: 1.98, r: 0.04, h: 0.16, seg: 4, color: body });
  L.cone({ x: 1.05, z: -0.07, y: 1.98, r: 0.04, h: 0.16, seg: 4, color: body });
  L.strut([0.7, 1.45, 0], [1.08, 2.0, 0], 0.05, mane, 4);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      L.strut([sx * 0.5, 1.0, sz * 0.2], [sx * 0.52, 0.05, sz * 0.2], 0.07, body, 4, 0.045);
    }
  }
  L.strut([-0.75, 1.25, 0], [-1.05, 0.5, 0], 0.07, mane, 4, 0.03);
}

// Street-lamp on a pole (the palette picks flame colour).
export function lampPost(L, o = {}) {
  L.cyl({ r: 0.07, r2: 0.05, h: 2.6, seg: 5, color: C.iron });
  L.box({ y: 2.6, w: 0.34, h: 0.4, d: 0.34, color: o.lamp ?? 0xe8c070 });
  L.cone({ y: 3.0, r: 0.3, h: 0.28, seg: 4, ry: Math.PI / 4, color: C.iron });
  glowSprite(L, { y: 2.8, size: 2.2, color: o.glow ?? 0xffb860 });
}