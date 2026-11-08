// ===== CampProps.js =====
// Builds the whole camp scene for one faction: scenery (sky, terrain,
// mountains, forest) plus two prop clusters.
//
// LAYOUT RULE. The menu panel covers the screen centre, so the camp is two
// clusters at x = +/-10 (see CampCameraRig.CAMP_CLUSTER_X) with an open
// avenue between them. Right cluster = command, left cluster = troops. The
// left cluster keeps its important props toward the inner side because the
// campaign roster sidebar covers the far-left edge of the screen.
//
// buildCamp() returns { group, theme, update(t), dispose() }. update(t)
// drives flames, smoke, banners and wisps; call it with any time value
// (the still snapshot uses a fixed one).

import * as THREE from 'three';
import { CampaignFactionId } from '../campaign/CampaignFaction.js';
import { TeamColors } from '../render/TeamColors.js';
import { getCampTheme } from './camp/CampThemes.js';
import { buildScenery } from './camp/CampScenery.js';
import { disposeObject3D } from './camp/CampGeometry.js';
import {
  C, CampContext, banner, pavilion, bellTent, campfire, crate, barrel, sacks,
  hayBale, weaponRack, dummy, wagon, watchtower, palisade, fence, table,
  horse, lampPost, glowSprite
} from './camp/CampPropKit.js';
import {
  skull, bonePile, hideTent, totem, cage, cauldron, meatRack, warDrum,
  spikedFence, warTent, brazier, siegeRam, stoneTower, gravestone, crypt,
  deadTree, boneArch, ironFence, openGrave, coffin, wisp, necroCircle,
  skullStandard, lampPostGreen
} from './camp/CampPropKitDark.js';

// Trodden dirt patch under a prop group.
function patch(ctx, x, z, r, color = 0x4e3c28) {
  ctx.local(x, z).disc({ r, y: 0.04, seg: 18, color });
}

// --- human -----------------------------------------------------------------

function humanCamp(ctx) {
  const at = (x, z, ry = 0, k = 1) => ctx.local(x, z, ry, k);
  const blue = TeamColors.blue;

  // Command cluster (right).
  patch(ctx, 11, -3, 6.5);
  patch(ctx, 10, 3.8, 3.4);
  pavilion(at(11, -3.6, 0.12, 1.05));
  banner(at(7, -0.6), { h: 5.4, color: blue });
  banner(at(15.2, -0.4), { h: 5.4, color: blue });
  bellTent(at(15.6, 3.4, -0.7));
  bellTent(at(6.4, -6.4, 0.6));
  bellTent(at(16.8, -6.6, 0.2, 0.9), { color: C.canvasShade });
  campfire(at(9.2, 3.8));
  table(at(13.2, 4.3, 0.15));
  crate(at(6.2, 2.0, 0.4));
  crate(at(6.9, 2.8, -0.2), { s: 0.55 });
  barrel(at(5.9, 3.4));
  sacks(at(17.4, 1.2, 0.5));
  hayBale(at(5.4, -2.4, 0.6));
  watchtower(at(17.5, -10.5, -0.35));
  palisade(at(2.6, -11.5), { len: 17 });

  // Troop cluster (left).
  patch(ctx, -10, -2, 7.5);
  patch(ctx, -10, 3.8, 3.6);
  [-7.8, -11.4, -15, -18.2].forEach((x, i) => {
    bellTent(at(x, -1.4 - (i % 2) * 0.5, (i - 1.5) * 0.12));
    bellTent(at(x + 0.3, -6.6 + (i % 2) * 0.4, (1.5 - i) * 0.1));
  });
  campfire(at(-9.5, 3.6));
  campfire(at(-14.5, 4.0, 0, 0.9));
  weaponRack(at(-6.4, 2.2, 0.5));
  dummy(at(-16.8, 3.2, 0.4));
  dummy(at(-18.2, 4.6, -0.2));
  banner(at(-6.2, -3.9), { h: 5, color: blue });
  banner(at(-16.4, -4.1), { h: 5, color: blue });
  wagon(at(-6.6, -9.6, 0.9));
  fence(at(-19, -9.4), { len: 7 });
  horse(at(-17.2, -10.3, 0.15), { color: 0x6a4428 });
  horse(at(-14.6, -10.6, -0.1), { color: 0xd8d0c0 });
  horse(at(-12.2, -10.3, 0.2), { color: 0x3a2a20 });
  lampPost(at(-5.8, 4.8));
  watchtower(at(-17.5, -12.5, 0.35));
  palisade(at(-19.5, -13.5), { len: 17 });
}

