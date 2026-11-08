// ===== CampGeometry.js =====
// Geometry plumbing for the camp backdrop.
//
// MergedMesh collects many primitives (boxes, cones, struts ...)
// with per-triangle vertex colours and bakes them into
// ONE BufferGeometry / one draw call. Hundreds of props
// cost a handful of draw calls.
// getGlowTexture shared soft radial gradient for fire glow, halos etc.
// disposeObject3D frees geometries / materials of a built group.
//
// Conventions: cyl / cone / box take y as the BOTTOM of the shape (or
// cy to give the centre directly, which is what rotated shapes want);
// ball / rock / ico / torus take y as the CENTRE; disc takes y as its
// height above the ground.

import * as THREE from 'three';

const _prims = new Map();
function prim(key, factory) {
let g = _prims.get(key);
if (!g) {
g = factory();
_prims.set(key, g);
}
return g;
}

const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Color();

function toColor(c) {
return c instanceof THREE.Color ? c : _c.set(c);
}

const val = (v, d) => (v === undefined ? d : v);

const unitBox = () => prim('box', () => new THREE.BoxGeometry(1, 1, 1));
const unitCyl = (seg, ratio, open) =>
  prim(`cyl|${seg}|${ratio.toFixed(3)}|${open ? 1 : 0}`,
    () => new THREE.CylinderGeometry(ratio, 1, 1, seg, 1, open));
const unitCone = (seg, open) =>
  prim(`cone|${seg}|${open ? 1 : 0}`, () => new THREE.ConeGeometry(1, 1, seg, 1, open));
const unitBall = (seg) =>
  prim(`ball|${seg}`, () => new THREE.SphereGeometry(1, seg, Math.max(3, Math.round(seg * 0.7))));
const unitRock = () => prim('rock', () => new THREE.DodecahedronGeometry(1, 0));
const unitIco = () => prim('ico', () => new THREE.IcosahedronGeometry(1, 0));
const unitDisc = (seg) =>
  prim(`disc|${seg}`, () => new THREE.CircleGeometry(1, seg).rotateX(-Math.PI / 2));
const unitTorus = (tube, seg) =>
  prim(`torus|${tube.toFixed(3)}|${seg}`, () => new THREE.TorusGeometry(1, tube, 5, seg));

