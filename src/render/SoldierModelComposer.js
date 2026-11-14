// ===== SoldierModelComposer.js =====
// Builds the visible, stateless parts of one soldier model: body (with the
// helmet baked in by SoldierMeshFactory), mount if cavalry, shield if the
// unit type carries one, and weapon. No per-soldier wiring — no selection
// ring, no routing flag, no click proxy, no unit-id tag. Those belong to
// SoldierView, which owns the live instance.
//
// Extracted so that UnitThumbnailCapture can build the exact same model
// shape for its one-off render without duplicating the composition order.
//
// WALK-POSE LEGS
// Foot soldiers do not use the LegBuilder pivots at runtime. Instead,
// attachStaticLegs bakes the two legs at WALK_POSE_COUNT evenly-spaced
// walk-cycle phases into WALK_POSE_COUNT merged geometries (thigh L + shin
// L + thigh R + shin R, all at body-local pose), and attaches a single
// mesh that carries the current pose's geometry. SoldierView swaps the
// mesh's geometry reference each frame based on the walk phase — one
// reference assignment, no scene-graph mutation, no per-pivot rotation.
//
// This is what lets an IDLE soldier and a WALKING soldier both draw
// exactly one leg mesh. The previous animated-pivot approach required
// four meshes per walking soldier, and the walk cycle's amplitude decay
// could not fire while paused (the sync path's dirty check short-circuited
// before the transition could complete), so paused soldiers kept the
// four-mesh representation forever.
//
// The pose geometries are cached per body variant — every soldier of the
// same variant at the same phase shares one GPU buffer. The per-instance
// material (HP tint) is unchanged: the pose mesh uses the body's own
// baseMaterial, exactly as the merged static-legs mesh did.
import * as THREE from 'three';
import { SoldierMeshFactory } from './SoldierMeshFactory.js';
import { WeaponViewFactory } from './WeaponViewFactory.js';
import { ShieldViewFactory } from './ShieldViewFactory.js';
import { getTeamColor } from './TeamColors.js';
import { isCavalry, isMounted } from '../config/UnitClasses.js';
import { mergeGeometries } from './mesh/MeshMerge.js';
import { cachedGeometry } from './mesh/MeshCache.js';
import { computeKneelPoseParts, KNEEL_POSE_COUNT } from './KneelPose.js';
import { layoutMegabowDeploy } from './mesh/MegabowBuilder.js';

// Walk-cycle constants. MUST match SoldierView.js — the pose geometries
// are baked at these amplitudes and phase offsets, and the view picks a
// pose index from the same signal. If either side drifts, the walk cycle
// snaps instead of interpolating smoothly.
const WALK_POSE_COUNT = 16;
const WALK_LEG_SWING_RAD = 0.55;
const KNEE_BASE_RAD = 0.10;
const KNEE_SWING_RAD = 0.80;

// Run-cycle overrides. Same pose count and phase mapping as walk (so the
// view's pose-index selection is unchanged) — only the baked amplitudes
// differ. A running stride is roughly 1.5x a walking stride in both the
// thigh swing and the knee flex, which is what visually distinguishes
// running from "walking faster" at battle zoom. SoldierView picks between
// the two pose arrays based on soldier.gaitRunning.
const RUN_LEG_SWING_RAD = 0.85;
const RUN_KNEE_SWING_RAD = 1.10;

const SWORD_ARM_ANCHORS = {
  blob:          { shoulderX: 0.15, shoulderY: 0.85, shoulderZ: 0,    handX: 0.22, handY: 0.65, handZ: 0    },
  skeleton:      { shoulderX: 0.15, shoulderY: 0.85, shoulderZ: 0,    handX: 0.22, handY: 0.65, handZ: 0    },
  goblin:        { shoulderX: 0.10, shoulderY: 0.52, shoulderZ: 0.05, handX: 0.14, handY: 0.38, handZ: 0.05 },
  goblinElite:   { shoulderX: 0.10, shoulderY: 0.52, shoulderZ: 0.05, handX: 0.14, handY: 0.38, handZ: 0.05 },
  goblinSlave:   { shoulderX: 0.10, shoulderY: 0.52, shoulderZ: 0.05, handX: 0.14, handY: 0.38, handZ: 0.05 },
  hobgoblin:     { shoulderX: 0.16, shoulderY: 0.72, shoulderZ: 0.02, handX: 0.22, handY: 0.55, handZ: 0.02 },
  goblinWarlord: { shoulderX: 0.13, shoulderY: 0.62, shoulderZ: 0.04, handX: 0.18, handY: 0.47, handZ: 0.04 }
};

