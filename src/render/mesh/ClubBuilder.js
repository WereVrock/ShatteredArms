// ===== src/render/mesh/ClubBuilder.js =====
// A crude wooden club for goblin slaves: a tapered haft ending in a
// weighted, slightly elongated head. Reads as a blunt weapon at battle
// zoom — a wooden handle with a chunky tip.
//
// MERGE STRATEGY
// Same as SwordBuilder: haft + head share one vertexColors material (two
// flat colours painted onto the geometry), so the whole weapon is ONE
// mesh — one draw call. A per-part material split would double that for
// no visual gain at any distance the player sees.
//
// SIZE
// Sized to the goblin frame, matching createCrudeSword's proportions so
// the sword-arm anchor system seats it in the same hand and swings it
// through the same animation without a scaling step. Total reach from
// the grip is ~0.48 world units — roughly the crude sword's, slightly
// longer because a club reads better with a bit of reach.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeColoredGeometries, partMatrix, paint } from './MeshMerge.js';

const CLUB_HAFT_COLOR = 0x5a3d20;
const CLUB_HEAD_COLOR = 0x3a2414;

// Lateral offset applied to the merged club geometry. The crude club's
// striking end is a fat bulb where the sword has a thin blade; at the
// same reach as the crude sword the bulb can clip the soldier's skull
// during a swing or a raised-ready pose. Shifting the whole club
// sideways swings the head clear of the head without moving the grip
// point — the hand still holds the club at the same point on the haft.
//
// Applied to the MERGED geometry, not to the mesh — `mesh.position` in
// createClub is overwritten by the composer's sword-arm anchor, but the
// geometry survives untouched. Local +X matches the side the hand
// already sits on (mesh.position.x = 0.22), so the offset reads as
// "further out from the body's centreline" in the render.
//
// If the head still clips the skull during swings, raise this value;
// if the club visibly floats away from the hand, lower it. If it moves
// in the wrong direction relative to the body, negate this — the
// direction of local +X depends on how the composer orients the mesh,
// which lives in SoldierModelComposer, not here.
const CLUB_LATERAL_OFFSET = 0.05;

export function createClub() {
  const geo = cachedGeometry('club.mergedGeo', buildMergedClub);
  const mat = cachedMaterial('club.mergedMat', () =>
    new THREE.MeshLambertMaterial({ vertexColors: true }));
  const mesh = new THREE.Mesh(geo, mat);
  // Anchor matches the standard sword's grip, so every sword-armed
  // soldier — including the slave's club — sits in the same hand.
  // The composer overwrites this with the anchor-derived position;
  // setting it here keeps the mesh self-consistent if ever built
  // standalone (icons, thumbnails).
  mesh.position.set(0.22, 0.65, 0);
  return mesh;
}

function buildMergedClub() {
  const entries = [];

  // Haft: tapered wooden shaft along +Z. Same axis convention every
  // melee weapon builder uses (length runs from the hand at origin
  // toward the tip at +Z). radiusTop (at +Z, head end) is thicker than
  // radiusBottom (at -Z, grip end), so the taper points the mass at
  // the striking end.
  {
    const g = new THREE.CylinderGeometry(0.030, 0.022, 0.40, 6);
    g.rotateX(Math.PI / 2);
    entries.push({
      geometry: paint(g, CLUB_HAFT_COLOR),
      matrix: partMatrix(0, 0, 0.20)
    });
  }

  // Head: bulbous weighted tip. Slightly elongated on Z (1.15) and
  // squashed on Y (0.85) so the profile reads as a knotted end, not a
  // ball. Position sits at the top of the haft with a small overlap so
  // the joint has no gap.
  {
    const g = new THREE.SphereGeometry(0.058, 8, 6);
    g.scale(1, 0.85, 1.15);
    entries.push({
      geometry: paint(g, CLUB_HEAD_COLOR),
      matrix: partMatrix(0, 0, 0.42)
    });
  }

  const merged = mergeColoredGeometries(entries);
  // Shift the whole club sideways so the bulbous head clears the
  // soldier's skull. See CLUB_LATERAL_OFFSET for the rationale and the
  // note on flipping the sign if the direction is wrong for this
  // anchor.
  merged.translate(CLUB_LATERAL_OFFSET, 0, 0);
  return merged;
}