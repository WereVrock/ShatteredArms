// ===== src/render/mesh/ShortSpearBuilder.js =====
// Short spear. Shorter and visually distinct from the standard spear:
//   - overall reach ~70% of the standard spear (hand-to-tip)
//   - a leather grip wrap at the hand position (the standard spear has none)
//   - a wider, four-faceted leaf tip instead of a narrow cone
//   - warmer wood tone than the standard spear
//
// Built along +Z like every other melee weapon in the game, so SoldierView's
// pitch / thrust composition works unchanged. The gameplay difference lives
// in the animation (fixed diagonal-up idle, horizontal thrust attack) — see
// SoldierView's _isShortSpear branch — not in this geometry.
//
// Merge strategy: same as SpearBuilder / SwordBuilder. Every part shares one
// vertexColors material, so the whole weapon is one draw call. Geometries
// are cached; the merged geometry and material are shared by every short
// spear in the game.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeColoredGeometries, partMatrix, paint } from './MeshMerge.js';

// Reach: total from hand (z=0) to tip apex is ~0.98, versus the standard
// spear's ~1.39. That's the "shorter" read at battle zoom.
const SHAFT_LENGTH = 0.95;
const SHAFT_RADIUS = 0.024;
// How far the shaft extends BEHIND the hand. Matches the standard spear's
// proportions (the hand grips near the back third).
const SHAFT_BACK_OVERHANG = 0.15;

const TIP_LENGTH = 0.18;
const TIP_RADIUS = 0.055;

const GRIP_LENGTH = 0.20;
const GRIP_RADIUS = SHAFT_RADIUS + 0.008;

const WOOD_COLOR = 0x6b4a28;
const GRIP_COLOR = 0x2a1a0e;
const TIP_COLOR  = 0xa8a8a8;

export function createShortSpear() {
  const geo = cachedGeometry('shortSpear.mergedGeo', buildMergedShortSpear);
  const mat = cachedMaterial('shortSpear.mergedMat', () =>
    new THREE.MeshLambertMaterial({ vertexColors: true }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0.24, 0.65, 0);
  return mesh;
}

function buildMergedShortSpear() {
  const entries = [];

  // Shaft: uniform cylinder laid along Z, hand at z=0. Spans
  // -SHAFT_BACK_OVERHANG .. (SHAFT_LENGTH - SHAFT_BACK_OVERHANG).
  {
    const g = new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_LENGTH, 6);
    g.rotateX(Math.PI / 2);
    entries.push({
      geometry: paint(g, WOOD_COLOR),
      matrix: partMatrix(0, 0, SHAFT_LENGTH / 2 - SHAFT_BACK_OVERHANG)
    });
  }

  // Leather grip wrap at the hand. Slightly proud of the shaft so it reads
  // as a wrapped grip rather than a colour band.
  {
    const g = new THREE.CylinderGeometry(GRIP_RADIUS, GRIP_RADIUS, GRIP_LENGTH, 6);
    g.rotateX(Math.PI / 2);
    entries.push({
      geometry: paint(g, GRIP_COLOR),
      matrix: partMatrix(0, 0, 0)
    });
  }

  // Tip: four-faceted leaf. Wider and shorter than the standard spear's
  // cone, which is what gives the short spear its silhouette — a chopped
  // broad point rather than a narrow needle.
  //
  // ConeGeometry axis is +Y with apex at +height/2; rotateX(π/2) maps apex
  // to +Z (forward) and base to -Z. Base sits at the shaft's front end:
  // shaft front = SHAFT_LENGTH - SHAFT_BACK_OVERHANG = 0.80. Center placed
  // at 0.80 + TIP_LENGTH/2 so the base lands exactly there.
  {
    const g = new THREE.ConeGeometry(TIP_RADIUS, TIP_LENGTH, 4);
    g.rotateX(Math.PI / 2);
    entries.push({
      geometry: paint(g, TIP_COLOR),
      matrix: partMatrix(
        0, 0,
        (SHAFT_LENGTH - SHAFT_BACK_OVERHANG) + TIP_LENGTH / 2
      )
    });
  }

  return mergeColoredGeometries(entries);
}