const BOW_ARM_ANCHORS = {
  blob:          { shoulderX: 0.15, shoulderY: 0.85, shoulderZ: 0,    handX: 0.20, handY: 0.68, handZ: 0.28 },
  skeleton:      { shoulderX: 0.15, shoulderY: 0.85, shoulderZ: 0,    handX: 0.20, handY: 0.68, handZ: 0.28 },
  goblin:        { shoulderX: 0.10, shoulderY: 0.52, shoulderZ: 0.05, handX: 0.14, handY: 0.42, handZ: 0.22 },
  goblinElite:   { shoulderX: 0.10, shoulderY: 0.52, shoulderZ: 0.05, handX: 0.14, handY: 0.42, handZ: 0.22 },
  goblinSlave:   { shoulderX: 0.10, shoulderY: 0.52, shoulderZ: 0.05, handX: 0.14, handY: 0.42, handZ: 0.22 },
  hobgoblin:     { shoulderX: 0.16, shoulderY: 0.72, shoulderZ: 0.02, handX: 0.20, handY: 0.60, handZ: 0.30 },
  goblinWarlord: { shoulderX: 0.13, shoulderY: 0.62, shoulderZ: 0.04, handX: 0.18, handY: 0.52, handZ: 0.26 }
};

const QUIVER_ANCHORS = {
  blob:          { x: -0.10, y: 0.55, z: -0.16, tiltZ: -0.45 },
  skeleton:      { x: -0.10, y: 0.55, z: -0.16, tiltZ: -0.45 },
  goblin:        { x: -0.07, y: 0.36, z: -0.10, tiltZ: -0.45 },
  goblinElite:   { x: -0.07, y: 0.36, z: -0.10, tiltZ: -0.45 },
  hobgoblin:     { x: -0.11, y: 0.50, z: -0.17, tiltZ: -0.45 },
  goblinWarlord: { x: -0.09, y: 0.44, z: -0.14, tiltZ: -0.45 }
};

const GOBLIN_WEAPON_SCALE = 0.7;
// Crew-served megabow: the carrier's bow is drawn this much bigger.
const CREW_BOW_SCALE = 1.9;
// The carrier wears the megabow on his back; the shooter stands behind him.
const CREW_CARRIER_BOW_ANCHOR = {
  shoulderX: 0.0, shoulderY: 0.52, shoulderZ: 0.0,
  handX: 0.0, handY: 0.42, handZ: -0.24
};

// Megabow scale multiplier. Sized for a "huge over-engineered crossbow,"
// scaled 1.5x relative to standard goblin weapons.
const CREW_MEGABOW_SCALE = 1.5;

// The megabow anchors heavily onto the carrier's back. Unlike normal
// crew bows (which are just slung backwards), the megabow is an
// enormous machine — the heavy mechanism sticks out way behind the
// carrier, while the long prods extend forward over the shoulder.
// handZ: -0.15 pushes the grip behind the shoulder, letting the
// stock span from the lower back to the front of the chest.
const CREW_MEGABOW_ANCHOR = {
  shoulderX: 0.0, shoulderY: 0.55, shoulderZ: 0.0,
  handX: 0.10, handY: 0.50, handZ: -0.15
};

// A part casts a shadow only if its SECOND-largest bounding dimension is
// at least this big. Rods and tubes (spear shafts, bow limbs, quivers,
// horse legs, sword blades) are thinner than a shadow-map texel, so their
// shadow is invisible but their extra draw call is not. Bodies, shields
// and plates pass easily.
const SHADOW_MID_DIM_MIN = 0.14;
const _shadowCastCache = new WeakMap();
const _shadowBoxSize = new THREE.Vector3();