// --- goblin ----------------------------------------------------------------

function goblinCamp(ctx) {
  const at = (x, z, ry = 0, k = 1) => ctx.local(x, z, ry, k);
  const crude = 0x5a7a2a;

  patch(ctx, 11, -3, 6.5, 0x3a2c1c);
  patch(ctx, 10, 3.6, 3.4, 0x3a2c1c);
  hideTent(at(11, -3.8, 0.2, 1.55));
  totem(at(7.2, 0.6));
  totem(at(15.4, -0.2, 0, 1.1));
  cauldron(at(9.6, 3.5));
  cage(at(15, 3.8, -0.4));
  warDrum(at(12.6, 2.4));
  bonePile(at(6.5, -5));
  bonePile(at(16.7, -6.2));
  hideTent(at(16.6, -7.8, -0.5, 0.9));
  banner(at(13.8, 1.0), { h: 4.6, color: crude, trim: C.bone });
  spikedFence(at(3.5, -11.5), { len: 16 });

  patch(ctx, -10, -3, 7.5, 0x3a2c1c);
  const tents = [
    [-8.0, -2.0, 0.4, 1.0], [-12.4, -0.8, -0.3, 1.1], [-16.5, -2.6, 0.9, 0.95],
    [-9.8, -7.2, -0.6, 1.05], [-14.2, -6.6, 0.2, 1.0], [-18.2, -8.2, 0.7, 0.9]
  ];
  for (const [x, z, ry, k] of tents) hideTent(at(x, z, ry, k), { trophy: k > 1 });
  campfire(at(-10.2, 3.2), { seats: false });
  campfire(at(-15.0, 3.8, 0, 0.9), { seats: false });
  meatRack(at(-7.0, 3.8, 0.3));
  totem(at(-17.6, 2.2, 0, 1.05));
  bonePile(at(-12.5, 1.6));
  bonePile(at(-6.6, -6.2));
  banner(at(-6.4, -3.6), { h: 4.6, color: crude, trim: C.bone });
  crate(at(-18.8, 4.6, 0.6));
  barrel(at(-5.8, 1.0));
  spikedFence(at(-19.5, -12), { len: 16 });
}

// --- hobgoblin -------------------------------------------------------------

function hobgoblinCamp(ctx) {
  const at = (x, z, ry = 0, k = 1) => ctx.local(x, z, ry, k);
  const red = 0xa53a3a;

  patch(ctx, 11, -3, 6.5, 0x3a2e28);
  patch(ctx, 11, 3.8, 3.6, 0x3a2e28);
  warTent(at(11, -3.8, 0, 1.4));
  banner(at(7.0, -0.4), { h: 5.6, color: red });
  banner(at(15.2, -0.4), { h: 5.6, color: red });
  banner(at(11, 1.4), { h: 4.2, color: red, trim: C.bone });
  brazier(at(8.4, 2.4));
  brazier(at(13.8, 2.4));
  siegeRam(at(14.8, 5.0, -0.4));
  weaponRack(at(6.6, 4.4, 0.3));
  crate(at(17.2, -2, 0.3));
  barrel(at(17.0, -3.0));
  stoneTower(at(6.0, -11.2), { h: 5.2 });
  stoneTower(at(16.5, -11.2), { h: 5.2 });
  palisade(at(7.4, -11.4), { len: 8, h: 2.6 });

  patch(ctx, -10, -4, 8, 0x3a2e28);
  [-7.4, -11.0, -14.6, -18.2].forEach((x) => {
    warTent(at(x, -1.5, 0, 0.8));
    warTent(at(x, -7.4, 0, 0.8));
  });
  brazier(at(-9.2, -4.5));
  brazier(at(-14.4, -4.5));
  banner(at(-6.0, -4.3), { h: 5, color: red });
  banner(at(-18.8, -4.3), { h: 5, color: red });
  weaponRack(at(-6.6, 2.4, 0.4));
  dummy(at(-16.2, 3.6, 0.3));
  dummy(at(-13.4, 4.2, -0.2));
  dummy(at(-18.0, 4.8, 0.5));
  campfire(at(-10.6, 4.2), { seats: false });
  wagon(at(-6.8, -11.4, 0.7));
  stoneTower(at(-6.2, -13.4), { h: 5.2 });
  stoneTower(at(-17.5, -13.4), { h: 5.2 });
  palisade(at(-16.4, -13.6), { len: 9, h: 2.6 });
}

