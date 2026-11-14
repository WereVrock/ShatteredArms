// ===== CampScenery.js =====
// Everything around the camp: sky dome, sun / moon, stars, terrain, two
// mountain ranges, forest, rocks and grass tufts. Returns one Group.
//
// The terrain is a polar grid (dense near the camp, sparse far away) that
// reaches past the fog distance, so the world has no visible edge: distant
// ground fades into the fog colour, which equals the sky horizon colour.
// Mountains ignore fog and fade to the horizon colour through their own
// vertex colours, so the far range stays visible as a hazy silhouette.
// All static scenery is merged into a few meshes (few draw calls).

import * as THREE from 'three';
import { MergedMesh, getGlowTexture } from './CampGeometry.js';
import { mulberry32, fbm, smoothstep, lerp, clamp } from './CampMath.js';

const TAU = Math.PI * 2;
const GROUND_RADIUS = 380;
const SKY_RADIUS = 600;
const GRAIN_TILE = 14;

// 1 on the dirt avenue running toward the camera, 0 elsewhere.
export function laneMask(x, z) {
  return smoothstep(6.5, 3.2, Math.abs(x)) * smoothstep(-10, -4, z);
}

// 1 on the trodden ground around the two camp clusters.
export function campMask(x, z) {
  return 1 - smoothstep(0.62, 1.0, Math.hypot(x / 22, z / 13));
}

// Terrain height. Flat around the camp and along the avenue, rolling hills
// further out, a rising bowl at the rim.
export function groundHeight(x, z, seed) {
  const r = Math.hypot(x, z);
  const flat = 1 - smoothstep(26, 75, r);
  const k = (1 - flat) * (1 - laneMask(x, z));
  if (k <= 0) return 0;
  const relief = (fbm(x * 0.028, z * 0.028, seed, 4) - 0.5) * 18
    + (fbm(x * 0.1, z * 0.1, seed + 9, 2) - 0.5) * 3;
  const bowl = smoothstep(80, 230, r) * 14;
  return (relief + bowl) * k;
}

export function buildScenery(theme) {
  const g = new THREE.Group();
  g.add(buildSky(theme));
  g.add(buildCelestial(theme));
  if (theme.stars > 0) g.add(buildStars(theme));
  g.add(buildGround(theme));
  g.add(buildMountains(theme));
  g.add(buildForest(theme));
  g.add(buildGroundCover(theme));
  return g;
}

// --- sky -------------------------------------------------------------------

function buildSky(theme) {
  const s = theme.sky;
  const geo = new THREE.SphereGeometry(SKY_RADIUS, 32, 24);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const zen = new THREE.Color(s.zenith);
  const mid = new THREE.Color(s.mid);
  const hor = new THREE.Color(s.horizon);
  const glow = new THREE.Color(s.glow);
  const gdir = new THREE.Vector3(s.glowDir[0], s.glowDir[1], s.glowDir[2]).normalize();
  const v = new THREE.Vector3();
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const h = Math.max(0, v.y);
    if (h < 0.28) c.copy(hor).lerp(mid, smoothstep(0.0, 0.28, h));
    else c.copy(mid).lerp(zen, smoothstep(0.28, 1.0, h));
    const gl = Math.pow(Math.max(0, v.dot(gdir)), s.glowPower)
      * (1 - smoothstep(0, 0.6, h) * 0.6);
    c.lerp(glow, clamp(gl, 0, 0.85));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false
  }));
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

function buildCelestial(theme) {
  const cel = theme.celestial;
  const g = new THREE.Group();
  const dir = new THREE.Vector3(cel.dir[0], cel.dir[1], cel.dir[2]).normalize();

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(cel.size, 40),
    new THREE.MeshBasicMaterial({ color: cel.color, fog: false })
  );
  disc.position.copy(dir).multiplyScalar(540);
  disc.lookAt(0, 0, 0);
  g.add(disc);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getGlowTexture(), color: cel.color, blending: THREE.AdditiveBlending,
    transparent: true, depthWrite: false, opacity: cel.halo, fog: false
  }));
  halo.position.copy(dir).multiplyScalar(530);
  halo.scale.set(cel.size * 7, cel.size * 7, 1);
  g.add(halo);
  return g;
}

