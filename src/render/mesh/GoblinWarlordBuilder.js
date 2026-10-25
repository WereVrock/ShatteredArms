// ===== src/render/mesh/GoblinWarlordBuilder.js =====
// Goblin Warlord body: a goblin-frame body with structured metal armor
// and a hooded cowl. Distinct from the common goblin (armored, hooded,
// bigger) and from the hobgoblin (goblin slouch and ears, not the
// disciplined hobgoblin posture).
//
// USAGE
// The Goblin Warlord is a UNIQUE CHARACTER, not a rank-and-file type.
// The unit type that carries it declares championBodyVariant:
// 'goblinWarlord' (see UnitTypes.goblinWarlordRetinue). Soldier.setChampion
// re-resolves the body variant for the flagged soldier; the rest of the
// unit keeps its normal body. See Soldier._resolveBodyVariant.
//
// POSTURE
// More upright than a common goblin — slouch 0.22 rad, between the
// goblin's 0.40 and the hobgoblin's 0.16. Reads as a goblin who has
// learned to stand like a soldier, not a hobgoblin who was born to.
//
// SIZE
// A tall goblin — clearly taller than a common goblin, clearly shorter
// than a hobgoblin. Sits between the two in the goblinoid height
// hierarchy without reading as a hobgoblin in different armor: the
// deeper slouch and the smaller head are what keep the goblin identity
// intact even with the height added. The hood and armor then add a bit
// more on top of the body, so the full silhouette is imposing next to a
// rank of common goblins.
//
// ARMOR + HOOD + CAPE
// See GoblinWarlordArmor.js. A partial-lathe cuirass over the chest,
// pauldrons on the shoulders, a metal belt, a hanging team-coloured
// tabard, a hooded cowl around the head, and a cape hanging from the
// shoulders down the back. Hood and cape share one material and the
// cape's top edge tucks under the hood's rear rim, so the two read as a
// single cowl-and-cape garment. The hood's front rim is deliberately
// above the ear bases so the ears — the goblin's defining silhouette
// cue — emerge from exposed skin rather than clipping through the hood
// shell.
//
// MERGE STRATEGY (see MeshMerge.js)
// Body skin is two meshes: lower torso + head + nose + ears in body
// space, and upper torso in the slouch pivot. Armor adds four more:
// cuirass + pauldrons (in the pivot, one mesh), belt (body space, one
// mesh), tabard (body space, one mesh), and cape (body space, one mesh).
// Plus the hood (body space, one mesh) and four leg meshes. Total ~11
// meshes.
//
// Geometries are cached (see MeshCache.js). The body material is
// per-instance because SoldierView.sync tints it toward black as HP
// drops. The armor materials are cached (see GoblinWarlordArmor) — they
// are shared across every Warlord in the session.
import * as THREE from 'three';
import { cachedGeometry } from './MeshCache.js';
import { mergeGeometries, partMatrix, poseMatrix } from './MeshMerge.js';
import {
  getWarlordMetalMaterial,
  getWarlordHoodMaterial,
  getWarlordCapeMaterial,
  getWarlordTabardMaterial,
  createWarlordCuirass,
  createWarlordBelt,
  createWarlordHood,
  createWarlordCape,
  createWarlordTabard
} from './GoblinWarlordArmor.js';

// --- leg proportions -------------------------------------------------------

// Leg length is set so the feet reach the ground: THIGH + SHIN must equal
// HIP_Y. Shortening the legs alongside the torso keeps the whole figure
// proportioned — a shorter torso on unchanged legs would read as a goblin
// sunk into a pit.
const WARLORD_LEG_HIP_Y       = 0.24;
const WARLORD_LEG_HIP_SPACING = 0.070;
const WARLORD_LEG_RADIUS      = 0.026;
const WARLORD_THIGH_LENGTH    = 0.12;
const WARLORD_SHIN_LENGTH     = 0.12;

// --- torso geometry --------------------------------------------------------
//
// Height hierarchy, measured as head-top Y for reference:
//   common goblin  ≈ 0.83
//   Goblin Warlord ≈ 0.97   (this build)
//   hobgoblin      ≈ 1.15
// The Warlord is deliberately ~60% of the way from the goblin toward the
// hobgoblin, not the midpoint — close enough to the common goblin that the
// race read survives, far enough above it that the character reads as
// bigger than his retinue at a glance.