// --- undead ----------------------------------------------------------------

function undeadCamp(ctx) {
  const at = (x, z, ry = 0, k = 1) => ctx.local(x, z, ry, k);

  // Command cluster: crypt + necromancer's circle.
  patch(ctx, 11, -3, 6.5, 0x2a2c26);
  crypt(at(11.5, -5.2, 0, 1.1));
  necroCircle(at(10, 3.4), { r: 3.2 });
  skullStandard(at(6.6, -1.2));
  skullStandard(at(16.6, 0.6), { color: 0x2a3a5a });
  ironFence(at(5.4, -9.4), { len: 5 });
  ironFence(at(15.8, -9.4), { len: 5 });
  gravestone(at(15.8, 3.8, 0.3));
  gravestone(at(16.6, 5.0, -0.2));
  deadTree(at(17.4, -4, 0.5));
  lampPostGreen(at(6.0, 5.4));
  coffin(at(14.6, 1.8, 0.5));

  // Graveyard (left).
  const rng = ctx.rng;
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 6; i++) {
      const x = -6.8 - i * 2.05 + (rng() - 0.5) * 0.5;
      const z = -1.0 - row * 3.2 + (rng() - 0.5) * 0.6;
      gravestone(at(x, z, (rng() - 0.5) * 0.4));
    }
  }
  openGrave(at(-9.6, 3.2, 0.3));
  openGrave(at(-14.8, 4.2, -0.2));
  boneArch(at(-12.5, 1.0, 0.05), { w: 5.2, h: 3.6 });
  deadTree(at(-17.8, -10.4, 0.2));
  deadTree(at(-7.2, -10.6, 0.6));
  deadTree(at(-19.2, 3.4, -0.3), { len: 2.8 });
  ironFence(at(-19.5, -12.4), { len: 15 });
  lampPostGreen(at(-6.0, 4.6));
  lampPostGreen(at(-18.4, -1.0));
  coffin(at(-16.4, 3.0, -0.4));

  // Wisps drifting over both sides of the avenue.
  const wisps = [
    [-8, 1.8, 0], [-13, 2.6, -3], [-16, 1.5, -6], [8.5, 2.0, 1], [13, 2.8, -2], [16, 1.7, -7]
  ];
  for (const [x, y, z] of wisps) wisp(at(x, z), { y });
}

const LAYOUTS = new Map([
  [CampaignFactionId.HUMAN, humanCamp],
  [CampaignFactionId.GOBLIN, goblinCamp],
  [CampaignFactionId.HOBGOBLIN, hobgoblinCamp],
  [CampaignFactionId.UNDEAD, undeadCamp]
]);

export function buildCamp(factionId) {
  const theme = getCampTheme(factionId);
  const layout = LAYOUTS.get(factionId) || humanCamp;

  const ctx = new CampContext(theme.seed);
  layout(ctx);

  const group = new THREE.Group();
  group.add(buildScenery(theme));
  group.add(ctx.finish());

  return {
    group,
    theme,
    update: (t) => ctx.update(t),
    dispose: () => disposeObject3D(group)
  };
}