function buildStars(theme) {
  const rng = mulberry32(theme.seed + 500);
  const n = theme.stars;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const phi = rng() * TAU;
    const y = 0.06 + rng() * 0.94;
    const rr = Math.sqrt(1 - y * y);
    pos[i * 3] = Math.cos(phi) * rr * 560;
    pos[i * 3 + 1] = y * 560;
    pos[i * 3 + 2] = Math.sin(phi) * rr * 560;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffffff, size: 1.8, sizeAttenuation: false, fog: false,
    transparent: true, opacity: 0.85, depthWrite: false
  }));
  pts.frustumCulled = false;
  return pts;
}

// --- ground ------------------------------------------------------------------

let _grain = null;

// Tileable greyscale grain multiplied over the ground's vertex colours so
// the ground is not a flat wash at close range.
function grainTexture() {
  if (_grain) return _grain;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(S, S);
  const rng = mulberry32(4242);
  const N = 8;
  const coarse = new Float32Array(N * N);
  for (let i = 0; i < coarse.length; i++) coarse[i] = rng();

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const gx = (x / S) * N;
      const gy = (y / S) * N;
      const ix = Math.floor(gx);
      const iy = Math.floor(gy);
      const fx = gx - ix;
      const fy = gy - iy;
      const a = coarse[(ix % N) + (iy % N) * N];
      const b = coarse[((ix + 1) % N) + (iy % N) * N];
      const c = coarse[(ix % N) + ((iy + 1) % N) * N];
      const d = coarse[((ix + 1) % N) + ((iy + 1) % N) * N];
      const blotch = lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
      const v = 196 + blotch * 36 + rng() * 22;
      const i = (y * S + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  _grain = tex;
  return tex;
}

function buildGround(theme) {
  const seed = theme.seed;
  const gc = theme.ground;
  const RINGS = 60;
  const SEGS = 80;
  const count = (RINGS + 1) * SEGS;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);

  const gD = new THREE.Color(gc.grassDark);
  const gL = new THREE.Color(gc.grassLight);
  const dirt = new THREE.Color(gc.dirt);
  const rock = new THREE.Color(gc.rock);
  const tmp = new THREE.Color();

  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const r = GROUND_RADIUS * t * t;
    for (let s = 0; s < SEGS; s++) {
      const a = (s / SEGS) * TAU;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = groundHeight(x, z, seed);
      const idx = i * SEGS + s;
      pos[idx * 3] = x;
      pos[idx * 3 + 1] = y;
      pos[idx * 3 + 2] = z;
      uv[idx * 2] = x / GRAIN_TILE;
      uv[idx * 2 + 1] = z / GRAIN_TILE;

      const n1 = fbm(x * 0.045, z * 0.045, seed + 3, 3);
      const n2 = fbm(x * 0.2, z * 0.2, seed + 5, 2);
      tmp.copy(gD).lerp(gL, clamp(n1 * 1.25 + (n2 - 0.5) * 0.4, 0, 1));

      const dirtAmt = clamp(Math.max(campMask(x, z), laneMask(x, z)) + (n2 - 0.5) * 0.35, 0, 1);
      tmp.lerp(dirt, smoothstep(0.3, 0.7, dirtAmt));

      const rockAmt = smoothstep(7, 14, y) * smoothstep(0.35, 0.65, n2);
      tmp.lerp(rock, rockAmt * 0.8);

      col[idx * 3] = tmp.r;
      col[idx * 3 + 1] = tmp.g;
      col[idx * 3 + 2] = tmp.b;
    }
  }

  const index = [];
  for (let i = 0; i < RINGS; i++) {
    for (let s = 0; s < SEGS; s++) {
      const a = i * SEGS + s;
      const b = i * SEGS + ((s + 1) % SEGS);
      const c = (i + 1) * SEGS + s;
      const d = (i + 1) * SEGS + ((s + 1) % SEGS);
      index.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    vertexColors: true, map: grainTexture()
  }));
  mesh.frustumCulled = false;
  return mesh;
}

// --- mountains ---------------------------------------------------------------

function buildMountains(theme) {
  const group = new THREE.Group();
  const m = theme.mountains;
  group.add(buildRange(theme, {
    radius: 330, height: 105, color: m.far, haze: 0.5,
    seed: theme.seed + 100, freq: 1.7, snow: m.snow
  }));
  group.add(buildRange(theme, {
    radius: 215, height: 52, color: m.near, haze: 0.22,
    seed: theme.seed + 200, freq: 2.6, snow: m.snow
  }));
  return group;
}

