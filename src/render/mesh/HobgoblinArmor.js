// ===== src/render/mesh/HobgoblinArmor.js =====
// Structured metal armor for hobgoblins. Replaces the tattered cloth that
// goblins wear: a cuirass, shoulder pauldrons, a metal belt, a hanging
// cloth skirt, and a metal helmet. Team colour lives on the cloth skirt,
// matching the goblin convention that the cloth carries team identity.
//
// WHY A SEPARATE MODULE
// HobgoblinBodyBuilder owns anatomy: proportions, posture, silhouette.
// Armor is costume and must not know a hobgoblin's leg length. This module
// therefore asks the wearer for measurements only — the waist line, the
// chest profile, the head anchor — and can dress any biped with them.
//
// WHY TWO ENTRY POINTS FOR THE METAL PIECES
// The hobgoblin torso is two lathes: a vertical pelvis and a tilted chest
// (see HobgoblinBodyBuilder). The cuirass and pauldrons belong to the
// tilted chest and are returned in the slouch pivot's LOCAL space. The
// belt and helmet belong to the vertical frame and are returned in body
// space. The caller parents each piece to the right group — this module
// never guesses at the wearer's rig.
//
// MERGE STRATEGY
// Cuirass + pauldrons share the metal material and merge into one mesh in
// the pivot's local frame. Belt + helmet share the metal material and are
// both in body space, so they merge into a second mesh. The cloth skirt is
// a single mesh in body space. Net: three armor meshes per hobgoblin, not
// seven.
//
// Geometries are cached (see MeshCache.js). Materials are cached too — the
// metal is uniform across every hobgoblin, and there are only two team
// colours in the game. This means rebuildModel() does NOT need to dispose
// anything here, matching the shared-resource discipline MeshCache enforces.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix } from './MeshMerge.js';

// --- materials -------------------------------------------------------------

