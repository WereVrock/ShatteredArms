// ===== HelmetFactory.js =====
// Bad-North-style headwear silhouettes, one per human unit type. Head
// anchor is HEAD_Y with radius HEAD_R — matches the head sphere in
// BlobBodyBuilder. Every builder is a small handful of primitives but
// each is shaped to a specific real helmet archetype so the SILHOUETTE
// reads even at battle zoom, not just the colour:
//
//   roundCap     — skullcap: flattened dome, base rim, small front peak.
//   nasalHelm    — Norman: dome + rim + prominent nasal guard + brow.
//   conicalHelm  — spangenhelm: lathe-turned rim → rounded shoulder → cone → tip.
//   hood         — cloth: lathe-turned flowing cone, no rim, no peak.
//   plumedHelm   — crested cap: dome + rim + flattened swept-back plume.
//   bandedHelm   — full-face great helm: tall cylindrical body, rounded
//                  shoulder and pointed top, brow ridge, horizontal eye
//                  slits, and a grid of small circular air holes.
//   crestedHelm  — fin crest: dome + rim + three-segment front-back fin.
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
// Geometries and materials are cached (see MeshCache.js). Every piece a
// helmet needs (dome, rim, peak, plume, nasal, brow, slits) shares the
// helmet material, so all of them merge into a single mesh — one draw
// call per helmet. The only second mesh is the near-black slit strip on
// the full-face banded helm, which is a different material by design.
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
    // Helmets DO cast shadow. The earlier noShadow suppression was based
    // on "the head sphere already casts almost the same shadow" — that is
    // wrong: the helmet is wider (0.18 vs 0.16) and ~0.02 higher than the
    // head, so its shadow silhouette is larger than the head's. Omitting
    // it leaves a head-only shadow in the shadow map, which reads at
    // battle zoom as "the head pokes through the helmet" while the
    // soldier walks.
    //
    // The original noShadow comment also warned about "one extra draw
    // call per soldier." With instancing on (default) every helmet of a
    // tier lands in ONE InstancedMesh bucket, so casting shadow costs
    // ONE extra draw call in the shadow pass total — not one per soldier.
    return builder(bodyColor);
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

// Fresh geometry factory for the shared round dome piece. Multi-part
// helmets merge this with their extra pieces — mergeGeometries owns the
// disposal, so a fresh instance per call is correct.
//
// Slightly flattened (0.88 on Y) so the dome hugs the head instead of
// sitting on it as a perfect half-ball. 12 lat / 6 lon is enough for a
// smooth silhouette; going higher is invisible at battle zoom.
function domePiece() {
  const g = new THREE.SphereGeometry(
    HEAD_R + 0.02, 12, 6,
    0, Math.PI * 2,
    0, Math.PI * 0.5
  );
  // Scale Y by 1.02 (was 0.88) so the dome extends slightly higher than
  // the head sphere. The previous squash made the dome shorter than the
  // head, causing the skin to clip through the top of the helmet.
  g.scale(1, 1.02, 1);
  return g;
}

// Shared base rim: a thin ring at the bottom edge of the dome. Sits at
// HEAD_Y (the plane the head sphere's equator crosses) so the dome's
// base edge lands exactly on the head, not floating above it.
function rimPiece(shade = 0) {
  return {
    geometry: new THREE.CylinderGeometry(
      HEAD_R + 0.028, HEAD_R + 0.028, 0.028, 12),
    matrix: partMatrix(0, HEAD_Y + 0.010, 0)
  };
}

// --- silhouettes ------------------------------------------------------------

// Skullcap. Flattened dome + base rim + small front visor peak. The peak
// is a thin plate cantilevered forward from the brow, tilted slightly
// down at the front so it reads as a proper visor rather than a flat
// brim. Silhouette from the side: low, close to the head, with a small
// forward tab. Distinctly different from the nasal helm (which has a
// down-the-face guard) and from the conical (which has a pointed crown).
function buildRoundCap(bodyColor) {
  const group = new THREE.Group();
  const geo = cachedGeometry('helmet.roundCap.geo.v2', () =>
    mergeGeometries([
      { geometry: domePiece(), matrix: partMatrix(0, HEAD_Y - 0.005, 0) },
      rimPiece(),
      // Front visor peak. rotation.x = +0.15 tips the front edge down.
      {
        geometry: new THREE.BoxGeometry(0.15, 0.022, 0.06),
        matrix: partMatrix(0, HEAD_Y + 0.015, HEAD_R + 0.032, 0.15, 0, 0)
      }
    ]));
  group.add(new THREE.Mesh(geo, helmetMaterial(bodyColor)));
  return group;
}