export class MergedMesh {
constructor() {
this._pos = [];
this._col = [];
}

// Core: bakes geometry transformed by (pos, quat, scale) into the
// buffers. color is a hex number, a THREE.Color, or a function
// (triangleIndex) => hex | Color for per-face colouring.
_emit(geometry, pos, quat, scale, color) {
_p.set(pos[0], pos[1], pos[2]);
_s.set(scale[0], scale[1], scale[2]);
_m.compose(_p, quat, _s);

const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
g.applyMatrix4(_m);
const arr = g.attributes.position.array;
const tris = Math.floor(arr.length / 9);
const fn = typeof color === 'function' ? color : null;
const fixed = fn ? null : toColor(color);

for (let t = 0; t < tris; t++) {
  const c = fn ? toColor(fn(t)) : fixed;
  const base = t * 9;
  for (let v = 0; v < 3; v++) {
    this._pos.push(arr[base + v * 3], arr[base + v * 3 + 1], arr[base + v * 3 + 2]);
    this._col.push(c.r, c.g, c.b);
  }
}
g.dispose();
return this;

}

add(geometry, o = {}) {
const rot = o.rot || [0, 0, 0];
    _e.set(rot[0], rot[1], rot[2], 'YXZ');
_q.setFromEuler(_e);
return this._emit(geometry, o.pos || [0, 0, 0], _q, o.scale || [1, 1, 1], val(o.color, 0xffffff));
}

box(o) {
const h = val(o.h, 1);
const cy = o.cy !== undefined ? o.cy : val(o.y, 0) + h / 2;
return this.add(unitBox(), {
pos: [val(o.x, 0), cy, val(o.z, 0)],
rot: [val(o.rx, 0), val(o.ry, 0), val(o.rz, 0)],
scale: [val(o.w, 1), h, val(o.d, 1)],
color: val(o.color, 0xffffff)
});
}

cyl(o) {
const r = val(o.r, 0.5);
const h = val(o.h, 1);
const r2 = val(o.r2, r);
const cy = o.cy !== undefined ? o.cy : val(o.y, 0) + h / 2;
return this.add(unitCyl(val(o.seg, 8), r > 0 ? r2 / r : 0, !!o.open), {
pos: [val(o.x, 0), cy, val(o.z, 0)],
rot: [val(o.rx, 0), val(o.ry, 0), val(o.rz, 0)],
scale: [r, h, r],
color: val(o.color, 0xffffff)
});
}

cone(o) {
const r = val(o.r, 0.5);
const h = val(o.h, 1);
const cy = o.cy !== undefined ? o.cy : val(o.y, 0) + h / 2;
return this.add(unitCone(val(o.seg, 8), o.open === undefined ? true : !!o.open), {
pos: [val(o.x, 0), cy, val(o.z, 0)],
rot: [val(o.rx, 0), val(o.ry, 0), val(o.rz, 0)],
scale: [r, h, r],
color: val(o.color, 0xffffff)
});
}

_blob(geo, o) {
const r = val(o.r, 0.5);
return this.add(geo, {
pos: [val(o.x, 0), val(o.y, 0), val(o.z, 0)],
rot: [val(o.rx, 0), val(o.ry, 0), val(o.rz, 0)],
scale: [r * val(o.sx, 1), r * val(o.sy, 1), r * val(o.sz, 1)],
color: val(o.color, 0xffffff)
});
}

ball(o) { return this._blob(unitBall(val(o.seg, 8)), o); }
rock(o) { return this._blob(unitRock(), o); }
ico(o) { return this._blob(unitIco(), o); }

// Flat disc lying at height y.
disc(o) {
const r = val(o.r, 0.5);
return this.add(unitDisc(val(o.seg, 12)), {
pos: [val(o.x, 0), val(o.y, 0.02), val(o.z, 0)],
scale: [r, 1, r],
color: val(o.color, 0xffffff)
});
}

// Ring in the XY plane by default (rotate with rx / ry / rz).
torus(o) {
const R = val(o.R, 1);
return this.add(unitTorus(val(o.tube, 0.1) / R, val(o.seg, 12)), {
pos: [val(o.x, 0), val(o.y, 0), val(o.z, 0)],
rot: [val(o.rx, 0), val(o.ry, 0), val(o.rz, 0)],
scale: [R, R, R],
color: val(o.color, 0xffffff)
});
}

// Cylinder between two points a -> b ([x,y,z]). r is the radius at a,
// r2 (optional) the radius at b; r2 = 0 gives a spike.
strut(a, b, r, color, seg = 5, r2) {
_d.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const len = _d.length();
if (len < 1e-5) return this;
_d.multiplyScalar(1 / len);
_qs.setFromUnitVectors(UP, _d);
const ratio = r2 === undefined ? 1 : (r > 0 ? r2 / r : 0);
return this._emit(
unitCyl(seg, ratio, false),
[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
_qs, [r, len, r], color
);
}

build(material) {
const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this._pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this._col, 3));
geo.computeVertexNormals();
geo.computeBoundingSphere();
const mat = material || new THREE.MeshLambertMaterial({ vertexColors: true });
return new THREE.Mesh(geo, mat);
}
}

// --- shared glow texture -------------------------------------------------

let _glow = null;

export function getGlowTexture() {
if (_glow) return _glow;
const S = 64;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.14)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
ctx.fillStyle = g;
ctx.fillRect(0, 0, S, S);
_glow = new THREE.CanvasTexture(cv);
return _glow;
}

// --- disposal --------------------------------------------------------------

// Frees every geometry and material under root and detaches it from its
// parent. Textures are shared module-level objects and are not disposed.
export function disposeObject3D(root) {
if (!root) return;
const geos = new Set();
const mats = new Set();
root.traverse((o) => {
if (o.geometry) geos.add(o.geometry);
if (o.material) {
if (Array.isArray(o.material)) o.material.forEach((m) => mats.add(m));
else mats.add(o.material);
}
});
for (const g of geos) g.dispose();
for (const m of mats) m.dispose();
if (root.parent) root.parent.remove(root);
}