function geometryCastsShadow(geometry) {
  if (!geometry) return false;
  let cached = _shadowCastCache.get(geometry);
  if (cached !== undefined) return cached;

  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) {
    cached = false;
  } else {
    box.getSize(_shadowBoxSize);
    const sum = _shadowBoxSize.x + _shadowBoxSize.y + _shadowBoxSize.z;
    const maxDim = Math.max(_shadowBoxSize.x, _shadowBoxSize.y, _shadowBoxSize.z);
    const minDim = Math.min(_shadowBoxSize.x, _shadowBoxSize.y, _shadowBoxSize.z);
    cached = (sum - maxDim - minDim) >= SHADOW_MID_DIM_MIN;
  }
  _shadowCastCache.set(geometry, cached);
  return cached;
}

// --- walk-pose legs --------------------------------------------------------

// Cache key holder. Keyed off the thigh geometry's UUID so both thigh and
// shin reuse the same cache entry across every soldier of one variant.
const _staticLegsCacheKey = new WeakMap();

// Leg rigs for the instancer, one per body variant and tier (same key as
// the baked pose geometries). Plain-number snapshots of the leg layout, so
// no detached scene nodes are retained. `local` caches the per-pose part
// matrices the first time the instancer asks for each pose.
const _legRigs = new Map();

// Cached pose ARRAYS (walk + run) per variant. The individual geometries are
// already shared through cachedGeometry(), but the array wrapper that holds
// their references was being rebuilt on every soldier composition — 2000
// allocations and 34000 pushes in a thousand-soldier battle for arrays that
// never change after the first soldier of a variant composes. This cache
// holds the assembled walk/run arrays so subsequent soldiers of the same
// variant get them by reference lookup instead.
const _staticLegsArraysCache = new Map();

// Extracts the shape of one leg from its hip pivot. Handles the two layouts
// LegBuilder and MediumModels produce:
//   two-piece: hip pivot has a thigh mesh AND a knee group holding the shin
//   one-piece: hip pivot has only a single leg mesh (medium tier)
//
// Returns { hip, mesh, knee, shin } where knee / shin are null on the
// one-piece layout.
function extractLegSide(hip) {
  let mesh = null;
  let knee = null;
  let shin = null;
  for (const c of hip.children) {
    if (c.isMesh && !mesh) mesh = c;
    else if (c.isGroup && !knee) {
      knee = c;
      for (const s of c.children) {
        if (s.isMesh) { shin = s; break; }
      }
    }
  }
  return { hip, mesh, knee, shin };
}

// Bakes one walk-cycle pose into a single merged geometry. `phase` is in
// [0, 1); 0 corresponds to the walk cycle's sin(p) = 0 crossing.
//
// The two legs are exactly out of phase with each other and always knee-
// flex backward, matching the runtime walk cycle in SoldierView. Baking
// at full amplitude means a soldier that is only partially into its walk
// cycle (amplitude ramp) uses a full-amplitude pose — the discrepancy is
// a couple degrees of leg swing and is invisible at battle zoom.
// phase < 0 is the REST sentinel. A rest pose is not the same as phase 0:
// at phase 0 the sine is 0 (hips neutral) but the cosine is 1, so the
// knees are still deeply flexed — a mid-stride pose with the legs
// straight under the hips. The actual rest pose the eye expects an idle
// soldier to stand in has BOTH no hip swing AND no knee flex. Baking it
// as a distinct entry at index 0 and shifting the walk poses to indices
// 1..N is what lets SoldierView pick "rest" when the walk amplitude
// reaches zero.
export function computeLegPoseParts(
  leftSide, rightSide, phase,
  swingRad = WALK_LEG_SWING_RAD,
  kneeSwingRad = KNEE_SWING_RAD
) {
  const isRest = phase < 0;
  const p = isRest ? 0 : phase * Math.PI * 2;
  const swing = isRest ? 0 : Math.sin(p) * swingRad;
  const cosP = isRest ? 0 : Math.cos(p);
  const leftKneeRot = isRest
    ? 0
    : KNEE_BASE_RAD + kneeSwingRad * Math.max(0, -cosP);
  const rightKneeRot = isRest
    ? 0
    : KNEE_BASE_RAD + kneeSwingRad * Math.max(0, cosP);

  const parts = [];

  const bakeSide = (side, swingRot, kneeRot) => {
    // hipWorld = translation(hip.position) * rotationX(swingRot)
    const hipMat = new THREE.Matrix4()
      .makeTranslation(side.hip.position.x, side.hip.position.y, side.hip.position.z)
      .multiply(new THREE.Matrix4().makeRotationX(swingRot));

    // meshLocal = translation(mesh.position)
    const meshMat = hipMat.clone().multiply(
      new THREE.Matrix4().makeTranslation(
        side.mesh.position.x, side.mesh.position.y, side.mesh.position.z));
    parts.push({ geometry: side.mesh.geometry, matrix: meshMat });

    if (side.knee && side.shin) {
      // kneeWorld = hipWorld * translation(knee.position) * rotationX(kneeRot)
      const kneeMat = hipMat.clone()
        .multiply(new THREE.Matrix4().makeTranslation(
          side.knee.position.x, side.knee.position.y, side.knee.position.z))
        .multiply(new THREE.Matrix4().makeRotationX(kneeRot));
      const shinMat = kneeMat.clone().multiply(
        new THREE.Matrix4().makeTranslation(
          side.shin.position.x, side.shin.position.y, side.shin.position.z));
      parts.push({ geometry: side.shin.geometry, matrix: shinMat });
    }
  };

  bakeSide(leftSide, swing, leftKneeRot);
  bakeSide(rightSide, -swing, rightKneeRot);

  return parts;
}

