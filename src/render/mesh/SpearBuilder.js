// Spear: wooden shaft + tip, laid along +Z.
//
// Two variants share one geometry — the standard-issue spear and the
// goblin spear differ only in palette.
//
// MERGE STRATEGY
// Shaft and tip merge into a SINGLE vertex-coloured mesh, one draw call
// per spear instead of two. The goblin and human variants share the same
// merged geometry shape but use distinct cache keys so the vertex colours
// differ (brown wood + steel tip vs. dark wood + flint tip).
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeColoredGeometries, partMatrix, paint } from './MeshMerge.js';

const WOOD_COLOR        = 0x5a3d20;
const GOBLIN_WOOD_COLOR = 0x3f2a12;
const STEEL_COLOR       = 0xaaaaaa;
const FLINT_COLOR       = 0x8a8060;

export function createSpear() {
  const geo = cachedGeometry('spear.mergedGeo', () =>
    buildMergedSpear(WOOD_COLOR, STEEL_COLOR));
  const mat = cachedMaterial('spear.mergedMat', () =>
    new THREE.MeshLambertMaterial({ vertexColors: true }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0.24, 0.65, 0);
  return mesh;
}

export function createGoblinSpear() {
  const geo = cachedGeometry('goblinSpear.mergedGeo', () =>
    buildMergedSpear(GOBLIN_WOOD_COLOR, FLINT_COLOR));
  const mat = cachedMaterial('goblinSpear.mergedMat', () =>
    new THREE.MeshLambertMaterial({ vertexColors: true }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0.24, 0.65, 0);
  return mesh;
}

function buildMergedSpear(woodColor, tipColor) {
  const entries = [];

  // Shaft: uniform cylinder laid along Z.
  {
    const g = new THREE.CylinderGeometry(0.02, 0.02, 1.4, 6);
    g.rotateX(Math.PI / 2);
    entries.push({
      geometry: paint(g, woodColor),
      matrix: partMatrix(0, 0, 0.6)
    });
  }

  // Tip: small cone at the front.
  {
    const g = new THREE.ConeGeometry(0.04, 0.18, 6);
    g.rotateX(Math.PI / 2);
    entries.push({
      geometry: paint(g, tipColor),
      matrix: partMatrix(0, 0, 1.3)
    });
  }

  return mergeColoredGeometries(entries);
}