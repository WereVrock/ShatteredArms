// ===== CampPropKitDark.js =====
// Faction-specific props: goblin (bone, hide, crude), hobgoblin (ordered,
// iron, red) and undead (stone, graves, green fire). Uses the Local /
// CampContext plumbing from CampPropKit.

import * as THREE from 'three';
import { C, shade, fireFx, glowSprite, banner, FIRE, GREEN_FIRE } from './CampPropKit.js';

// --- shared bone things ---------------------------------------------------------

export function skull(L, x, y, z, s = 1, ry = 0) {
  const S = L.sub(x, z, ry, s, y);
  S.ball({ r: 0.2, sy: 0.95, seg: 7, color: C.bone });
  S.box({ z: 0.1, cy: -0.17, w: 0.2, h: 0.1, d: 0.16, color: C.boneShade });
  S.ball({ x: -0.08, y: 0.02, z: 0.17, r: 0.05, seg: 4, color: C.dark });
  S.ball({ x: 0.08, y: 0.02, z: 0.17, r: 0.05, seg: 4, color: C.dark });
  S.box({ y: -0.06, z: 0.19, w: 0.04, h: 0.06, d: 0.03, color: C.dark });
}

export function bonePile(L) {
  const rng = L.ctx.rng;
  for (let i = 0; i < 11; i++) {
    const a = rng() * Math.PI * 2;
    const r0 = rng() * 0.5;
    const from = [Math.cos(a) * r0, 0.08 + rng() * 0.25, Math.sin(a) * r0];
    const b = rng() * Math.PI * 2;
    const to = [from[0] + Math.cos(b) * 0.6, from[1] + (rng() - 0.3) * 0.3, from[2] + Math.sin(b) * 0.6];
    L.strut(from, to, 0.05, shade(C.bone, 0.85 + rng() * 0.2), 4);
    L.ball({ x: to[0], y: to[1], z: to[2], r: 0.07, seg: 4, color: C.bone });
  }
  skull(L, 0.1, 0.32, 0.05, 1.1, rng() * 3);
}

// --- goblin -----------------------------------------------------------------------

export function hideTent(L, o = {}) {
  const rng = L.ctx.rng;
  const pal = [0x7a5a34, 0x6a4c2a, 0x8a6a40, 0x5a4228, 0x4a3c2a];
  const faces = Array.from({ length: 7 }, () => pal[(rng() * pal.length) | 0]);
  L.cone({ r: 1.55, h: 2.2, seg: 7, color: (t) => faces[t % 7] });
  L.strut([-0.5, 3.0, 0], [0.5, 1.9, 0], 0.05, C.bone, 4);
  L.strut([0.5, 3.0, 0], [-0.5, 1.9, 0], 0.05, C.bone, 4);
  L.box({ z: 1.17, cy: 0.55, w: 0.7, h: 1.1, d: 0.05, rx: -0.6, color: C.dark });
  skull(L, 0, 1.55, 0.78, 1.0);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    L.strut([Math.sin(a) * 0.9, 1.1, Math.cos(a) * 0.9], [Math.sin(a) * 2.2, 0.05, Math.cos(a) * 2.2], 0.025, C.rope, 4);
    L.cone({ x: Math.sin(a) * 2.2, z: Math.cos(a) * 2.2, r: 0.05, h: 0.22, seg: 4, color: C.bone });
  }
  if (o.trophy !== false) {
    L.cyl({ x: 1.9, z: 0.8, r: 0.05, h: 1.6, seg: 4, color: C.wood });
    skull(L, 1.9, 1.7, 0.8, 0.9, 0.5);
  }
}