function buildLegPoseGeometry(leftSide, rightSide, phase, swingRad, kneeSwingRad) {
  return mergeGeometries(
    computeLegPoseParts(leftSide, rightSide, phase, swingRad, kneeSwingRad)
  );
}

// Replaces the body's animated leg pivots with a single mesh that carries
// the walk-pose geometry for the current phase. Bakes all poses up front;
// SoldierView swaps the geometry reference each frame.
//
// Only called for non-mounted units. A mounted rider's legs sit in a
// straddle pose that is not part of the walk cycle, so mounts keep their
// animated pivots.
function attachStaticLegs(body, bodyVariant) {
  const leftHip = body.userData.legLeftPivot;
  const rightHip = body.userData.legRightPivot;
  if (!leftHip || !rightHip) return;

  const leftSide = extractLegSide(leftHip);
  const rightSide = extractLegSide(rightHip);
  if (!leftSide.mesh || !rightSide.mesh) return;

  // One cache namespace per body variant. Keyed off the first available
  // geometry UUID so both legs of one variant share every pose entry.
  let cacheKey = _staticLegsCacheKey.get(leftSide.mesh.geometry);
  if (!cacheKey) {
    cacheKey = `walkPose.${bodyVariant}.${leftSide.mesh.geometry.uuid}`;
    _staticLegsCacheKey.set(leftSide.mesh.geometry, cacheKey);
  }

  // Pose arrays are built ONCE per variant and reused for every soldier
  // of that variant. The individual geometries are already deduped by
  // cachedGeometry, but the array wrapper itself was previously rebuilt
  // on every compose() call — two allocations and thirty-four pushes per
  // soldier for objects that never change after the first soldier of a
  // variant composes. The cache below holds the assembled arrays, so a
  // thousand-soldier battle now builds them once per variant, not once
  // per soldier.
  //
  // Only variants that actually appear in the current battle (or in the
  // main menu background / army bar thumbnail, both of which also call
  // compose()) ever reach this code — the cache is populated on first
  // use, not eagerly at boot. A custom battle with three body variants
  // bakes three sets, not every variant the game declares.
  let poseArrays = _staticLegsArraysCache.get(cacheKey);
  if (!poseArrays) {
    const walk = [];

    // Index 0: rest pose. Both legs straight, no knee flex. This is what
    // an idle soldier stands in — selected by SoldierView whenever the
    // walk amplitude is at zero.
    walk.push(cachedGeometry(
      `${cacheKey}.rest`,
      () => buildLegPoseGeometry(leftSide, rightSide, -1)
    ));

    // Indices 1..N: the walk cycle. Shifted by one so the view can
    // address the rest pose as a distinct entry without a conditional
    // sentinel in the pose selection code.
    for (let i = 0; i < WALK_POSE_COUNT; i++) {
      const phase = i / WALK_POSE_COUNT;
      walk.push(cachedGeometry(
        `${cacheKey}.pose.${i}`,
        () => buildLegPoseGeometry(leftSide, rightSide, phase)
      ));
    }

    // Run pose array. Same shape (rest + N walk-cycle entries) as the
    // walk array above, but baked at the wider amplitude in
    // RUN_LEG_SWING_RAD / RUN_KNEE_SWING_RAD. SoldierView picks between
    // the two arrays based on the soldier's gaitRunning flag.
    const run = [];
    run.push(cachedGeometry(
      `${cacheKey}.runRest`,
      () => buildLegPoseGeometry(leftSide, rightSide, -1)
    ));
    for (let i = 0; i < WALK_POSE_COUNT; i++) {
      const phase = i / WALK_POSE_COUNT;
      run.push(cachedGeometry(
        `${cacheKey}.runPose.${i}`,
        () => buildLegPoseGeometry(
          leftSide, rightSide, phase, RUN_LEG_SWING_RAD, RUN_KNEE_SWING_RAD)
      ));
    }

    // Kneel poses (megabow carrier). Appended AFTER the walk poses, so they
    // sit at indices poseCount + 1 + stage. Both arrays get the same entries
    // because SoldierView may be holding either one.
    for (let k = 0; k < KNEEL_POSE_COUNT; k++) {
      const kneel = cachedGeometry(
        `${cacheKey}.kneel.${k}`,
        () => mergeGeometries(computeKneelPoseParts(leftSide, rightSide, k))
      );
      walk.push(kneel);
      run.push(kneel);
    }

    poseArrays = { walk, run };
    _staticLegsArraysCache.set(cacheKey, poseArrays);
  }
  const poseGeometries = poseArrays.walk;
  const runPoseGeometries = poseArrays.run;

  // The single leg mesh. Starts at the rest pose (index 0). Shares the
  // body's per-instance material so the legs HP-tint in lockstep with
  // the torso. `noShadow` matches the individual leg meshes — legs are
  // already excluded from the shadow pass.
  const staticLegsMesh = new THREE.Mesh(poseGeometries[0], body.userData.baseMaterial);
  staticLegsMesh.userData.noShadow = true;

  // Rig for SoldierInstancer: lets it draw this mesh as thigh/shin parts
  // instead of one bucket per pose geometry. SoldierView writes the
  // current pose index into staticLegsMesh.userData.poseIdx.
  let rig = _legRigs.get(cacheKey);
  if (!rig) {
    const pos = (o) => ({ x: o.position.x, y: o.position.y, z: o.position.z });
    const snap = (side) => ({
      hip: { position: pos(side.hip) },
      mesh: { position: pos(side.mesh), geometry: side.mesh.geometry },
      knee: side.knee ? { position: pos(side.knee) } : null,
      shin: side.shin ? { position: pos(side.shin), geometry: side.shin.geometry } : null
    });
    rig = {
      left: snap(leftSide),
      right: snap(rightSide),
      poseCount: WALK_POSE_COUNT,
      local: []
    };
    _legRigs.set(cacheKey, rig);
  }
  staticLegsMesh.userData.legRig = rig;
  body.add(staticLegsMesh);

  body.userData.staticLegsMesh = staticLegsMesh;
  body.userData.staticLegsPoseGeometries = poseGeometries;
  body.userData.staticLegsRunPoseGeometries = runPoseGeometries;
  body.userData.staticLegsActive = true;
  // Count of WALK poses (not counting the rest pose at index 0). The
  // view adds 1 when addressing into the array — see _applyWalkCycle.
  // Run array has the same shape, so one count covers both.
  body.userData.staticLegsPoseCount = WALK_POSE_COUNT;
  body.userData.staticLegsRunPoseCount = WALK_POSE_COUNT;

  // Detach the pivots. They never draw for a walking soldier, yet as
  // scene-graph nodes they still cost matrix updates every frame (eight
  // nodes per soldier). The references stay in body.userData, so code
  // that looks them up there still finds them.
  body.remove(leftHip);
  body.remove(rightHip);
}

