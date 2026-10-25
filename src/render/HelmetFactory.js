// ===== HelmetFactory.js =====
// Bad-North-style headwear silhouettes, one per human unit type. Head
// anchor is HEAD_Y with radius HEAD_R — matches the head sphere in
// BlobBodyBuilder. Each silhouette is 1-3 primitives; at this zoom the
// read is silhouette, not detail.
//
// helmetType lives on UnitType (see config/UnitTypes.js). Adding a new
// unit variant means adding an entry there — and, only if its silhouette
// is new, a new builder below. No branch in SoldierView or
// SoldierModelComposer.
//
// Colours are a neutral steel grey, not a tint of the body colour —
// helmets are issued kit, so they read as metal against the team-coloured
// body rather than as a second team livery. The shade parameter lightens
// or darkens that steel: ranged/hooded units get a lighter shade, banded
// helms get a darker band for trim.
//
// Geometries and materials are cached (see MeshCache.js). Multi-part
// helmets whose pieces share one material (nasal, conical, plumed,
// crested) merge their parts into a single geometry via MeshMerge — one
// draw call per helmet instead of two, with no visual change. The
// banded helm keeps two separate meshes because its dome and band use
// different materials.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './mesh/MeshCache.js';
import { mergeGeometries, partMatrix } from './mesh/MeshMerge.js';

export class HelmetFactory {
  // Returns a THREE.Group positioned in local body space, or null if the
  // helmet type is blank/unknown (bare-headed — the visible head sphere
  // itself is the fallback silhouette).
  static createForType(helmetType, bodyColor) {
    if (!helmetType) return null;
    const builder = this._builders[helmetType];
    if (!builder) return null;
    const helmet = builder(bodyColor);
    // Helmets DO cast shadow. The earlier noShadow suppression was based
    // on "the head sphere already casts almost the same shadow" — that is
    // wrong: the helmet is wider (0.18 vs 0.16) and ~0.02 higher than the
    // head, so its shadow silhouette is larger than the head's. Omitting
    // it leaves a head-only shadow in the shadow map, which reads at
    // battle zoom as "the head pokes through the helmet" while the
    // soldier walks (the shadow map only refreshes at 30 Hz, so a
    // stationary soldier's shadow is stable and the artifact is not
    // visible).
    //
    // The original noShadow comment also warned about "one extra draw
    // call per soldier." With instancing on (default) every helmet of a
    // tier lands in ONE InstancedMesh bucket, so casting shadow costs
    // ONE extra draw call in the shadow pass total — not one per
    // soldier. The perf concern only applied to instancing-off, and
    // even there it is one draw per soldier per shadow refresh, not
    // per frame.
    return helmet;
  }
}

// Head anchor. MUST match BLOB_HEAD_Y in BlobBodyBuilder.js — every
// helmet in this file is positioned relative to this Y, so a mismatch
// leaves the helmet floating above (or sunk into) the head sphere.
const HEAD_Y = 1.02;
const HEAD_R = 0.16;

// Fixed steel base for every human helmet. The bodyColor parameter is
// retained for signature compatibility with every call site, but is
// deliberately ignored for the colour: helmets are issued kit, not team
// livery, so they read as steel rather than as a darkened team tint. The
// shade parameter is a plain brightness multiplier on this base — a
// hood's 0.8 reads lighter (cloth), a banded helm's 0.5 reads darker
// (trim). Because the colour no longer varies by team, the cache key
// drops bodyColor and both teams share one material instance per shade.
const HELMET_BASE_COLOR = 0xb8b8c0;

function helmetMaterial(bodyColor, shade = 0.7) {
  return cachedMaterial(`helmet.mat.${shade}`, () => {
    const c = new THREE.Color(HELMET_BASE_COLOR).multiplyScalar(shade);
    return new THREE.MeshLambertMaterial({ color: c });
  });
}

