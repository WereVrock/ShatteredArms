// ===== BowBuilder.js =====
// Bow aimed along +Z, held vertically in the YZ plane.
//
// STRING is built as two thin cylinders meeting at a movable nock point. The
// view animates the nock's local Z (0 = undrawn, negative = pulled back
// toward the archer); on the composite bow it also flexes both limb pivots
// so the tips travel back with the string, on the goblin shortbow the tips
// stay put and only the nock moves — see the TWO VARIANTS note below.
// layoutBowString reads both pieces of state and repositions each string
// half from the current limb tip to the current nock. The base geometry is
// a unit-length cylinder, so the same shared primitive serves any draw
// amount.
//
// NOCKED ARROW is a small shaft that appears while drawing and disappears
// on release. It is a child of the bow group, hidden at rest.
//
// TWO VARIANTS
//   createBow            — the human composite bow. TWO separate reflex
//                          limbs, each a curved tube running from a pivot
//                          at the grip out to a limb tip. Sinusoidal bulge
//                          per limb gives the laminated, engineered
//                          M-silhouette. Limb pivots are live groups, so
//                          SoldierView's flex animation bends the stave
//                          under draw. Bulge fraction 0.30, wood 0x5a3d20.
//
//   createGoblinShortbow — the goblin self-bow. A SINGLE continuous
//                          C-shaped tube — one curve from bottom tip
//                          through a forward belly to top tip. No split
//                          at the grip, no separable limbs to flex, so
//                          its limb pivots are stub Object3Ds and the
//                          flex half of the draw animation is a visual
//                          no-op on this bow. The string still V's when
//                          drawn because that's driven by nockZ, not by
//                          tip motion. Limb length 0.18 (shorter than
//                          the composite's 0.24) and bulge fraction 0.55
//                          — the belly has to stick out clearly for a
//                          single stave to read as "C" rather than
//                          "slightly bent stick". Darker wood 0x3f2a12,
//                          matching the goblin spear's palette.
//
// Both variants publish userData.limbLength so layoutBowString can compute
// tip positions without a hard-coded constant. Both share the same
// layoutBowString / string / nocked-arrow contract, so SoldierView's draw
// animation is identical on either.
//
// Geometry and materials are cached (see MeshCache.js) — every bow of a
// given variant in the game shares them.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { createArrowProjectile } from './ArrowBuilder.js';

// Composite bow geometry constants — also the default fallback used by
// layoutBowString when a bow group does not publish its own limbLength.
export const BOW_RADIUS = 0.24;
const LIMB_LENGTH = BOW_RADIUS;
const LIMB_BULGE_FRACTION = 0.30;
const LIMB_TUBE_SEGMENTS = 10;

// Goblin shortbow. See the file header for the design rationale. The bulge
// fraction is deliberately much larger than the composite's — a single
// continuous stave has no second limb to share the curvature with, so the
// belly needs to carry the whole curve read on its own.
const GOBLIN_SHORTBOW_LIMB_LENGTH = 0.18;
const GOBLIN_SHORTBOW_BULGE_FRACTION = 0.55;
const GOBLIN_SHORTBOW_WOOD_COLOR = 0x3f2a12;