export class SoldierModelComposer {
static compose(unitTypeDef, teamId, bodyVariant, crewRole = null) {
    const group = new THREE.Group();
    const rider = new THREE.Group();
    group.add(rider);

    const color = getTeamColor(teamId);
    const isGoblinElite = bodyVariant === 'goblinElite';
    // Elite shares the common goblin body today — see eliteGoblinSwordsman
    // in UnitTypes.js. Included in isGoblin so body selection AND the
    // small-scale weapon kit (usesSmallScaleKit) both fire for the elite
    // without a second branch. If a dedicated elite body builder lands
    // later, only the body-selection chain needs a new case.
    const isGoblin = bodyVariant === 'goblin' || isGoblinElite;
    const isGoblinSlave = bodyVariant === 'goblinSlave';
    const isHobgoblin = bodyVariant === 'hobgoblin';
    const isGoblinWarlord = bodyVariant === 'goblinWarlord';
    const isSkeleton = bodyVariant === 'skeleton';
    // Riderless beast: only the mount draws. See Soldier.isRiderlessMount.
    const isRiderless = bodyVariant === 'riderlessBeast';

    // Same small-kit scale as the common goblin — a slave is not a
    // separate species. Kept as a single flag so the weapon-scale path
    // below does not need a second OR.
    const usesSmallScaleKit = isGoblin || isGoblinSlave;

    let body;
    if (isRiderless) {
      // Empty placeholder group so downstream code (unitId tag,
      // HP-tint path) has a valid target. The material attached here
      // is never rendered — it exists purely so SoldierView's body-
      // tint code does not need a null check.
      body = new THREE.Group();
      body.userData.baseMaterial = new THREE.MeshBasicMaterial({ color });
    } else if (isSkeleton) {
      body = SoldierMeshFactory.createSkeletonBody(color, color);
    } else if (isGoblinElite) {
      body = SoldierMeshFactory.createGoblinEliteBody(color);
    } else if (isGoblin) {
      body = SoldierMeshFactory.createGoblinBody(color);
    } else if (isGoblinSlave) {
      body = SoldierMeshFactory.createGoblinSlaveBody(color);
    } else if (isGoblinWarlord) {
      body = SoldierMeshFactory.createGoblinWarlordBody(color);
    } else if (isHobgoblin) {
      body = SoldierMeshFactory.createHobgoblinBody(color);
    } else {
      body = SoldierMeshFactory.createBlobBody(color, unitTypeDef.helmetType);
    }
    if (!isRiderless) rider.add(body);

    if (!isRiderless && !isMounted(unitTypeDef)) {
      attachStaticLegs(body, bodyVariant);
    }

    let horseBase = null;
    if (isMounted(unitTypeDef)) {
      if (unitTypeDef.mountType === 'hound') {
        // Goblin war hound (see UnitTypes.goblinHound). Riderless by
        // design — the empty body path above makes the hound model the
        // soldier's entire visual.
        horseBase = SoldierMeshFactory.createHoundBase();
      } else if (unitTypeDef.mountType === 'beast') {
        horseBase = SoldierMeshFactory.createBeastMount();
      } else if (isSkeleton) {
        horseBase = SoldierMeshFactory.createSkeletonHorseBase();
      } else {
        horseBase = SoldierMeshFactory.createHorseBase();
      }
      group.add(horseBase);
      rider.position.y = horseBase.userData.riderMountHeight ?? 0;
    } else {
      rider.position.y = 0;
    }

    let shield = null;
    if (!isRiderless && unitTypeDef.hasShield) {
      // Pass the team's display hex. Only shields whose face carries
      // team-coloured heraldry read it (today, the Warlord shield's
      // crest); every other shield ignores it. `color` is the same
      // team hex already in scope from getTeamColor() above.
      shield = ShieldViewFactory.createForBodyVariant(bodyVariant, color);
      rider.add(shield);
    }

    // Riderless mount carries no weapon — a beast on its own swings
    // nothing. The sim still reads unitTypeDef.weaponType for the attack
    // matchup lookup, so mechanically the beast attacks with the source
    // type's weapon table, but no mesh is drawn.
    let weapon = null;
    let weaponArm = null;
    // Crew-served weapon: the SHOOTER carries nothing (the carrier holds
    // the weapon). crewRole is null for every non-crew caller.
    const crewShooter = crewRole === 'shooter';
    if (!isRiderless && !crewShooter) {
      const useBeastScythe = unitTypeDef.mountType === 'beast';
      // A megabowman CARRIER gets the dedicated triple-prod arbalest,
      // not the standard bow. Distinguished by `rangedWeaponType ===
      // 'crossbow'` — the only ranged type currently set to that, and
      // the field the whole crew pipeline already keys on. If a future
      // crew-served bow weapon is added, this check needs an additional
      // discriminator.
      const useMegabow = crewRole === 'carrier'
        && unitTypeDef.rangedWeaponType === 'crossbow';
      weapon = useBeastScythe
        ? SoldierMeshFactory.createSwordScythe()
        : useMegabow
          ? SoldierMeshFactory.createMegabow()
          : WeaponViewFactory.createForWeaponType(unitTypeDef.weaponType, bodyVariant, unitTypeDef.clubWeapon === true);
      weapon.rotation.order = 'YXZ';

      if (!useBeastScythe && unitTypeDef.weaponType === 'sword') {
        const anchor = SWORD_ARM_ANCHORS[bodyVariant] || SWORD_ARM_ANCHORS.blob;
        weapon.position.set(anchor.handX, anchor.handY, anchor.handZ);
        weaponArm = new THREE.Group();
        weaponArm.position.set(anchor.shoulderX, anchor.shoulderY, anchor.shoulderZ);
        weapon.position.sub(weaponArm.position);
        weaponArm.add(weapon);
        body.add(weaponArm);
      } else if (useMegabow) {
        // The carrier wears a vest; two rods from the shoulders hold a hinge
        // above and behind the head; the bow hangs from that hinge. The hinge
        // pivot is the weaponArm: SoldierView tilts it to aim over the head.
        // The bow is authored at goblin scale, so no scaling happens here.
        const harness = SoldierMeshFactory.createMegabowHarness(color);
        body.add(harness.group);
        harness.mount.add(weapon);
        weaponArm = harness.hinge;
        layoutMegabowDeploy(weapon, weaponArm, 0, 0, 0);
      } else if (!useBeastScythe && unitTypeDef.weaponType === 'bow') {
        const anchor = useMegabow
          ? CREW_MEGABOW_ANCHOR
          : (crewRole === 'carrier'
            ? CREW_CARRIER_BOW_ANCHOR
            : (BOW_ARM_ANCHORS[bodyVariant] || BOW_ARM_ANCHORS.blob));
        weapon.position.set(anchor.handX, anchor.handY, anchor.handZ);
        weaponArm = new THREE.Group();
        weaponArm.position.set(anchor.shoulderX, anchor.shoulderY, anchor.shoulderZ);
        weapon.position.sub(weaponArm.position);
        if (usesSmallScaleKit) weapon.scale.setScalar(GOBLIN_WEAPON_SCALE);
        if (useMegabow) weapon.scale.multiplyScalar(CREW_MEGABOW_SCALE);
        else if (crewRole === 'carrier') weapon.scale.multiplyScalar(CREW_BOW_SCALE);
        weaponArm.add(weapon);
        body.add(weaponArm);

        const quiverAnchor = QUIVER_ANCHORS[bodyVariant] || QUIVER_ANCHORS.blob;
        const quiver = SoldierMeshFactory.createQuiver();
        quiver.position.set(quiverAnchor.x, quiverAnchor.y, quiverAnchor.z);
        quiver.rotation.z = quiverAnchor.tiltZ;
        if (usesSmallScaleKit) quiver.scale.setScalar(GOBLIN_WEAPON_SCALE);
        if (crewRole !== 'carrier') body.add(quiver);
      } else {
        if (usesSmallScaleKit) {
          weapon.scale.setScalar(GOBLIN_WEAPON_SCALE);
          weapon.position.multiplyScalar(GOBLIN_WEAPON_SCALE);
        }
        body.add(weapon);
      }
    }

    group.traverse((obj) => {
      if (!obj.isMesh) return;
      if (obj.userData.noShadow) {
        obj.castShadow = false;
      } else {
        obj.castShadow = geometryCastsShadow(obj.geometry);
      }
    });

    return { group, rider, body, shield, weapon, weaponArm, horseBase };
  }
}