// Fresh geometry factory for the shared round cap piece. Multi-part
// helmets merge this with their extra pieces — mergeGeometries owns the
// disposal, so a fresh instance per call is correct.
function roundCapPiece() {
  return new THREE.SphereGeometry(
    HEAD_R + 0.02, 8, 5,
    0, Math.PI * 2,
    0, Math.PI / 2
  );
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

// Round cap + a narrow box down the front of the face. Both pieces share
// one material, so the two meshes merge into one.
function buildNasalHelm(bodyColor) {
  const group = new THREE.Group();
  const geo = cachedGeometry('helmet.nasal.geo', () =>
    mergeGeometries([
      { geometry: roundCapPiece(), matrix: partMatrix(0, HEAD_Y, 0) },
      {
        geometry: new THREE.BoxGeometry(0.04, 0.12, 0.03),
        matrix: partMatrix(0, HEAD_Y - 0.03, HEAD_R + 0.01)
      }
    ]));
  group.add(new THREE.Mesh(geo, helmetMaterial(bodyColor)));
  return group;
}

// Pointed cone on a short rim — the classic spear-infantry silhouette.
// Cone and rim share one material; merge.
function buildConicalHelm(bodyColor) {
  const group = new THREE.Group();
  // .v2 cache key so any in-flight session rebuilds instead of reusing
  // the pre-lift merged geometry.
  const geo = cachedGeometry('helmet.conical.geo.v2', () =>
    mergeGeometries([
      {
        geometry: new THREE.ConeGeometry(HEAD_R + 0.03, 0.22, 8),
        matrix: partMatrix(0, HEAD_Y + 0.16, 0)
      },
      {
        geometry: new THREE.CylinderGeometry(HEAD_R + 0.03, HEAD_R + 0.03, 0.04, 8),
        matrix: partMatrix(0, HEAD_Y + 0.06, 0)
      }
    ]));
  group.add(new THREE.Mesh(geo, helmetMaterial(bodyColor)));
  return group;
}

// Tall cloth cone, no rim — reads as a hood rather than a metal helmet.
// Lighter shade so it separates from the metal helms in the same palette.
// Single primitive, no merge.
function buildHood(bodyColor) {
  const group = new THREE.Group();
  // .v2 cache key: geometry is new (wider base, lifted position) and must
  // not reuse a pre-fix merged buffer still sitting in the cache.
  //
  // The hood cone is taller (0.30) than the conical helm's (0.22), so it
  // is narrower per unit height. A lift-only fix would need +0.06 or more
  // to clear the head sphere, which leaves the hood visibly floating off
  // the skull. Instead the base radius grows by the same amount as the
  // lift: the cone is 10% wider (invisible at battle zoom) and sits 0.04
  // higher, so the head sphere clears the shell at every height while the
  // covered/uncovered head split stays close to the original.
  const geo = cachedGeometry('helmet.hood.geo.v2', () =>
    new THREE.ConeGeometry(HEAD_R + 0.05, 0.30, 8));
  const cone = new THREE.Mesh(geo, helmetMaterial(bodyColor, 0.8));
  cone.position.y = HEAD_Y + 0.16;
  group.add(cone);
  return group;
}

// Round cap + a small feather box rising off the crown, offset slightly
// back so it silhouettes clearly against the sky in a side-on view. Both
// pieces share one material; merge.
function buildPlumedHelm(bodyColor) {
  const group = new THREE.Group();
  const geo = cachedGeometry('helmet.plumed.geo', () =>
    mergeGeometries([
      { geometry: roundCapPiece(), matrix: partMatrix(0, HEAD_Y, 0) },
      {
        geometry: new THREE.BoxGeometry(0.03, 0.14, 0.06),
        matrix: partMatrix(0, HEAD_Y + 0.20, -0.04)
      }
    ]));
  group.add(new THREE.Mesh(geo, helmetMaterial(bodyColor)));
  return group;
}

// Bucket helm: taller cylinder dome + a darker band at the base. Band uses
// a separate material instance (darker shade) so it reads as trim, not
// shadow — different materials cannot be merged without vertex colours,
// so this stays two meshes.
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
// Both pieces share one material; merge.
function buildCrestedHelm(bodyColor) {
  const group = new THREE.Group();
  const geo = cachedGeometry('helmet.crested.geo', () =>
    mergeGeometries([
      { geometry: roundCapPiece(), matrix: partMatrix(0, HEAD_Y, 0) },
      {
        geometry: new THREE.BoxGeometry(0.03, 0.10, 0.28),
        matrix: partMatrix(0, HEAD_Y + 0.12, 0)
      }
    ]));
  group.add(new THREE.Mesh(geo, helmetMaterial(bodyColor)));
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