// One closed ring of ridged peaks. Four vertex rows per column (base, two
// slope rows, crest); colours fade to the fog colour with distance and
// toward the valley, with optional snow caps.
function buildRange(theme, cfg) {
  const SEG = 150;
  const FR = [0, 0.4, 0.75, 1];
  const ROWS = FR.length;
  const SHADE = [0.7, 0.9, 1.0, 1.15];
  const pos = new Float32Array(SEG * ROWS * 3);
  const col = new Float32Array(SEG * ROWS * 3);
  const base = new THREE.Color(cfg.color);
  const snow = cfg.snow ? new THREE.Color(cfg.snow) : null;
  const fog = new THREE.Color(theme.fog.color);
  const c = new THREE.Color();

  for (let k = 0; k < SEG; k++) {
    const a = (k / SEG) * TAU;
    const cx = Math.cos(a);
    const sz = Math.sin(a);
    const n = fbm(cx * cfg.freq * 3 + 10, sz * cfg.freq * 3 + 10, cfg.seed, 4);
    const ridge = 1 - Math.abs(2 * n - 1);
    const peak = fbm(cx * cfg.freq * 9 + 40, sz * cfg.freq * 9 + 40, cfg.seed + 7, 2);
    const h = cfg.height * (0.28 + 0.72 * (ridge * 0.75 + peak * 0.25));

    for (let j = 0; j < ROWS; j++) {
      const f = FR[j];
      const jag = (f > 0 && f < 1)
        ? (fbm(cx * cfg.freq * 20 + j * 3, sz * cfg.freq * 20, cfg.seed + j, 2) - 0.5) * 0.22 * h
        : 0;
      const y = -14 + (h + 14) * f + jag;
      const rad = cfg.radius * (1 - 0.16 * f);
      const idx = j * SEG + k;
      pos[idx * 3] = cx * rad;
      pos[idx * 3 + 1] = y;
      pos[idx * 3 + 2] = sz * rad;

      c.copy(base).multiplyScalar(SHADE[j]);
      if (snow) c.lerp(snow, smoothstep(cfg.height * 0.5, cfg.height * 0.75, y));
      c.lerp(fog, clamp(cfg.haze + (1 - f) * 0.3, 0, 0.9));
      col[idx * 3] = c.r;
      col[idx * 3 + 1] = c.g;
      col[idx * 3 + 2] = c.b;
    }
  }

  const index = [];
  for (let j = 0; j < ROWS - 1; j++) {
    for (let k = 0; k < SEG; k++) {
      const a = j * SEG + k;
      const b = j * SEG + ((k + 1) % SEG);
      const c2 = (j + 1) * SEG + k;
      const d = (j + 1) * SEG + ((k + 1) % SEG);
      index.push(a, c2, b, b, c2, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide, fog: false
  }));
  mesh.frustumCulled = false;
  return mesh;
}

// --- forest -------------------------------------------------------------------

function jitter(list, rng) {
  return list[(rng() * list.length) | 0].clone().multiplyScalar(0.8 + rng() * 0.4);
}

function pine(mm, x, y, z, s, rng, foliage, trunk) {
  mm.cyl({ x, y, z, r: 0.2 * s, r2: 0.14 * s, h: 1.8 * s, seg: 5, color: trunk });
  const c = jitter(foliage, rng);
  mm.cone({ x, y: y + 1.1 * s, z, r: 1.6 * s, h: 2.5 * s, seg: 6, color: c });
  mm.cone({ x, y: y + 2.5 * s, z, r: 1.2 * s, h: 2.2 * s, seg: 6, color: c });
  mm.cone({ x, y: y + 3.8 * s, z, r: 0.8 * s, h: 1.9 * s, seg: 6, color: c });
}

function roundTree(mm, x, y, z, s, rng, foliage, trunk) {
  mm.cyl({ x, y, z, r: 0.26 * s, r2: 0.18 * s, h: 2.4 * s, seg: 5, color: trunk });
  const c = jitter(foliage, rng);
  mm.ico({ x, y: y + 3.3 * s, z, r: 1.7 * s, sy: 0.85, color: c });
  mm.ico({ x: x + 0.9 * s, y: y + 2.7 * s, z: z + 0.3 * s, r: 1.1 * s, color: jitter(foliage, rng) });
  mm.ico({ x: x - 0.8 * s, y: y + 2.9 * s, z: z - 0.5 * s, r: 1.2 * s, color: jitter(foliage, rng) });
}