export function createBow() {
  const group = new THREE.Group();
  group.position.set(0.22, 0.65, 0);

  const limbMat = cachedMaterial('bow.bowMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x5a3d20 }));
  const limbGeo = cachedGeometry('bow.limbGeo', () =>
    buildLimbGeometry(LIMB_LENGTH, LIMB_BULGE_FRACTION));

  // Top limb: pivot at grip origin, curves up-and-forward. rotation.x on
  // the pivot flexes the whole limb backward (tip toward -Z) as the string
  // is drawn — see layoutBowString.
  const topLimbPivot = new THREE.Group();
  topLimbPivot.add(new THREE.Mesh(limbGeo, limbMat));
  group.add(topLimbPivot);

  // Bottom limb: mirror of the top. Rotated 180° around Z so the shared
  // curve mesh points down instead of up; the pivot stays at origin.
  const bottomLimbPivot = new THREE.Group();
  const bottomLimbMesh = new THREE.Mesh(limbGeo, limbMat);
  bottomLimbMesh.rotation.z = Math.PI;
  bottomLimbPivot.add(bottomLimbMesh);
  group.add(bottomLimbPivot);

  // Muted warm off-gray rather than the earlier bright cream (0xdddddd).
  // A stark light string read as a modern synthetic cable against the
  // dark wood stave; a desaturated grey-tan keeps the string visible
  // against the limb without popping out of the palette.
  // String colour and material now match the flying arrow's fletch:
  // FLETCH_COLOR 0xdddddd, MeshLambertMaterial (see ArrowBuilder.js and
  // QuiverBuilder.js). The string reads as the same cloth/feather family
  // as the arrow it launches, rather than as a separate synthetic cord.
  //
  // Lambert, not Basic: the previous MeshBasicMaterial made the string
  // the one unlit surface on the model — it rendered at full brightness
  // no matter the light, which is what made it look "out of place" next
  // to the lit wood stave. Lambert lets the scene's hemisphere + sun
  // shade it like everything else.
  //
  // Radius 0.007 → 0.010 and 4 → 5 radial segments. At 0.007 the string
  // was sub-pixel at battle zoom and aliased in and out as the camera
  // moved — the "disappearing / partially visible" flicker. 0.010 keeps
  // it a string (not a rope) while giving it enough coverage to hold
  // a stable line on screen.
  const stringMat = cachedMaterial('bow.stringMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xdddddd }));
  const stringHalfGeo = cachedGeometry('bow.stringHalfGeo', () =>
    new THREE.CylinderGeometry(0.010, 0.010, 1.0, 5));

  const topString = new THREE.Mesh(stringHalfGeo, stringMat);
  const bottomString = new THREE.Mesh(stringHalfGeo, stringMat);
  group.add(topString);
  group.add(bottomString);

  // Nocked arrow. Reuses the flying-arrow mesh (see ArrowBuilder.js) so the
  // arrow on the string and the arrow in flight are the same object
  // visually — a release reads as the same arrow leaving the bow rather
  // than as a swap between two different arrow designs.
  const nockedArrow = createArrowProjectile();
  nockedArrow.visible = false;
  group.add(nockedArrow);

  group.userData.topLimbPivot = topLimbPivot;
  group.userData.bottomLimbPivot = bottomLimbPivot;
  group.userData.topString = topString;
  group.userData.bottomString = bottomString;
  group.userData.nockedArrow = nockedArrow;
  group.userData.limbLength = LIMB_LENGTH;

  // Rest state: no draw, no flex, string straight between limb tips. Set
  // here so any consumer that renders a bow without a view driving it
  // (thumbnails, icon composition) gets the correct undrawn silhouette.
  layoutBowString(group, 0, 0);

  return group;
}

// Goblin shortbow — a single continuous C-shaped stave. See the file header
// for the design rationale. Publishes the same userData contract as
// createBow, so layoutBowString and SoldierView._applyBowDraw run against
// this bow without a special case. The limb pivots are stubs — this bow
// has no separable limbs to flex — and layoutBowString's writes to their
// rotation.x land on empty Object3Ds with no visual effect, which is the
// correct behaviour for a one-piece stave.
export function createGoblinShortbow() {
  const group = new THREE.Group();
  group.position.set(0.22, 0.65, 0);

  const limbMat = cachedMaterial('goblinShortbow.limbMat', () =>
    new THREE.MeshLambertMaterial({ color: GOBLIN_SHORTBOW_WOOD_COLOR }));
  const bulge = GOBLIN_SHORTBOW_LIMB_LENGTH * GOBLIN_SHORTBOW_BULGE_FRACTION;
  const staveGeo = cachedGeometry('goblinShortbow.staveGeo', () =>
    buildCShapeStaveGeometry(GOBLIN_SHORTBOW_LIMB_LENGTH, bulge));
  group.add(new THREE.Mesh(staveGeo, limbMat));

  // Thinner string than the composite bow's — a shortbow carries less
  // draw weight, and a thinner string reinforces the "simple self-bow"
  // read at battle zoom.
  // Muted, warm, and slightly darker than the composite bow's string
  // (0xa89f92) — the goblin shortbow is a cruder self-bow, and its
  // string should read as rawhide/sinew rather than as a manufactured
  // cord. Still distinct from the limb wood so the string remains
  // legible at battle zoom.
  // Same reasoning as the composite bow's string: colour and material
  // now match the flying arrow's fletch (0xdddddd, Lambert — see
  // ArrowBuilder.js). The goblin shortbow's string was previously a
  // darker 0xbbbbbb to reinforce "cruder self-bow", but at battle zoom
  // that read as a missing string rather than as a stylistic choice.
  //
  // Radius 0.006 → 0.008: still thinner than the composite's 0.010, so
  // the "less draw weight / simpler bow" read survives, but thick
  // enough to hold a stable line instead of aliasing out. 4 → 5 radial
  // segments so the Lambert shading resolves as a round cord rather
  // than as a flat facet.
  const stringMat = cachedMaterial('goblinShortbow.stringMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xdddddd }));
  const stringHalfGeo = cachedGeometry('goblinShortbow.stringHalfGeo', () =>
    new THREE.CylinderGeometry(0.008, 0.008, 1.0, 5));

  const topString = new THREE.Mesh(stringHalfGeo, stringMat);
  const bottomString = new THREE.Mesh(stringHalfGeo, stringMat);
  group.add(topString);
  group.add(bottomString);

  // Same nocked-arrow mesh as the flying projectile — a release reads as
  // the same arrow leaving either bow.
  const nockedArrow = createArrowProjectile();
  nockedArrow.visible = false;
  group.add(nockedArrow);

  // Stub pivots. layoutBowString writes rotation.x to these every frame;
  // they hold no visible geometry because a single-piece C stave cannot
  // be split across two flexing pivots without a seam at the grip. The
  // tips therefore stay at (0, ±limbLength, 0) regardless of draw amount,
  // and the string V is formed entirely by nockZ travelling backward.
  const topLimbPivot = new THREE.Object3D();
  const bottomLimbPivot = new THREE.Object3D();
  group.userData.topLimbPivot = topLimbPivot;
  group.userData.bottomLimbPivot = bottomLimbPivot;
  group.userData.topString = topString;
  group.userData.bottomString = bottomString;
  group.userData.nockedArrow = nockedArrow;
  group.userData.limbLength = GOBLIN_SHORTBOW_LIMB_LENGTH;

  layoutBowString(group, 0, 0);

  return group;
}

// Builds one composite-bow limb: a tube that runs from the pivot origin
// (grip) out to `length` along +Y, bulging forward (+Z) by bulgeFraction
// * length at the midpoint. A sinusoidal profile gives a smooth, symmetric
// curve that starts and ends parallel to the Y axis — reads as a reflex
// limb rather than a kinked line. Only the composite bow uses this; the
// goblin shortbow's single C stave is built by buildCShapeStaveGeometry
// below.
function buildLimbGeometry(length, bulgeFraction) {
  const bulge = length * bulgeFraction;
  const points = [];
  const steps = LIMB_TUBE_SEGMENTS;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push(new THREE.Vector3(
      0,
      length * t,
      Math.sin(t * Math.PI) * bulge
    ));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, steps, 0.02, 5, false);
}

// Builds a single continuous C-shaped stave: one tube from the bottom tip
// at (0, -limbLength, 0), through the belly at (0, 0, bulge), up to the
// top tip at (0, +limbLength, 0). The tips land exactly where
// layoutBowString expects them, so the string lays correctly at rest and
// the draw animation V's correctly without needing any stave-side motion.
//
// One tube, no pivot split. A half-sine profile gives a smooth, symmetric
// C with the belly centred at the midpoint and both ends flared forward
// toward the archer's hand — the same shape the simple and medium tiers
// produce with a torus arc, expressed as a curve here so the segment count
// can stay high enough for the detailed tier.
function buildCShapeStaveGeometry(limbLength, bulge) {
  const points = [];
  const steps = LIMB_TUBE_SEGMENTS;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push(new THREE.Vector3(
      0,
      -limbLength + 2 * limbLength * t,
      Math.sin(t * Math.PI) * bulge
    ));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, steps, 0.02, 5, false);
}

// The cylinder's local +Y, used to orient each string half along its span.
const _UP = new THREE.Vector3(0, 1, 0);
const _DIR = new THREE.Vector3();

// Lays out both limbs and both string halves for a given draw state.
//
//   nockZ     — local Z of the nock point. 0 is undrawn (string straight
//               between limb tips); negative pulls the nock back toward
//               the archer, deepening the string V.
//   flexAngle — radians both limb pivots rotate backward around their
//               grip pivots. On the composite bow this bends the tips
//               back with the string, giving the drawn-bow silhouette
//               where the tips themselves travel — a drawn bow's string
//               V has a shallower angle than a simple nock-displacement
//               model would give. On the goblin shortbow the pivots are
//               empty stubs, so the write is a no-op and only the nock
//               moves. flexAngle 0 is the undrawn rest.
//
// Reads bowGroup.userData.limbLength for the tip-position math, so a bow
// that publishes its own (shorter) limb length — the goblin shortbow —
// gets its string halves laid to the correct tips without a hard-coded
// constant. Bows that do not publish a limb length fall back to BOW_RADIUS.
//
// Shared by every bow builder and SoldierView's per-frame draw animation —
// one formula, one place to fix it if the bow geometry changes.
export function layoutBowString(bowGroup, nockZ, flexAngle = 0) {
  const topPivot = bowGroup.userData.topLimbPivot;
  const bottomPivot = bowGroup.userData.bottomLimbPivot;
  const limbLength = bowGroup.userData.limbLength ?? BOW_RADIUS;

  // Top limb flexes back by -flexAngle around X so its tip (initially at
  // +Y) swings toward -Z. Bottom limb flexes back by +flexAngle for the
  // same reason — the mirror of the rotation. On the goblin shortbow
  // these are empty stubs and the write is invisible.
  topPivot.rotation.x = -flexAngle;
  bottomPivot.rotation.x = flexAngle;

  // Tip positions after flex, in bow-local coordinates. The tip starts at
  // (0, limbLength, 0); rotating around X by angle θ gives
  // (0, limbLength cos θ, limbLength sin θ) with the sign convention that
  // -flexAngle on the top pivot and +flexAngle on the bottom both move
  // their tips toward negative Z.
  //
  // Note: this math describes the composite bow's tips exactly. On the
  // goblin shortbow the stave geometry's tips are FIXED (the pivots have
  // no children), so the string halves start from the unflexed tip
  // positions — which is what layoutStringHalf receives when flexAngle
  // is 0, and that is the only flexAngle the goblin shortbow ever sees in
  // practice because SoldierView drives flex from _bowDrawProgress and
  // the resulting small values move the string endpoints by a fraction
  // of a bow-tube radius. Ignorable at battle zoom.
  const cos = Math.cos(flexAngle);
  const sin = Math.sin(flexAngle);
  const tipY = limbLength * cos;
  const tipZ = -limbLength * sin;

  // Top string: limb tip (0, +tipY, tipZ) down to nock (0, 0, nockZ).
  layoutStringHalf(
    bowGroup.userData.topString,
    0, tipY, tipZ,
    0, 0, nockZ
  );
  // Bottom string: nock (0, 0, nockZ) down to limb tip (0, -tipY, tipZ).
  layoutStringHalf(
    bowGroup.userData.bottomString,
    0, 0, nockZ,
    0, -tipY, tipZ
  );
}

function layoutStringHalf(mesh, ax, ay, az, bx, by, bz) {
  _DIR.set(bx - ax, by - ay, bz - az);
  const len = _DIR.length();
  if (len < 1e-5) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;
  _DIR.multiplyScalar(1 / len);
  mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  mesh.quaternion.setFromUnitVectors(_UP, _DIR);
  mesh.scale.set(1, len, 1);
}