// Norman nasal helm. Dome + rim + a prominent nasal guard down the face
// and a brow ridge over the eyes. The nasal is the silhouette read: at
// battle zoom, a steel oval on the face with a bar down the middle is
// instantly "Norman knight" — no other helmet in this file has it.
function buildNasalHelm(bodyColor) {
  const group = new THREE.Group();
  const geo = cachedGeometry('helmet.nasal.geo.v2', () =>
    mergeGeometries([
      { geometry: domePiece(), matrix: partMatrix(0, HEAD_Y - 0.005, 0) },
      rimPiece(),
      // Nasal guard: tapered plate from brow to chin, slightly proud of
      // the face so it silhouettes against the head.
      {
        geometry: new THREE.BoxGeometry(0.032, 0.14, 0.022),
        matrix: partMatrix(0, HEAD_Y - 0.06, HEAD_R + 0.012)
      },
      // Brow ridge: a shallow horizontal bar across the front just above
      // eye level. Tilted slightly (rotation.x = 0.15) so the front edge
      // is lower than the back, reading as a defensive overhang rather
      // than a decorative stripe.
      {
        geometry: new THREE.BoxGeometry(0.20, 0.020, 0.030),
        matrix: partMatrix(0, HEAD_Y + 0.025, HEAD_R + 0.012, 0.15, 0, 0)
      }
    ]));
  group.add(new THREE.Mesh(geo, helmetMaterial(bodyColor)));
  return group;
}

// Spangenhelm-style conical helm. A single lathe-turned profile from
// bottom to tip: vertical rim, rounded shoulder, straight cone taper,
// point. The rounded shoulder is what distinguishes a spangenhelm from
// a plain traffic cone and is the shape a soldier's eye reads first.
function buildConicalHelm(bodyColor) {
  const group = new THREE.Group();
  const geo = cachedGeometry('helmet.conical.geo.v3', () => {
    // All Y values are offsets from HEAD_Y (see domePiece / rimPiece for
    // why HEAD_Y + a small lift is where the head sphere's crown is).
    const profile = [
      new THREE.Vector2(HEAD_R + 0.032, HEAD_Y + 0.000),  // rim bottom
      new THREE.Vector2(HEAD_R + 0.032, HEAD_Y + 0.030),  // rim top (vertical)
      new THREE.Vector2(HEAD_R + 0.025, HEAD_Y + 0.070),  // shoulder start
      new THREE.Vector2(HEAD_R + 0.005, HEAD_Y + 0.160),  // shoulder end
      new THREE.Vector2(0.040, HEAD_Y + 0.260),           // cone body
      new THREE.Vector2(0.000, HEAD_Y + 0.300)            // tip
    ];
    return new THREE.LatheGeometry(profile, 12);
  });
  group.add(new THREE.Mesh(geo, helmetMaterial(bodyColor)));
  return group;
}

// Cloth hood. Lathe-turned flowing cone with a rounded base — no rim,
// no peak, no metal trim. Lighter shade (0.8) so it separates from the
// metal helms in the same palette. Distinctly different silhouette from
// the conical helm: the shoulder is lower and rounder, and the tip leans
// forward slightly (the profile's last point is offset by X).
function buildHood(bodyColor) {
  const group = new THREE.Group();
  const geo = cachedGeometry('helmet.hood.geo.v3', () => {
    const profile = [
      new THREE.Vector2(HEAD_R + 0.050, HEAD_Y + 0.000),
      new THREE.Vector2(HEAD_R + 0.045, HEAD_Y + 0.050),
      new THREE.Vector2(HEAD_R + 0.030, HEAD_Y + 0.120),
      new THREE.Vector2(HEAD_R + 0.010, HEAD_Y + 0.220),
      new THREE.Vector2(0.015, HEAD_Y + 0.300),
      new THREE.Vector2(0.000, HEAD_Y + 0.330)
    ];
    return new THREE.LatheGeometry(profile, 10);
  });
  group.add(new THREE.Mesh(geo, helmetMaterial(bodyColor, 0.8)));
  return group;
}

// Plumed helm. Dome + rim + a flattened, swept-back plume. The plume is
// a cone scaled (0.5, 1, 1.5) — narrow side-to-side, tall, and wide
// front-to-back — which gives the "feather" silhouette from a side view
// while staying slim from the front. The -0.15 X rotation sweeps it
// back off the crown.
function buildPlumedHelm(bodyColor) {
  const group = new THREE.Group();
  const geo = cachedGeometry('helmet.plumed.geo.v2', () => {
    const plume = new THREE.ConeGeometry(0.05, 0.22, 8);
    plume.scale(0.5, 1, 1.5);
    return mergeGeometries([
      { geometry: domePiece(), matrix: partMatrix(0, HEAD_Y - 0.005, 0) },
      rimPiece(),
      {
        geometry: plume,
        matrix: partMatrix(0, HEAD_Y + 0.180, -0.030, -0.15, 0, 0)
      }
    ]);
  });
  group.add(new THREE.Mesh(geo, helmetMaterial(bodyColor)));
  return group;
}