function deadTree(mm, x, y, z, s, rng, trunk) {
  const limb = (from, dir, len, r, depth) => {
    const to = [from[0] + dir[0] * len, from[1] + dir[1] * len, from[2] + dir[2] * len];
    mm.strut(from, to, r, trunk, 5, r * 0.6);
    if (depth <= 0) return;
    const n = depth > 1 ? 2 : (rng() < 0.5 ? 1 : 2);
    for (let i = 0; i < n; i++) {
      const d = [dir[0] + (rng() - 0.5) * 1.2, dir[1] * 0.8 + 0.25, dir[2] + (rng() - 0.5) * 1.2];
      const l = Math.hypot(d[0], d[1], d[2]) || 1;
      limb(to, [d[0] / l, d[1] / l, d[2] / l], len * 0.72, r * 0.62, depth - 1);
    }
  };
  limb([x, y, z], [(rng() - 0.5) * 0.2, 1, (rng() - 0.5) * 0.2], 2.2 * s, 0.24 * s, 3);
}

function buildForest(theme) {
  const f = theme.forest;
  const rng = mulberry32(theme.seed + 700);
  const mm = new MergedMesh();
  const foliage = f.foliage.map((c) => new THREE.Color(c));
  const attempts = Math.round(1500 * f.density);

  for (let i = 0; i < attempts; i++) {
    const a = rng() * TAU;
    const r = 28 + Math.sqrt(rng()) * 140;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;

    // Keep the view corridor, the camp and the area around the camera clear.
    if (campMask(x, z) > 0.02 || laneMask(x, z) > 0.02) continue;
    if (z > 0 && r < 70) continue;
    const cluster = fbm(x * 0.045, z * 0.045, theme.seed + 31, 3);
    if (cluster < 0.42 + (r < 45 ? 0.06 : 0)) continue;
    if (r < 40 && rng() < 0.5) continue;

    const y = groundHeight(x, z, theme.seed);
    const s = 0.8 + rng() * 0.9;
    if (f.style === 'dead') deadTree(mm, x, y, z, s, rng, f.trunk);
    else if (f.style === 'pine') pine(mm, x, y, z, s, rng, foliage, f.trunk);
    else if (rng() < 0.55) pine(mm, x, y, z, s, rng, foliage, f.trunk);
    else roundTree(mm, x, y, z, s, rng, foliage, f.trunk);
  }
  const mesh = mm.build();
  mesh.frustumCulled = false;
  return mesh;
}

// --- rocks and grass ---------------------------------------------------------

function buildGroundCover(theme) {
  const rng = mulberry32(theme.seed + 900);
  const gc = theme.ground;
  const mm = new MergedMesh();
  const rockC = new THREE.Color(gc.rock);
  const gD = new THREE.Color(gc.grassDark);
  const gL = new THREE.Color(gc.grassLight);
  const tmp = new THREE.Color();

  for (let i = 0; i < 160; i++) {
    const a = rng() * TAU;
    const r = 9 + Math.sqrt(rng()) * 115;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (laneMask(x, z) > 0.05) continue;
    if (campMask(x, z) > 0.5 && rng() < 0.7) continue;
    const size = 0.3 + rng() * rng() * 1.9;
    const y = groundHeight(x, z, theme.seed) + size * 0.3;
    mm.rock({
      x, y, z, r: size, sx: 1 + rng() * 0.5, sy: 0.6, sz: 1 + rng() * 0.5,
      rx: rng() * 3, ry: rng() * 3,
      color: rockC.clone().multiplyScalar(0.7 + rng() * 0.5)
    });
  }

  for (let i = 0; i < 900; i++) {
    const a = rng() * TAU;
    const r = 6 + rng() * 48;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (laneMask(x, z) > 0.3 || campMask(x, z) > 0.7) continue;
    const y = groundHeight(x, z, theme.seed);
    tmp.copy(gD).lerp(gL, rng()).multiplyScalar(1.1 + rng() * 0.3);
    for (let b = 0; b < 3; b++) {
      mm.cone({
        x: x + (rng() - 0.5) * 0.25, z: z + (rng() - 0.5) * 0.25, y,
        r: 0.06, h: 0.4 + rng() * 0.4, seg: 3,
        rx: (rng() - 0.5) * 0.5, rz: (rng() - 0.5) * 0.5, color: tmp
      });
    }
  }
  const mesh = mm.build();
  mesh.frustumCulled = false;
  return mesh;
}