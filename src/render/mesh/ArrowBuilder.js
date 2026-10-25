// ===== ArrowBuilder.js =====
// Single-mesh arrow. Shaft, head, and two crossed fletches are baked into
// ONE BufferGeometry with per-vertex colours, so a whole quiver's worth of
// arrows costs one draw call each instead of four. Geometry and material
// are cached (see MeshCache.js) — every arrow in the game shares both.
//
// Proportions match the quiver arrows (see QuiverBuilder.js): thin shaft,
// small crossed fletches. The three arrow visuals in the game — nocked,
// flying, and stored — read as the same object because they use the same
// shaft radius and the same fletch box dimensions.
//
// The merge is done locally rather than via three/examples/jsm's
// mergeGeometries so this file has no dependency on the examples/jsm
// subpath — that path is a bare specifier that only resolves under a
// bundler, not against a browser import map. A hand-rolled merge is
// trivial here: every part has the same attribute set (position, normal,
// colour), no UVs, and small vertex counts.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

const SHAFT_LEN = 0.5;
const SHAFT_RADIUS = 0.007;
const SHAFT_COLOR = 0x8a5a24;

// Small steel head. The quiver arrows don't show a head (it's buried in the
// quiver), but a flying arrow needs one so it reads as an arrow rather than
// a floating stick at long range. Kept proportionally small so it does not
// dominate the thin shaft the way the previous build's head did.
const HEAD_LEN = 0.06;
const HEAD_RADIUS = 0.014;
const HEAD_COLOR = 0xaaaaaa;

// Crossed fletches at the tail. Dimensions match QuiverBuilder's fletch
// boxes (0.024 × 0.045 × 0.006) so all three arrow visuals agree by
// construction.
const FLETCH_LONG = 0.045;   // along the arrow's axis
const FLETCH_WIDE = 0.024;   // perpendicular, the fin's visible width
const FLETCH_THIN = 0.006;   // perpendicular, the fin's thickness
const FLETCH_TAIL_GAP = 0.03; // distance from tail end to fletch centre
const FLETCH_COLOR = 0xdddddd;

export function createArrowProjectile() {
  const geo = cachedGeometry('arrow.mergedGeo', buildMergedArrowGeometry);
  const mat = cachedMaterial('arrow.mergedMat', () =>
    new THREE.MeshLambertMaterial({ vertexColors: true }));
  return new THREE.Mesh(geo, mat);
}

function buildMergedArrowGeometry() {
  const parts = [];

  // Shaft — centred at origin, spanning Z from -SHAFT_LEN/2 to +SHAFT_LEN/2.
  // CylinderGeometry builds along +Y, so rotate 90° around X to lay it on Z.
  const shaft = new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_LEN, 5);
  shaft.rotateX(Math.PI / 2);
  parts.push(paint(shaft, SHAFT_COLOR));

  // Head — small cone at the tip. Translated so its base sits just inside
  // the shaft's front end (offset by 0.005 to overlap slightly) rather than
  // leaving a visible seam at the join.
  const head = new THREE.ConeGeometry(HEAD_RADIUS, HEAD_LEN, 6);
  head.rotateX(Math.PI / 2);
  head.translate(0, 0, SHAFT_LEN / 2 + HEAD_LEN / 2 - 0.005);
  parts.push(paint(head, HEAD_COLOR));

  // Two crossed fletches near the tail. Each is a thin box: FLETCH_WIDE in
  // one perpendicular axis, FLETCH_THIN in the other, FLETCH_LONG along
  // the arrow's axis. Because the two boxes swap which perpendicular axis
  // carries the wide dimension, they form a cross without needing a
  // rotation baked into the geometry — each box is already in its final
  // orientation when translated.
  const fletchZ = -SHAFT_LEN / 2 + FLETCH_TAIL_GAP;

  const fletchLong = new THREE.BoxGeometry(FLETCH_WIDE, FLETCH_THIN, FLETCH_LONG);
  fletchLong.translate(0, 0, fletchZ);
  parts.push(paint(fletchLong, FLETCH_COLOR));

  const fletchCross = new THREE.BoxGeometry(FLETCH_THIN, FLETCH_WIDE, FLETCH_LONG);
  fletchCross.translate(0, 0, fletchZ);
  parts.push(paint(fletchCross, FLETCH_COLOR));

  const merged = mergeParts(parts);
  for (const p of parts) p.dispose();
  return merged;
}

// Strips UVs (the arrow material has no map, so UVs are dead weight in the
// merged buffer) and adds a flat per-vertex colour attribute.
function paint(geo, hex) {
  geo.deleteAttribute('uv');
  const c = new THREE.Color(hex);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// Concatenates an array of {position, normal, color}-bearing BufferGeometries
// into a single indexed BufferGeometry. Assumes every part carries exactly
// those three attributes (paint() guarantees position/normal come from the
// primitive builders and colour is added by paint). Total vertex count is
// tiny (well under 200 here), so Uint16 indices are plenty.
function mergeParts(geos) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of geos) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const index = new Uint16Array(indexCount);

  let vOff = 0;
  let iOff = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    position.set(p.array, vOff * 3);
    normal.set(g.attributes.normal.array, vOff * 3);
    color.set(g.attributes.color.array, vOff * 3);

    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) index[iOff + i] = gi[i] + vOff;
      iOff += gi.length;
    } else {
      for (let i = 0; i < p.count; i++) index[iOff + i] = vOff + i;
      iOff += p.count;
    }
    vOff += p.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  return merged;
}