export function totem(L) {
  L.cyl({ r: 0.14, r2: 0.1, h: 4.2, seg: 6, color: 0x3a2410 });
  L.cyl({ r: 0.3, r2: 0.2, h: 0.4, seg: 6, color: C.woodDark });
  for (let i = 0; i < 4; i++) skull(L, 0.14, 1.5 + i * 0.7, 0.04, 1.0, 0.3 - i * 0.2);
  L.box({ y: 3.1, w: 1.5, h: 0.08, d: 0.08, color: C.bone });
  const cols = [0xa83a32, 0x2a8a8a, 0xd8b04a];
  for (let i = 0; i < 3; i++) {
    const x = -0.65 + i * 0.65;
    L.strut([x, 3.1, 0], [x + 0.08, 2.4, 0.05], 0.03, cols[i], 4);
    L.ball({ x: x + 0.08, y: 2.35, z: 0.05, r: 0.06, sy: 1.8, seg: 4, color: cols[i] });
  }
  L.cone({ x: -0.18, y: 4.15, r: 0.07, h: 0.5, rz: 0.4, seg: 4, color: C.bone });
  L.cone({ x: 0.18, y: 4.15, r: 0.07, h: 0.5, rz: -0.4, seg: 4, color: C.bone });
  glowSprite(L, { y: 4.4, size: 1.6, color: 0x80ff70, opacity: 0.55 });
}

export function cage(L) {
  const h = 1.8;
  const w = 1.5;
  L.box({ w: w + 0.2, h: 0.15, d: w + 0.2, color: C.woodDark });
  L.box({ y: h, w: w + 0.2, h: 0.12, d: w + 0.2, color: C.woodDark });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) L.box({ x: sx * w / 2, z: sz * w / 2, y: 0.15, w: 0.1, h: h - 0.15, d: 0.1, color: C.iron });
  }
  for (let i = 0; i < 5; i++) {
    const p = -w / 2 + 0.2 + i * (w - 0.4) / 4;
    for (const [x, z] of [[p, w / 2], [p, -w / 2], [w / 2, p], [-w / 2, p]]) {
      L.cyl({ x, z, y: 0.15, r: 0.025, h: h - 0.15, seg: 4, color: C.ironLight });
    }
  }
  skull(L, 0.1, 0.35, 0.1, 1.1, 0.8);
  L.strut([-0.4, 0.2, -0.2], [0.3, 0.22, -0.3], 0.05, C.bone, 4);
  L.strut([0.35, h + 0.1, 0], [0.9, h + 1.4, 0.2], 0.03, C.iron, 4);
}

export function cauldron(L) {
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    L.strut([Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95], [0, 1.7, 0], 0.05, C.iron, 4);
  }
  fireFx(L, { y: 0.15, size: 0.9 });
  L.ball({ y: 1.0, r: 0.58, sy: 0.85, seg: 8, color: C.iron });
  L.torus({ y: 1.38, R: 0.5, tube: 0.07, rx: Math.PI / 2, seg: 10, color: C.ironLight });
  L.disc({ y: 1.36, r: 0.47, seg: 10, color: 0x6ad060 });
  glowSprite(L, { y: 1.6, size: 2.2, color: 0x60ff60, opacity: 0.5 });
  L.strut([0.2, 1.4, 0.1], [0.8, 2.0, 0.5], 0.03, C.wood, 4);
  for (let i = 0; i < 4; i++) L.rock({ x: Math.cos(i * 1.6) * 0.5, z: Math.sin(i * 1.6) * 0.5, y: 0.1, r: 0.16, sy: 0.7, color: C.stone });
}

export function meatRack(L) {
  for (const sx of [-1, 1]) {
    L.strut([sx * 1.1, 0, 0.35], [sx * 1.1, 1.9, 0], 0.07, C.wood, 4);
    L.strut([sx * 1.1, 0, -0.35], [sx * 1.1, 1.9, 0], 0.07, C.wood, 4);
  }
  L.box({ y: 1.88, w: 2.4, h: 0.08, d: 0.08, color: C.woodDark });
  for (let i = 0; i < 4; i++) {
    const x = -0.85 + i * 0.57;
    L.strut([x, 1.88, 0], [x, 1.3, 0], 0.015, C.rope, 3);
    L.ball({ x, y: 1.1, r: 0.17, sy: 1.5, seg: 5, color: i % 2 ? 0x9a4a3a : 0x7a3a2a });
  }
}

