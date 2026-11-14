// Deterministic value noise shared by terrain generation and terrain
// rendering. Integer hash only, so every machine produces the same field.

// Full-avalanche 32-bit finalizer (lowbias32). Every input bit affects
// about half the output bits, so neighbouring lattice points are
// uncorrelated and no grid-aligned stripes appear in the noise fields.
function mix32(x) {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

export function hash2(ix, iz, seed) {
  const h = (
    Math.imul(ix | 0, 374761393) +
    Math.imul(iz | 0, 668265263) +
    Math.imul(seed | 0, 1442695041)
  ) | 0;
  return mix32(h) / 4294967295;
}

export function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  const top = a + (b - a) * u;
  return top + ((c + (d - c) * u) - top) * v;
}

export function fbm(x, z, seed) {
  // Two octaves instead of three. The third added detail below the
  // terrain grid's own resolution (cellSize 2 world units), so it was
  // invisible on the mesh while costing ~33% of every terrain-gen call.
  // Determinism is preserved: same (x, z, seed) -> same value, so
  // multiplayer peers still agree.
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < 2; i++) {
    sum += amp * vnoise(x * freq, z * freq, seed + i * 101);
    norm += amp; amp *= 0.5; freq *= 2.03;
  }
  return sum / norm;
}