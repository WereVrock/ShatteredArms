// ===== CampMath.js =====
// Small deterministic helpers shared by the camp scenery and props:
// seeded RNG, value noise, fbm, smoothstep. No THREE dependency.

export function clamp(v, lo, hi) {
return v < lo ? lo : (v > hi ? hi : v);
}

export function lerp(a, b, t) {
return a + (b - a) * t;
}

// Works with reversed edges too (e0 > e1 gives a falling ramp).
export function smoothstep(e0, e1, x) {
if (e0 === e1) return x < e0 ? 0 : 1;
const t = clamp((x - e0) / (e1 - e0), 0, 1);
return t * t * (3 - 2 * t);
}

export function mulberry32(seed) {
let a = seed | 0;
return function () {
a = (a + 0x6D2B79F5) | 0;
let t = Math.imul(a ^ (a >>> 15), 1 | a);
t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
}

function hash2(ix, iz, seed) {
let h = (Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
h = Math.imul(h ^ (h >>> 13), 1274126177);
h = h ^ (h >>> 16);
return (h >>> 0) / 4294967296;
}

// 0..1
export function valueNoise(x, z, seed = 0) {
const ix = Math.floor(x);
const iz = Math.floor(z);
const fx = x - ix;
const fz = z - iz;
const u = fx * fx * (3 - 2 * fx);
const v = fz * fz * (3 - 2 * fz);
const a = hash2(ix, iz, seed);
const b = hash2(ix + 1, iz, seed);
const c = hash2(ix, iz + 1, seed);
const d = hash2(ix + 1, iz + 1, seed);
return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

// 0..1, roughly bell-shaped around 0.5
export function fbm(x, z, seed = 0, octaves = 4) {
let amp = 0.5;
let freq = 1;
let sum = 0;
let norm = 0;
for (let i = 0; i < octaves; i++) {
sum += amp * valueNoise(x * freq, z * freq, seed + i * 17);
norm += amp;
amp *= 0.5;
freq *= 2;
}
return sum / norm;
}