export function warDrum(L) {
  L.cyl({ r: 0.5, r2: 0.46, h: 0.7, seg: 10, color: C.hide });
  L.disc({ y: 0.7, r: 0.48, seg: 10, color: 0xd8c8a0 });
  L.torus({ y: 0.7, R: 0.5, tube: 0.04, rx: Math.PI / 2, seg: 10, color: C.woodDark });
  L.torus({ y: 0.05, R: 0.5, tube: 0.04, rx: Math.PI / 2, seg: 10, color: C.woodDark });
  L.strut([0.9, 0.05, 0.3], [0.65, 0.8, 0.1], 0.03, C.wood, 4);
  L.strut([0.75, 0.05, 0.5], [0.55, 0.8, 0.2], 0.03, C.wood, 4);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    L.strut([Math.cos(a) * 0.48, 0.1, Math.sin(a) * 0.48], [Math.cos(a + 0.3) * 0.46, 0.6, Math.sin(a + 0.3) * 0.46], 0.01, C.rope, 3);
  }
}

// Leaning, interwoven stakes with skulls on some tips.
export function spikedFence(L, o = {}) {
  const len = o.len ?? 12;
  const rng = L.ctx.rng;
  const n = Math.round(len / 0.55);
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * len;
    const lean = (i % 2 ? 1 : -1) * 0.25;
    const top = 2.0 + rng() * 0.5;
    L.strut([x, 0, 0], [x + lean, top, 0], 0.09, shade(C.wood, 0.8 + rng() * 0.3), 5, 0.04);
    if (rng() < 0.18) skull(L, x + lean, top + 0.22, 0, 0.8, rng() * 2);
  }
  L.strut([0, 0.8, 0.02], [len, 0.8, 0.02], 0.03, C.rope, 4);
  L.strut([0, 1.4, 0.02], [len, 1.4, 0.02], 0.03, C.rope, 4);
}

// --- hobgoblin ----------------------------------------------------------------------

export function warTent(L, o = {}) {
  const col = o.color ?? 0x4a4440;
  const dark = shade(col, 0.8);
  const light = new THREE.Color(col);
  const trim = o.trim ?? C.red;
  L.box({ w: 3.5, h: 1.3, d: 3.5, color: col });
  L.cone({ r: 2.6, h: 1.7, y: 1.3, seg: 4, ry: Math.PI / 4, color: (t) => ((t % 2) ? light : dark) });
  L.box({ z: 1.77, y: 1.0, w: 3.6, h: 0.18, d: 0.06, color: trim });
  L.box({ z: -1.77, y: 1.0, w: 3.6, h: 0.18, d: 0.06, color: trim });
  L.box({ x: 1.77, y: 1.0, w: 0.06, h: 0.18, d: 3.6, color: trim });
  L.box({ x: -1.77, y: 1.0, w: 0.06, h: 0.18, d: 3.6, color: trim });
  L.box({ z: 1.77, w: 1.0, h: 1.0, d: 0.08, color: C.dark });
  L.cyl({ x: -1.3, z: 1.8, cy: 0.85, r: 0.3, h: 0.06, rx: Math.PI / 2, seg: 10, color: trim });
  L.ball({ x: -1.3, y: 0.85, z: 1.84, r: 0.08, seg: 5, color: C.iron });
  L.cyl({ r: 0.05, h: 0.9, y: 3.0, seg: 4, color: C.iron });
  L.cone({ y: 3.9, r: 0.12, h: 0.35, seg: 4, color: C.iron });
}

export function brazier(L, o = {}) {
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    L.strut([Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45], [Math.cos(a) * 0.25, 0.95, Math.sin(a) * 0.25], 0.05, C.iron, 4);
  }
  L.cyl({ r: 0.22, r2: 0.42, h: 0.28, y: 0.92, seg: 8, color: C.iron });
  L.torus({ y: 1.2, R: 0.42, tube: 0.04, rx: Math.PI / 2, seg: 10, color: C.ironLight });
  fireFx(L, { y: 1.15, size: o.size ?? 0.75 });
}