// Dark steel. Flat Lambert; the read at battle zoom is "military kit", not
// metal specularity.
export function getHobgoblinMetalMaterial() {
  return cachedMaterial('hobgoblin.metalMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x50505a }));
}

// Team-coloured cloth for the skirt. Slightly darkened so it reads as dyed
// wool, not as a bright banner. Double-sided because the skirt is an open
// shell.
export function getHobgoblinClothMaterial(teamColor) {
  return cachedMaterial(`hobgoblin.clothMat.${teamColor}`, () =>
    new THREE.MeshLambertMaterial({
      color: new THREE.Color(teamColor).multiplyScalar(0.82),
      side: THREE.DoubleSide
    }));
}

// --- torso armor (pivot-local space) ---------------------------------------

// Cuirass + pauldrons, merged into one mesh in the slouch pivot's local
// frame. The cuirass is a partial lathe that follows the wearer's own
// chest profile, so it hugs a tapering torso exactly. phiStart/phiLength
// leave the back open — the skin shows through, which reads as
// armor-over-cloth rather than a solid metal barrel.
//
// profile is the wearer's UPPER profile (pivot-local), the same array the
// body lathe is built from. yFrom/yTo are pivot-local heights.
//
// Pauldrons sit on the shoulders at the top of the profile, one per side.
// Each is a squashed hemisphere tilted outward so it reads as a pad, not a
// ball.
export function createHobgoblinTorsoArmor(metalMat, {
  profile, pad, yFrom, yTo,
  pauldronY, pauldronX, pauldronRadius,
  cachePrefix
}) {
  const geo = cachedGeometry(`${cachePrefix}.torsoArmorGeo`, () => {
    const entries = [];

    const slice = offsetProfileSlice(profile, yFrom, yTo, pad);
    if (slice.length >= 2) {
      entries.push({
        geometry: new THREE.LatheGeometry(
          slice, 10,
          -Math.PI * 0.75, Math.PI * 1.5
        )
      });
    }

    for (const side of [-1, 1]) {
      entries.push({
        geometry: new THREE.SphereGeometry(
          pauldronRadius, 8, 5,
          0, Math.PI * 2, 0, Math.PI * 0.55
        ),
        matrix: partMatrix(side * pauldronX, pauldronY, 0, 0, 0, side * -0.45)
      });
    }

    return mergeGeometries(entries);
  });
  return new THREE.Mesh(geo, metalMat);
}

// --- body-space armor (belt + helmet) --------------------------------------

// Metal belt and helmet, merged into one mesh in body space. Both share the
// metal material and neither rotates with the chest pivot, so they can be
// merged without a transform seam.
//
// headY / headRadius / headZ describe the head anchor; the helmet seats a
// hemisphere cap on the head with a brow ridge above the eyes. Ears are
// left exposed — the cheek flare stops short of them.
//
// NO NASAL GUARD. The hobgoblin has a prominent nose that reaches well
// below the helmet dome; a nasal guard plate along the face would
// intersect it. The brow ridge is the only facial trim, and it sits
// above the eyes with clearance.
export function createHobgoblinBodyArmor(metalMat, {
  beltY, beltRadius,
  headY, headRadius, headZ,
  cachePrefix
}) {
  const geo = cachedGeometry(`${cachePrefix}.bodyArmorGeo`, () =>
    mergeGeometries([
      // Belt: a solid ring at the waist, slightly proud of the torso.
      {
        geometry: new THREE.CylinderGeometry(
          beltRadius, beltRadius, 0.06, 10, 1, true
        ),
        matrix: partMatrix(0, beltY, 0)
      },
      // Helmet dome, seated on the head.
      {
        geometry: new THREE.SphereGeometry(
          headRadius + 0.022, 10, 6,
          0, Math.PI * 2, 0, Math.PI / 2
        ),
        matrix: partMatrix(0, headY, headZ)
      },
      // Brow ridge: a thin band above the eyes.
      {
        geometry: new THREE.BoxGeometry(0.200, 0.026, 0.040),
        matrix: partMatrix(0, headY + 0.035, headZ + headRadius * 0.85)
      }
    ]));
  return new THREE.Mesh(geo, metalMat);
}

// --- cloth skirt (team-colour carry) ---------------------------------------

// Team-coloured cloth skirt hanging from the belt. A short tapered open
// cylinder — shorter and cleaner than the goblin loincloth, so it reads as
// a uniform tunic rather than as rags. Front-and-back coverage only:
// phiStart/phiLength leave the sides open so the legs swing free.
export function createHobgoblinSkirt(clothMat, {
  beltY, beltRadius, length, flare, cachePrefix
}) {
  const geo = cachedGeometry(`${cachePrefix}.skirtGeo`, () =>
    new THREE.CylinderGeometry(
      beltRadius * 1.02, beltRadius * flare,
      length, 10, 1, true,
      -Math.PI * 0.65, Math.PI * 1.3
    ));
  const mesh = new THREE.Mesh(geo, clothMat);
  mesh.position.y = beltY - length / 2 - 0.02;
  return mesh;
}

// --- profile helpers -------------------------------------------------------

// Radius of a lathe profile at an arbitrary height, by linear interpolation
// between the two vertices that bracket it. Returns 0 outside the profile.
function profileRadiusAt(profile, y) {
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (b.y < y || a.y > y) continue;
    const dy = b.y - a.y;
    if (dy <= 0) continue;
    return a.x + (b.x - a.x) * ((y - a.y) / dy);
  }
  return 0;
}

// Slice the profile between two heights and push every point outward by
// `pad`. The endpoints are interpolated so the drape's top and bottom edges
// land exactly where the caller asked. Zero-radius vertices (the profile's
// closed caps) are dropped.
function offsetProfileSlice(profile, yFrom, yTo, pad) {
  const slice = [new THREE.Vector2(profileRadiusAt(profile, yFrom) + pad, yFrom)];
  for (const point of profile) {
    if (point.y > yFrom && point.y < yTo && point.x > 0) {
      slice.push(new THREE.Vector2(point.x + pad, point.y));
    }
  }
  slice.push(new THREE.Vector2(profileRadiusAt(profile, yTo) + pad, yTo));
  return slice;
}