// Full-face great helm, matching the reference image: a cylindrical body
// with a rounded shoulder and pointed top, a thick base rim, a brow
// ridge, two horizontal eye slits, and a grid of small circular air holes
// on the lower half. No brass cross (per user request).
//
// The main body is a lathe profile from the bottom rim up to the point.
// The eye slits and air holes are merged into a single near-black mesh
// so they cost one draw call and read as cut-outs regardless of scene
// lighting. They sit just proud of the front face so they read as
// embedded, not as decals floating in air.
function buildBandedHelm(bodyColor) {
  const group = new THREE.Group();

  const HELM_BOTTOM_Y = HEAD_Y - HEAD_R - 0.03; // 0.83
  const HELM_TOP_Y = HEAD_Y + HEAD_R + 0.10;    // 1.28
  const R = HEAD_R + 0.025; // 0.185

  // 1. Main body (dome + rim). Lathe profile from bottom to point.
  const bodyGeo = cachedGeometry('helmet.banded.bodyGeo.v5', () => {
    const profile = [
      new THREE.Vector2(R + 0.008, HELM_BOTTOM_Y),        // bottom outer edge
      new THREE.Vector2(R + 0.008, HELM_BOTTOM_Y + 0.02), // rim top
      new THREE.Vector2(R, HELM_BOTTOM_Y + 0.02),         // step in
      new THREE.Vector2(R, HELM_BOTTOM_Y + 0.34),         // straight cylinder (taller)
      new THREE.Vector2(R, HELM_BOTTOM_Y + 0.38),         // straight up (no shoulder)
      new THREE.Vector2(0.01, HELM_BOTTOM_Y + 0.50),      // sharp straight taper to a point
      new THREE.Vector2(0.0, HELM_BOTTOM_Y + 0.50)        // pointed top
    ];
    return new THREE.LatheGeometry(profile, 16);
  });
  group.add(new THREE.Mesh(bodyGeo, helmetMaterial(bodyColor)));

  // 2. Brow ridge (thin bar above the eyes)
  const browGeo = cachedGeometry('helmet.banded.browGeo.v2', () =>
    new THREE.BoxGeometry(0.20, 0.020, 0.025));
  const brow = new THREE.Mesh(browGeo, helmetMaterial(bodyColor));
  brow.position.set(0, HEAD_Y + 0.035, R - 0.015);
  brow.rotation.x = 0.10;
  group.add(brow);

  // 3. Slits and holes (black material)
  const darkMat = cachedMaterial('helmet.banded.darkMat', () =>
    new THREE.MeshBasicMaterial({ color: 0x080808 }));

  // Eye slits (two horizontal bars)
  const eyeGeo = cachedGeometry('helmet.banded.eyeGeo.v2', () => {
    const entries = [];
    for (const sx of [-0.05, 0.05]) {
      const z = Math.sqrt(R * R - sx * sx) - 0.005;
      entries.push({
        geometry: new THREE.BoxGeometry(0.08, 0.015, 0.02),
        matrix: partMatrix(sx, HEAD_Y + 0.015, z)
      });
    }
    return mergeGeometries(entries);
  });
  group.add(new THREE.Mesh(eyeGeo, darkMat));

  // Air holes (grid of small holes)
  const holesGeo = cachedGeometry('helmet.banded.holesGeo.v2', () => {
    const entries = [];
    for (let row = 0; row < 3; row++) {
      const y = HEAD_Y - 0.06 - row * 0.035;
      for (let col = 0; col < 5; col++) {
        const x = (col - 2) * 0.04;
        const z = Math.sqrt(R * R - x * x) - 0.005;
        entries.push({
          geometry: new THREE.CylinderGeometry(0.006, 0.006, 0.02, 4),
          matrix: partMatrix(x, y, z, Math.PI / 2, 0, 0)
        });
      }
    }
    return mergeGeometries(entries);
  });
  group.add(new THREE.Mesh(holesGeo, darkMat));

  return group;
}

// Crested helm. Dome + rim + a fin crest running front-to-back along the
// top, approximated with three angled boxes: a tall central fin, a
// forward-sloping piece that meets the front of the dome, and a back-
// sloping piece that meets the rear. The three-piece approximation is
// indistinguishable from a real swept fin at battle zoom and costs a
// fraction of the vertices a lathe or extrude would.
//
// The central fin sits at HEAD_Y + 0.17 with height 0.10 — its crown is
// at ~Y +0.22, well above the dome top (~Y +0.14), so the fin
// silhouettes clearly against the sky. The two end pieces are shorter
// and tilted to meet the dome shoulder so the crest has no visible
// floating end.
function buildCrestedHelm(bodyColor) {
  const group = new THREE.Group();
  const geo = cachedGeometry('helmet.crested.geo.v2', () =>
    mergeGeometries([
      { geometry: domePiece(), matrix: partMatrix(0, HEAD_Y - 0.005, 0) },
      rimPiece(),
      // Central fin.
      {
        geometry: new THREE.BoxGeometry(0.022, 0.100, 0.140),
        matrix: partMatrix(0, HEAD_Y + 0.170, 0)
      },
      // Front sloping piece: +Z, top leans back (-X rotation).
      {
        geometry: new THREE.BoxGeometry(0.022, 0.060, 0.060),
        matrix: partMatrix(0, HEAD_Y + 0.150, 0.110, -0.30, 0, 0)
      },
      // Back sloping piece: -Z, top leans forward (+X rotation).
      {
        geometry: new THREE.BoxGeometry(0.022, 0.060, 0.060),
        matrix: partMatrix(0, HEAD_Y + 0.150, -0.110, 0.30, 0, 0)
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