export function siegeRam(L) {
  for (const sx of [-1, 1]) {
    L.box({ x: sx * 0.9, y: 0.45, w: 0.14, h: 0.14, d: 3.6, color: C.woodDark });
    L.strut([sx * 0.9, 0.5, 1.6], [sx * 0.55, 2.0, 0.0], 0.07, C.wood, 4);
    L.strut([sx * 0.9, 0.5, -1.6], [sx * 0.55, 2.0, 0.0], 0.07, C.wood, 4);
  }
  L.box({ y: 2.0, w: 1.3, h: 0.1, d: 0.12, color: C.woodDark });
  L.box({ x: -0.55, y: 1.9, w: 0.04, h: 0.1, d: 2.8, color: C.woodDark });
  L.box({ x: 0.55, y: 1.9, w: 0.04, h: 0.1, d: 2.8, color: C.woodDark });
  L.box({ x: -0.8, cy: 1.95, w: 0.1, h: 0.08, d: 3.4, rz: 0.5, color: 0x6a3a2a });
  L.box({ x: 0.8, cy: 1.95, w: 0.1, h: 0.08, d: 3.4, rz: -0.5, color: 0x6a3a2a });
  L.cyl({ cy: 1.15, r: 0.24, r2: 0.22, h: 3.6, rx: Math.PI / 2, seg: 8, color: C.wood });
  L.cone({ cy: 1.15, z: 1.95, r: 0.27, h: 0.5, rx: Math.PI / 2, seg: 8, color: C.iron });
  L.strut([-0.3, 2.0, 0.6], [-0.2, 1.4, 0.6], 0.02, C.iron, 3);
  L.strut([0.3, 2.0, 0.6], [0.2, 1.4, 0.6], 0.02, C.iron, 3);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      L.torus({ x: sx * 1.0, y: 0.35, z: sz * 1.1, R: 0.35, tube: 0.05, ry: Math.PI / 2, seg: 12, color: C.woodDark });
      L.ball({ x: sx * 1.0, y: 0.35, z: sz * 1.1, r: 0.08, seg: 4, color: C.iron });
    }
  }
}

export function stoneTower(L, o = {}) {
  const h = o.h ?? 5;
  L.box({ w: 2.4, h, d: 2.4, color: C.stone });
  L.box({ w: 2.7, h: 0.35, d: 2.7, color: C.stoneDark });
  L.box({ y: h, w: 2.9, h: 0.3, d: 2.9, color: C.stoneDark });
  for (let i = 0; i < 4; i++) {
    for (const s of [-1, 1]) {
      const p = -1.0 + i * 0.67;
      L.box({ x: p, z: s * 1.3, y: h + 0.3, w: 0.4, h: 0.5, d: 0.3, color: C.stoneLight });
      L.box({ x: s * 1.3, z: p, y: h + 0.3, w: 0.3, h: 0.5, d: 0.4, color: C.stoneLight });
    }
  }
  L.box({ z: 1.21, y: 0, w: 0.9, h: 1.5, d: 0.06, color: C.dark });
  L.box({ z: 1.21, y: h * 0.6, w: 0.22, h: 0.7, d: 0.06, color: C.dark });
  glowSprite(L, { z: 1.4, y: h * 0.6 + 0.35, size: 1.2, color: 0xffa050, opacity: 0.6 });
}

// --- undead ---------------------------------------------------------------------------

