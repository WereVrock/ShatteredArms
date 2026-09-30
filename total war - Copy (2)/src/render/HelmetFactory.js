// ===== HelmetFactory.js =====
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './mesh/MeshCache.js';

// Bad-North-style headwear silhouettes, one per human unit type. Head anchor
// is (0, 0.85, 0) with radius 0.16 — matches the head sphere in
// SoldierMeshFactory.createBlobBody. Each silhouette is 1-3 primitives; at
// this zoom the read is silhouette, not detail.
//
// helmetType lives on UnitType (see config/UnitTypes.js). Adding a new unit
// variant means adding an entry there — and, only if its silhouette is new,
// a new builder below. No branch in SoldierView or SoldierMeshFactory.
//
// Colours are a darkened tint of the body colour, so helmets read as
// metal/leather against the team-coloured body without introducing a new
// palette. Ranged/hooded units get a lighter shade (cloth), banded helms a
// darker band (trim).
//
// Geometries and materials are cached (see MeshCache.js). With two teams and
// a handful of shades there are at most a few dozen distinct helmet materials
// in the entire game, and every helmet geometry is a single shared instance.
export class HelmetFactory {
  // Returns a THREE.Group positioned in local body space, or null if the
  // helmet type is blank/unknown (bare-headed — the visible head sphere
  // itself is the fallback silhouette).
  static createForType(helmetType, bodyColor) {
    if (!helmetType) return null;
    const builder = this._builders[helmetType];
    if (!builder) return null;
    return builder(bodyColor);
  }
}

// Head anchor. MUST match BLOB_HEAD_Y in SoldierMeshFactory.js — every
// helmet in this file is positioned relative to this Y, so a mismatch
// leaves the helmet floating above (or sunk into) the head sphere.
const HEAD_Y = 1.02;
const HEAD_R = 0.16;

function helmetMaterial(bodyColor, shade = 0.7) {
  return cachedMaterial(`helmet.mat.${bodyColor}.${shade}`, () => {
    const c = new THREE.Color(bodyColor).multiplyScalar(shade);
    return new THREE.MeshLambertMaterial({ color: c });
  });
}

// --- silhouettes ------------------------------------------------------------

// Plain hemisphere cap. Base of the cap sits at the head centre; the head
// sphere's lower half stays visible as the face.
function buildRoundCap(bodyColor) {
  const group = new THREE.Group();
  const geo = cachedGeometry('helmet.roundCap.geo', () =>
    new THREE.SphereGeometry(
      HEAD_R + 0.02, 8, 5,
      0, Math.PI * 2,
      0, Math.PI / 2
    ));
  const cap = new THREE.Mesh(geo, helmetMaterial(bodyColor));
  cap.position.y = HEAD_Y;
  group.add(cap);
  return group;
}

// Round cap + a narrow box down the front of the face.
function buildNasalHelm(bodyColor) {
  const group = buildRoundCap(bodyColor);
  const mat = group.children[0].material;
  const noseGeo = cachedGeometry('helmet.nasal.noseGeo', () =>
    new THREE.BoxGeometry(0.04, 0.12, 0.03));
  const nose = new THREE.Mesh(noseGeo, mat);
  nose.position.set(0, HEAD_Y - 0.03, HEAD_R + 0.01);
  group.add(nose);
  return group;
}

// Pointed cone on a short rim — the classic spear-infantry silhouette.
function buildConicalHelm(bodyColor) {
  const group = new THREE.Group();
  const mat = helmetMaterial(bodyColor);

  const coneGeo = cachedGeometry('helmet.conical.coneGeo', () =>
    new THREE.ConeGeometry(HEAD_R + 0.03, 0.22, 8));
  const cone = new THREE.Mesh(coneGeo, mat);
  cone.position.y = HEAD_Y + 0.13;
  group.add(cone);

  const rimGeo = cachedGeometry('helmet.conical.rimGeo', () =>
    new THREE.CylinderGeometry(HEAD_R + 0.03, HEAD_R + 0.03, 0.04, 8));
  const rim = new THREE.Mesh(rimGeo, mat);
  rim.position.y = HEAD_Y + 0.03;
  group.add(rim);

  return group;
}

// Tall cloth cone, no rim — reads as a hood rather than a metal helmet.
// Lighter shade so it separates from the metal helms in the same palette.
function buildHood(bodyColor) {
  const group = new THREE.Group();
  const mat = helmetMaterial(bodyColor, 0.8);

  const coneGeo = cachedGeometry('helmet.hood.coneGeo', () =>
    new THREE.ConeGeometry(HEAD_R + 0.03, 0.30, 8));
  const cone = new THREE.Mesh(coneGeo, mat);
  cone.position.y = HEAD_Y + 0.12;
  group.add(cone);

  return group;
}

// Round cap + a small feather box rising off the crown, offset slightly back
// so it silhouettes clearly against the sky in a side-on view.
function buildPlumedHelm(bodyColor) {
  const group = buildRoundCap(bodyColor);
  const mat = group.children[0].material;

  const plumeGeo = cachedGeometry('helmet.plumed.plumeGeo', () =>
    new THREE.BoxGeometry(0.03, 0.14, 0.06));
  const plume = new THREE.Mesh(plumeGeo, mat);
  plume.position.set(0, HEAD_Y + 0.20, -0.04);
  group.add(plume);

  return group;
}

// Bucket helm: taller cylinder dome + a darker band at the base. Band uses a
// separate material instance (darker shade) so it reads as trim, not shadow.
function buildBandedHelm(bodyColor) {
  const group = new THREE.Group();

  const domeGeo = cachedGeometry('helmet.banded.domeGeo', () =>
    new THREE.CylinderGeometry(HEAD_R + 0.02, HEAD_R + 0.02, 0.24, 10));
  const dome = new THREE.Mesh(domeGeo, helmetMaterial(bodyColor));
  dome.position.y = HEAD_Y + 0.07;
  group.add(dome);

  const bandGeo = cachedGeometry('helmet.banded.bandGeo', () =>
    new THREE.CylinderGeometry(HEAD_R + 0.03, HEAD_R + 0.03, 0.035, 10));
  const band = new THREE.Mesh(bandGeo, helmetMaterial(bodyColor, 0.5));
  band.position.y = HEAD_Y - 0.04;
  group.add(band);

  return group;
}

// Round cap + a crest fin running front-to-back along the top — a cheap
// side-on "cavalry officer" read that a plume can't give at small sizes.
function buildCrestedHelm(bodyColor) {
  const group = buildRoundCap(bodyColor);
  const mat = group.children[0].material;

  const crestGeo = cachedGeometry('helmet.crested.crestGeo', () =>
    new THREE.BoxGeometry(0.03, 0.10, 0.28));
  const crest = new THREE.Mesh(crestGeo, mat);
  crest.position.set(0, HEAD_Y + 0.12, 0);
  group.add(crest);

  return group;
}

HelmetFactory._builders = {
  roundCap:     (c) => buildRoundCap(c),
  nasalHelm:    (c) => buildNasalHelm(c),
  conicalHelm:  (c) => buildConicalHelm(c),
  hood:         (c) => buildHood(c),
  plumedHelm:   (c) => buildPlumedHelm(c),
  bandedHelm:   (c) => buildBandedHelm(c),
  crestedHelm:  (c) => buildCrestedHelm(c)
};