const WARLORD_PELVIS_HALF_HEIGHT = 0.04;
const WARLORD_TORSO_BOTTOM_Y = WARLORD_LEG_HIP_Y - WARLORD_PELVIS_HALF_HEIGHT;  // 0.20

const WARLORD_WAIST_Y     = 0.46;
const WARLORD_LOWER_TOP_Y = 0.48;
const WARLORD_TORSO_TOP_Y = 0.77;

// Between the goblin's 0.40 and the hobgoblin's 0.16. Deeper than the
// hobgoblin because this is still a goblin — the slouch is part of the
// race read, and straightening it out entirely would start to look like
// a hobgoblin in different armor.
const WARLORD_SLOUCH_RAD = 0.24;

const WARLORD_UPPER_HEIGHT = WARLORD_TORSO_TOP_Y - WARLORD_WAIST_Y;  // 0.31
const WARLORD_TOP_Y = WARLORD_WAIST_Y + WARLORD_UPPER_HEIGHT * Math.cos(WARLORD_SLOUCH_RAD);
const WARLORD_TOP_Z = WARLORD_UPPER_HEIGHT * Math.sin(WARLORD_SLOUCH_RAD);

// --- head ------------------------------------------------------------------

const WARLORD_HEAD_RADIUS = 0.135;
const WARLORD_HEAD_FORWARD_EXTRA = 0.025;
const WARLORD_HEAD_Y = WARLORD_TOP_Y + WARLORD_HEAD_RADIUS * 0.60;
const WARLORD_HEAD_Z = WARLORD_TOP_Z + WARLORD_HEAD_FORWARD_EXTRA;

// --- ears ------------------------------------------------------------------

// Ear base sits WELL BELOW the head's equator so the ear emerges from
// exposed skin under the hood's rim (see GoblinWarlordArmor.createWarlordHood
// for the rim height). Same fix as the hobgoblin helmet — a base at the
// equator would intersect the hood shell.
const WARLORD_EAR_LENGTH = 0.15;
const WARLORD_EAR_BASE_X = 0.11;
const WARLORD_EAR_BASE_Y = -0.075;   // relative to head center
const WARLORD_EAR_BASE_Z = -0.010;   // relative to head center
function warlordEarDirection(side) {
  return new THREE.Vector3(side * 0.55, -0.35, -0.76).normalize();
}

// --- skin tint -------------------------------------------------------------

// Slightly deeper / more olive than the common goblin's bright green
// (0x6a8a3a), so a warlord reads as weathered and distinct at silhouette
// distance even before the hood and armor register.
const WARLORD_SKIN = 0x5a6a32;
const WARLORD_TINT = 0.55;

// --- lathe profiles --------------------------------------------------------

const WARLORD_TORSO_RADIAL_SEGMENTS = 10;

const WARLORD_LOWER_PROFILE = [
  new THREE.Vector2(0.000, WARLORD_TORSO_BOTTOM_Y),
  new THREE.Vector2(0.115, WARLORD_TORSO_BOTTOM_Y),
  new THREE.Vector2(0.125, WARLORD_TORSO_BOTTOM_Y + 0.10),
  new THREE.Vector2(0.118, WARLORD_TORSO_BOTTOM_Y + 0.20),
  new THREE.Vector2(0.105, WARLORD_LOWER_TOP_Y),
  new THREE.Vector2(0.000, WARLORD_LOWER_TOP_Y)
];

const WARLORD_UPPER_PROFILE = [
  new THREE.Vector2(0.000, 0),
  new THREE.Vector2(0.115, 0),
  new THREE.Vector2(0.120, WARLORD_UPPER_HEIGHT * 0.25),
  new THREE.Vector2(0.112, WARLORD_UPPER_HEIGHT * 0.55),
  new THREE.Vector2(0.095, WARLORD_UPPER_HEIGHT * 0.85),
  new THREE.Vector2(0.070, WARLORD_UPPER_HEIGHT),
  new THREE.Vector2(0.000, WARLORD_UPPER_HEIGHT)
];

// --- armor layout ----------------------------------------------------------

const WARLORD_BELT_Y = WARLORD_WAIST_Y;
const WARLORD_BELT_RADIUS = 0.120;
const WARLORD_TABARD_LENGTH = 0.16;
const WARLORD_TABARD_FLARE = 1.35;