export function gravestone(L, o = {}) {
  const rng = L.ctx.rng;
  const kind = o.kind ?? ((rng() * 4) | 0);
  const col = new THREE.Color(C.stone).lerp(new THREE.Color(0x4a6a3a), rng() * 0.4)
    .multiplyScalar(0.75 + rng() * 0.35);
  L.ball({ z: 0.45, y: 0.05, r: 0.5, sy: 0.22, seg: 6, color: 0x4a3a2a });
  if (kind === 0) {
    L.box({ w: 0.55, h: 0.9, d: 0.12, color: col });
    L.ball({ y: 0.9, r: 0.28, sy: 0.6, sz: 0.4, seg: 6, color: col });
  } else if (kind === 1) {
    L.box({ w: 0.14, h: 1.1, d: 0.12, color: col });
    L.box({ y: 0.72, w: 0.55, h: 0.14, d: 0.12, color: col });
  } else if (kind === 2) {
    L.box({ w: 0.45, h: 1.0, d: 0.45, color: col });
    L.cone({ y: 1.0, r: 0.4, h: 0.5, seg: 4, ry: Math.PI / 4, color: col });
  } else {
    L.box({ w: 0.55, h: 0.8, d: 0.12, rz: 0.22, color: col });
    L.box({ x: 0.5, z: 0.25, w: 0.3, h: 0.2, d: 0.16, ry: 0.5, rz: 0.1, color: shade(col.getHex(), 0.9) });
  }
}

export function crypt(L) {
  L.box({ z: 2.6, w: 3.2, h: 0.2, d: 1.0, color: C.stoneDark });
  L.box({ z: 2.3, w: 3.0, h: 0.4, d: 0.8, color: C.stone });
  L.box({ w: 4.4, h: 2.8, d: 4.0, color: C.stone });
  L.box({ w: 4.6, h: 0.3, d: 4.2, color: C.stoneDark });
  for (let i = 0; i < 6; i++) {
    L.box({ y: 2.8 + i * 0.27, w: 4.6 - i * 0.75, h: 0.28, d: 4.2, color: i % 2 ? C.stoneDark : C.stone });
  }
  L.box({ z: 2.02, w: 1.2, h: 1.9, d: 0.1, color: C.dark });
  L.box({ x: -0.7, z: 2.05, w: 0.18, h: 2.0, d: 0.14, color: C.stoneLight });
  L.box({ x: 0.7, z: 2.05, w: 0.18, h: 2.0, d: 0.14, color: C.stoneLight });
  L.box({ z: 2.05, y: 1.9, w: 1.8, h: 0.28, d: 0.16, color: C.stoneLight });
  for (const sx of [-1, 1]) L.cyl({ x: sx * 1.5, z: 2.3, r: 0.24, r2: 0.2, h: 2.6, seg: 8, color: C.stoneLight });
  skull(L, 0, 2.55, 2.2, 1.5);
  L.box({ y: 6.1, w: 0.12, h: 0.9, d: 0.12, color: C.stoneLight });
  L.box({ y: 6.55, w: 0.55, h: 0.12, d: 0.12, color: C.stoneLight });
  glowSprite(L, { z: 2.3, y: 1.0, size: 3.4, color: 0x60ff90, opacity: 0.55 });
}

export function deadTree(L, o = {}) {
  const rng = L.ctx.rng;
  const limb = (from, dir, len, r, depth) => {
    const to = [from[0] + dir[0] * len, from[1] + dir[1] * len, from[2] + dir[2] * len];
    L.strut(from, to, r, 0x2e2822, 5, r * 0.6);
    if (depth <= 0) return;
    const n = depth > 1 ? 2 : (rng() < 0.5 ? 1 : 2);
    for (let i = 0; i < n; i++) {
      const d = [dir[0] + (rng() - 0.5) * 1.2, dir[1] * 0.8 + 0.25, dir[2] + (rng() - 0.5) * 1.2];
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      limb(to, [d[0] / l, d[1] / l, d[2] / l], len * 0.72, r * 0.62, depth - 1);
    }
  };
  limb([0, 0, 0], [(rng() - 0.5) * 0.2, 1, (rng() - 0.5) * 0.2], o.len ?? 2.4, 0.26, 3);
}

