// Chooses the terrain seed for a battle.
//
// Priority: multiplayer seed from the host > seed stored in a campaign
// snapshot > the seed of the previous page load when the page is resuming a
// battle (Ctrl+R / Restart) > a fresh random seed.
const SEED_KEY = 'sa.terrainSeed';

function randomSeed() {
  return ((Math.random() * 0x7fffffff) | 0) || 1;
}

function readStored() {
  try {
    const raw = sessionStorage.getItem(SEED_KEY);
    const n = raw === null ? NaN : parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    return null;
  }
}

function store(seed) {
  try { sessionStorage.setItem(SEED_KEY, String(seed)); } catch (e) { /* private mode */ }
}

export const TerrainSession = {
  resolve({ reuse = false, mpSeed = null, snapshotSeed = null } = {}) {
    let seed = null;
    if (Number.isInteger(mpSeed)) seed = mpSeed;
    else if (Number.isInteger(snapshotSeed)) seed = snapshotSeed;
    else if (reuse) seed = readStored();
    if (seed === null) seed = randomSeed();
    store(seed);
    return seed;
  }
};