const WARLORD_CUIRASS_Y_FROM = 0.05;
const WARLORD_CUIRASS_Y_TO   = 0.29;
const WARLORD_CUIRASS_PAD    = 0.020;

const WARLORD_PAULDRON_Y = 0.25;
const WARLORD_PAULDRON_X = 0.100;
const WARLORD_PAULDRON_RADIUS = 0.080;

// Cape. The top Y is raised so the cape's rear shell passes just outside
// and below the hood's rear rim (see GoblinWarlordArmor.createWarlordHood;
// the rim lands at roughly world Y 0.767 after the tilt). The two pieces
// therefore overlap in a short band at the nape, and the cape's own edge
// hides the seam between them — hood and cape read as one garment.
//
// The bottom Y stops at hip height so the legs do not swing through it
// during the walk cycle (see createWarlordCape for the geometry
// rationale). Radii are sized against the shoulder line — top clears the
// pauldrons, bottom flares for a draped silhouette.
const WARLORD_CAPE_TOP_Y       = 0.79;
const WARLORD_CAPE_BOTTOM_Y    = 0.22;
const WARLORD_CAPE_TOP_RADIUS  = 0.115;
const WARLORD_CAPE_BOTTOM_RADIUS = 0.185;

// --- builder ---------------------------------------------------------------

export function createGoblinWarlordBody(teamColor) {
  const group = new THREE.Group();

  // Per-instance: SoldierView tints this toward black as HP drops.
  const skinColor = new THREE.Color(teamColor).lerp(
    new THREE.Color(WARLORD_SKIN), WARLORD_TINT
  );
  const skinMat = new THREE.MeshLambertMaterial({ color: skinColor });
  const metalMat = getWarlordMetalMaterial();
  // Hood and cape have separate textured materials, but both bake the
  // same base cloth and heraldic palette, so the two still read as one
  // continuous garment. The seam at the nape is hidden by the cape's
  // own top edge tucking just under the hood's rear rim.
  const hoodMat = getWarlordHoodMaterial(teamColor);
  const capeMat = getWarlordCapeMaterial(teamColor);
  const tabardMat = getWarlordTabardMaterial(teamColor);

  // Body-space skin: lower torso + head + nose + two ears.
  addBodySkin(group, skinMat);

  // Body-space metal: belt.
  group.add(createWarlordBelt(metalMat, {
    beltY: WARLORD_BELT_Y,
    beltRadius: WARLORD_BELT_RADIUS,
    cachePrefix: 'goblinWarlord'
  }));

  // Hood. Its heraldry — the war-crown, the two wings, and the flourish
  // — is baked into hoodMat's map, so this is one mesh, one draw call.
  group.add(createWarlordHood(hoodMat, {
    headY: WARLORD_HEAD_Y,
    headRadius: WARLORD_HEAD_RADIUS,
    headZ: WARLORD_HEAD_Z,
    cachePrefix: 'goblinWarlord'
  }));

  // Cape. Its heraldry — the two hem bands, the vertical centre stripe,
  // and the two flanking war-crown sigils — is baked into capeMat's map,
  // so this is one mesh, one draw call.
  group.add(createWarlordCape(capeMat, {
    topY: WARLORD_CAPE_TOP_Y,
    bottomY: WARLORD_CAPE_BOTTOM_Y,
    topRadius: WARLORD_CAPE_TOP_RADIUS,
    bottomRadius: WARLORD_CAPE_BOTTOM_RADIUS,
    cachePrefix: 'goblinWarlord'
  }));

  group.add(createWarlordTabard(tabardMat, {
    beltY: WARLORD_BELT_Y,
    beltRadius: WARLORD_BELT_RADIUS,
    length: WARLORD_TABARD_LENGTH,
    flare: WARLORD_TABARD_FLARE,
    cachePrefix: 'goblinWarlord'
  }));

  // Upper torso + cuirass + pauldrons inside the slouch pivot.
  addUpperTorsoAndArmor(group, skinMat, metalMat);

  addWarlordLegs(group, skinMat);

  group.userData.baseMaterial = skinMat;
  return group;
}

// --- lower torso + head + nose + ears (body-space skin mesh) ---------------