// Arch built from rib-like struts and vertebra balls.
export function boneArch(L, o = {}) {
  const w = o.w ?? 5;
  const h = o.h ?? 3.6;
  const N = 10;
  let prev = null;
  for (let i = 0; i <= N; i++) {
    const phi = (i / N) * Math.PI;
    const p = [-Math.cos(phi) * w / 2, Math.sin(phi) * h, 0];
    if (prev) L.strut(prev, p, 0.1, C.bone, 5);
    L.ball({ x: p[0], y: p[1], z: 0, r: 0.15, seg: 5, color: C.boneShade });
    if (i > 0 && i < N) L.strut(p, [p[0] * 0.92, p[1] - 0.55, 0.18], 0.04, C.bone, 4);
    prev = p;
  }
  for (const sx of [-1, 1]) L.cyl({ x: sx * w / 2, r: 0.2, r2: 0.15, h: 0.25, seg: 6, color: C.stoneDark });
  skull(L, 0, h + 0.28, 0, 1.4);
}

export function ironFence(L, o = {}) {
  const len = o.len ?? 6;
  const n = Math.round(len / 0.8);
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * len;
    L.cyl({ x, r: 0.04, h: 1.3, seg: 4, color: C.iron });
    L.cone({ x, y: 1.3, r: 0.07, h: 0.22, seg: 4, color: C.ironLight });
  }
  L.box({ x: len / 2, y: 0.35, w: len, h: 0.05, d: 0.05, color: C.iron });
  L.box({ x: len / 2, y: 1.0, w: len, h: 0.05, d: 0.05, color: C.iron });
  for (let i = 0; i <= n; i += 3) L.cyl({ x: (i / n) * len, r: 0.09, h: 1.5, seg: 5, color: C.stoneDark });
}

export function openGrave(L) {
  L.ball({ z: -1.15, y: 0.1, r: 1.0, sy: 0.3, seg: 6, color: 0x4a3a2a });
  L.box({ w: 1.0, h: 0.02, d: 2.0, y: 0.02, color: 0x0a0806 });
  for (const sx of [-1, 1]) L.box({ x: sx * 0.55, w: 0.12, h: 0.12, d: 2.1, color: C.stoneDark });
  L.box({ z: 1.15, y: 0, w: 0.1, h: 1.0, d: 0.1, color: C.wood });
  L.box({ z: 1.15, y: 0.62, w: 0.55, h: 0.1, d: 0.1, color: C.wood });
  L.strut([0.9, 0, -0.4], [0.7, 1.4, -0.25], 0.035, C.wood, 4);
  L.box({ x: 0.7, y: 1.35, z: -0.25, w: 0.22, h: 0.3, d: 0.04, rz: 0.2, color: C.ironLight });
}

export function coffin(L) {
  for (const z of [-0.6, 0.6]) L.box({ z, w: 0.9, h: 0.35, d: 0.12, color: C.woodDark });
  L.box({ y: 0.35, w: 0.8, h: 0.4, d: 1.6, color: 0x3a2a1c });
  L.box({ y: 0.7, w: 0.66, h: 0.1, d: 1.5, color: 0x4a3626 });
  L.box({ y: 0.81, w: 0.08, h: 0.03, d: 0.6, color: C.gold });
  L.box({ y: 0.81, z: 0.1, w: 0.36, h: 0.03, d: 0.08, color: C.gold });
}

