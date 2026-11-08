// ===== CampThemes.js =====
// Per-faction look of the camp backdrop: sky, fog, lights, ground colours,
// mountains and forest style. Data only.
//
// RULE: sky.horizon === fog.color. The fog fades distant ground and
// mountains into that colour, and the sky dome starts at the same colour at
// the horizon, so there is no visible seam between world and sky.

import { CampaignFactionId } from '../../campaign/CampaignFaction.js';

const HUMAN = {
seed: 11,
fog: { color: 0xa98466, near: 45, far: 250 },
sky: { zenith: 0x1d3354, mid: 0x4f6a96, horizon: 0xa98466, glow: 0xffb060, glowDir: [-0.55, 0.24, -0.8], glowPower: 6 },
celestial: { color: 0xffe0a0, dir: [-0.55, 0.24, -0.8], size: 14, halo: 0.55 },
stars: 0,
lights: { hemiSky: 0xb0c4e8, hemiGround: 0x6a5238, hemi: 0.8, keyColor: 0xffd8a0, key: 1.0, keyPos: [-14, 18, 10] },
ground: { grassDark: 0x3c5a2a, grassLight: 0x5a7a3a, dirt: 0x7a6240, rock: 0x6a665e },
mountains: { near: 0x4a5a70, far: 0x6e7f98, snow: 0xe8eef6 },
forest: { style: 'mixed', foliage: [0x2f5428, 0x45702f, 0x5e8a3a], trunk: 0x4a3524, density: 1.0 }
};

const GOBLIN = {
seed: 23,
fog: { color: 0x3f4f36, near: 35, far: 190 },
sky: { zenith: 0x0f1a14, mid: 0x2a3a2e, horizon: 0x3f4f36, glow: 0xb8d060, glowDir: [0.5, 0.34, -0.8], glowPower: 5 },
celestial: { color: 0xe4f0a8, dir: [0.5, 0.34, -0.8], size: 16, halo: 0.5 },
stars: 140,
lights: { hemiSky: 0x9ab08a, hemiGround: 0x3a3020, hemi: 0.75, keyColor: 0xc8dc9c, key: 0.8, keyPos: [12, 18, 12] },
ground: { grassDark: 0x2c3a1e, grassLight: 0x44552a, dirt: 0x4c3a24, rock: 0x4a4a40 },
mountains: { near: 0x2c382c, far: 0x3c4a3a, snow: null },
forest: { style: 'dead', foliage: [0x2a3a1c, 0x3a4a22], trunk: 0x2c2216, density: 1.0 }
};

const HOBGOBLIN = {
seed: 37,
fog: { color: 0x4e342c, near: 40, far: 210 },
sky: { zenith: 0x120a0e, mid: 0x3a2024, horizon: 0x4e342c, glow: 0xff6a30, glowDir: [-0.4, 0.2, -0.9], glowPower: 4 },
celestial: { color: 0xff7a40, dir: [-0.4, 0.2, -0.9], size: 18, halo: 0.6 },
stars: 0,
lights: { hemiSky: 0xc89888, hemiGround: 0x4a3028, hemi: 0.75, keyColor: 0xffb890, key: 0.95, keyPos: [-12, 16, 12] },
ground: { grassDark: 0x3a362a, grassLight: 0x54503a, dirt: 0x4a3a2c, rock: 0x3c3834 },
mountains: { near: 0x362c2c, far: 0x504040, snow: null },
forest: { style: 'pine', foliage: [0x2a3322, 0x38422a], trunk: 0x2e2218, density: 0.6 }
};

const UNDEAD = {
seed: 53,
fog: { color: 0x1b2a33, near: 30, far: 190 },
sky: { zenith: 0x050810, mid: 0x101c28, horizon: 0x1b2a33, glow: 0x6aa0c0, glowDir: [0.3, 0.36, -0.9], glowPower: 7 },
celestial: { color: 0xe6eef8, dir: [0.3, 0.36, -0.9], size: 18, halo: 0.5 },
stars: 260,
lights: { hemiSky: 0x7a98c0, hemiGround: 0x20282c, hemi: 0.7, keyColor: 0xaec6e8, key: 0.75, keyPos: [10, 18, 10] },
ground: { grassDark: 0x27342c, grassLight: 0x3a4a3c, dirt: 0x34322c, rock: 0x484e52 },
mountains: { near: 0x1c2832, far: 0x2a3a48, snow: 0x90a8b8 },
forest: { style: 'dead', foliage: [0x1c2a22, 0x2a3a2a], trunk: 0x2a2420, density: 1.0 }
};

const BY_FACTION = new Map([
[CampaignFactionId.HUMAN, HUMAN],
[CampaignFactionId.GOBLIN, GOBLIN],
[CampaignFactionId.HOBGOBLIN, HOBGOBLIN],
[CampaignFactionId.UNDEAD, UNDEAD]
]);

export function getCampTheme(factionId) {
return BY_FACTION.get(factionId) || HUMAN;
}