function addBodySkin(group, mat) {
  const geo = cachedGeometry('goblinWarlord.bodySkinGeo', () => {
    const entries = [
      {
        geometry: new THREE.LatheGeometry(
          WARLORD_LOWER_PROFILE, WARLORD_TORSO_RADIAL_SEGMENTS
        )
      }
    ];

    // Head: sphere, squashed slightly on Y.
    {
      const headGeo = new THREE.SphereGeometry(WARLORD_HEAD_RADIUS, 10, 8);
      headGeo.scale(1, 0.92, 1);
      entries.push({
        geometry: headGeo,
        matrix: partMatrix(0, WARLORD_HEAD_Y, WARLORD_HEAD_Z)
      });
    }

    // Nose — shorter and blunter than a common goblin's exaggerated snout.
    entries.push({
      geometry: new THREE.ConeGeometry(0.038, 0.16, 6),
      matrix: partMatrix(
        0,
        WARLORD_HEAD_Y - 0.020,
        WARLORD_HEAD_Z + WARLORD_HEAD_RADIUS - 0.020,
        Math.PI / 2 + 0.35, 0, 0
      )
    });

    // No ears on the Warlord. The hood covers the entire head — crown,
    // forehead, sides, and back — so there is no exposed skin for ears
    // to sit on. Adding them would only produce cones sprouting through
    // the cloth shell, which reads as a clipping bug rather than as a
    // character detail.
    return mergeGeometries(entries);
  });

  group.add(new THREE.Mesh(geo, mat));
}

// --- upper torso + cuirass + pauldrons (slouch-pivot-local) ----------------

function addUpperTorsoAndArmor(group, skinMat, metalMat) {
  const pivot = new THREE.Group();
  pivot.position.set(0, WARLORD_WAIST_Y, 0);
  pivot.rotation.x = WARLORD_SLOUCH_RAD;

  const skinGeo = cachedGeometry('goblinWarlord.upperSkinGeo', () =>
    new THREE.LatheGeometry(
      WARLORD_UPPER_PROFILE, WARLORD_TORSO_RADIAL_SEGMENTS
    ));
  pivot.add(new THREE.Mesh(skinGeo, skinMat));

  const armorMesh = createWarlordCuirass(metalMat, {
    profile: WARLORD_UPPER_PROFILE,
    pad: WARLORD_CUIRASS_PAD,
    yFrom: WARLORD_CUIRASS_Y_FROM,
    yTo: WARLORD_CUIRASS_Y_TO,
    pauldronY: WARLORD_PAULDRON_Y,
    pauldronX: WARLORD_PAULDRON_X,
    pauldronRadius: WARLORD_PAULDRON_RADIUS,
    cachePrefix: 'goblinWarlord'
  });
  pivot.add(armorMesh);

  group.add(pivot);
}

// --- legs ------------------------------------------------------------------

function addWarlordLegs(group, mat) {
  const thighGeo = cachedGeometry('goblinWarlord.thighGeo', () =>
    new THREE.CylinderGeometry(
      WARLORD_LEG_RADIUS, WARLORD_LEG_RADIUS, WARLORD_THIGH_LENGTH, 5));
  const shinGeo = cachedGeometry('goblinWarlord.shinGeo', () =>
    new THREE.CylinderGeometry(
      WARLORD_LEG_RADIUS, WARLORD_LEG_RADIUS, WARLORD_SHIN_LENGTH, 5));

  const left = buildWarlordLeg(mat, thighGeo, shinGeo, -WARLORD_LEG_HIP_SPACING);
  group.add(left.hip);
  const right = buildWarlordLeg(mat, thighGeo, shinGeo, WARLORD_LEG_HIP_SPACING);
  group.add(right.hip);

  group.userData.legLeftPivot  = left.hip;
  group.userData.legRightPivot = right.hip;
  group.userData.legLeftKnee   = left.knee;
  group.userData.legRightKnee  = right.knee;
}

function buildWarlordLeg(mat, thighGeo, shinGeo, x) {
  const hip = new THREE.Group();
  hip.position.set(x, WARLORD_LEG_HIP_Y, 0);

  const thigh = new THREE.Mesh(thighGeo, mat);
  thigh.position.y = -WARLORD_THIGH_LENGTH / 2;
  thigh.userData.noShadow = true;
  hip.add(thigh);

  const knee = new THREE.Group();
  knee.position.y = -WARLORD_THIGH_LENGTH;
  hip.add(knee);

  const shin = new THREE.Mesh(shinGeo, mat);
  shin.position.y = -WARLORD_SHIN_LENGTH / 2;
  shin.userData.noShadow = true;
  knee.add(shin);

  return { hip, knee };
}