export function wisp(L, o = {}) {
  const ctx = L.ctx;
  const col = o.color ?? 0x80ffb0;
  const w = L.world(o.x || 0, o.y ?? 1.5, o.z || 0);
  const g = new THREE.Group();
  g.position.set(w[0], w[1], w[2]);
  ctx.group.add(g);
  const outer = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowSprite.__tex || undefined, color: col, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, opacity: 0.65
  }));
  // Reuse the shared soft texture through a throwaway glowSprite call is not
  // needed: build the sprites from glowSprite directly and move them.
  g.add(outer);
  outer.visible = false;
  const s1 = glowSprite(L, { x: o.x || 0, y: o.y ?? 1.5, z: o.z || 0, size: 1.1, color: col, pulse: false, opacity: 0.7 });
  const s2 = glowSprite(L, { x: o.x || 0, y: o.y ?? 1.5, z: o.z || 0, size: 0.4, color: 0xffffff, pulse: false, opacity: 0.9 });
  const ph = ctx.rng() * 10;
  const baseY = w[1];
  ctx.animate((t) => {
    const by = baseY + Math.sin(t * 1.3 + ph) * 0.35;
    const bx = w[0] + Math.sin(t * 0.7 + ph * 2) * 0.4;
    s1.position.set(bx, by, w[2]);
    s2.position.set(bx, by, w[2]);
    const sc = 1.1 * (1 + 0.15 * Math.sin(t * 5 + ph));
    s1.scale.set(sc, sc, 1);
  });
}

// Ring of standing stones, glowing rune circle, altar and a floating orb.
export function necroCircle(L, o = {}) {
  const R = o.r ?? 3.2;
  const rng = L.ctx.rng;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    L.box({
      x: Math.cos(a) * R, z: Math.sin(a) * R, w: 0.5, h: 1.5 + rng() * 0.9, d: 0.35,
      ry: -a + Math.PI / 2, rz: (rng() - 0.5) * 0.12, color: shade(C.stone, 0.7 + rng() * 0.3)
    });
  }
  L.torus({ y: 0.06, R: R * 0.8, tube: 0.06, rx: Math.PI / 2, seg: 28, color: 0x50d070 });
  L.torus({ y: 0.06, R: R * 0.5, tube: 0.05, rx: Math.PI / 2, seg: 20, color: 0x50d070 });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const b = (((i + 2) % 5) / 5) * Math.PI * 2 + 0.3;
    L.strut([Math.cos(a) * R * 0.8, 0.07, Math.sin(a) * R * 0.8], [Math.cos(b) * R * 0.8, 0.07, Math.sin(b) * R * 0.8], 0.035, 0x50d070, 4);
  }
  L.box({ w: 1.3, h: 0.9, d: 0.8, color: C.stoneDark });
  L.box({ y: 0.9, w: 1.5, h: 0.14, d: 0.95, color: C.stone });
  skull(L, -0.35, 1.2, 0, 1.1, 0.4);
  L.cyl({ x: 0.4, y: 1.04, r: 0.06, h: 0.2, seg: 5, color: 0xe8e0c0 });
  glowSprite(L, { x: 0.4, y: 1.35, size: 0.9, color: 0x70ff90 });
  glowSprite(L, { y: 0.4, size: R * 2.6, color: 0x40d060, opacity: 0.28, pulse: false });
  wisp(L, { y: 2.2, color: 0x90ffc0 });
}

export function skullStandard(L, o = {}) {
  L.cyl({ r: 0.08, r2: 0.06, h: 4.2, seg: 5, color: 0x1a1a10 });
  L.box({ y: 3.2, w: 1.5, h: 0.07, d: 0.07, color: C.bone });
  skull(L, 0, 4.4, 0, 1.4, 0);
  for (const sx of [-1, 1]) skull(L, sx * 0.75, 3.1, 0, 0.7, sx * 0.6);
  banner(L.sub(0, 0, 0, 0.8, 0), { h: 3.8, color: o.color ?? 0x3a2a5a, trim: 0x6ad0a0 });
  glowSprite(L, { y: 4.6, size: 1.8, color: 0x70ff90, opacity: 0.5 });
}

export function lampPostGreen(L) {
  L.cyl({ r: 0.07, r2: 0.05, h: 2.6, seg: 5, color: C.iron });
  L.torus({ y: 2.7, R: 0.22, tube: 0.04, rx: Math.PI / 2, seg: 8, color: C.iron });
  fireFx(L, { y: 2.65, size: 0.4, palette: GREEN_FIRE });
}

export { FIRE, GREEN_FIRE };