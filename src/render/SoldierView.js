import * as THREE from 'three';
import { ActiveTerrain } from '../session/ActiveTerrain.js';
import { SoldierModelComposer } from './SoldierModelComposer.js';
import { SoldierMeshFactory } from './SoldierMeshFactory.js';
import { ArrowArc } from '../sim/ArrowArc.js';
import { SpearWall } from '../sim/SpearWall.js';
import { layoutBowString } from './mesh/BowBuilder.js';
import { layoutMegabowDraw, layoutMegabowDeploy } from './mesh/MegabowBuilder.js';
import { KNEEL_STAGE_CROUCH, KNEEL_STAGE_KNEEL, KNEEL_REAR_HIP_RAD } from './KneelPose.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { isCavalry } from '../config/UnitClasses.js';
import { GraphicsMode } from './GraphicsMode.js';
import { LodTier } from './LodConfig.js';
import { getTintedMaterial, quantizeTint } from './TintedMaterialCache.js';

const ATTACK_ANIM_DURATION = 0.18;
const BLOCK_FLASH_DURATION = 0.22;
const DEATH_FALL_DURATION = 0.55;

// Soldiers at this LOD tier or farther are fully synced every second frame
// (staggered across soldiers) instead of every frame.
const FAR_TIER = 4;

// A far soldier does one full sync every FAR_SYNC_PERIOD frames; the
// skipped frames' time is carried into the next full sync. The sim only
// moves soldiers at 15 Hz, so at far-tier distance a 4-frame period is
// below what the eye can separate. Set to 2 for the previous half-rate.
const FAR_SYNC_PERIOD = 4;
let _syncPhaseCounter = 0;

// Blood-thrall body tint. A raised skeleton blends toward this dark blood
// red so a friendly undead reads as a blood-thrall rather than as a
// normal skeleton on the champion's team. The blend runs after the
// hp-scaled base colour write, so a wounded thrall still dims visibly
// toward black — the red is the thrall read, the dimming is the health
// read, and both survive.
//
// Applied once per sync, only when soldier.isThrall is true (and skipped
// on riderless mounts — a beast is not an animated corpse).
const THRALL_TINT_COLOR = new THREE.Color(0x8a0e0e);
const THRALL_TINT_BLEND = 0.78;

const SHIELD_LATERAL = 0.18;
const MOUNTED_SHIELD_SPIN_RAD = 0.20;
const MOUNTED_SHIELD_LATERAL_EXTRA = 0.04;

const BOW_MAX_DRAW = 0.18;
const BOW_MAX_FLEX_RAD = 0.35;
const BOW_ARROW_REST_CENTER_Z = 0.25;
const BOW_DRAW_SMOOTHING = 0.35;

const SWORD_ATTACK_ANIM_DURATION = 0.30;
const SWORD_REST_RAD = -Math.PI / 2 + 0.20;
const SWORD_ARM_SWING_MAX = -Math.PI / 4;
const SWORD_WRIST_SWING_MAX = Math.PI;
const SWORD_STRIKE_FRACTION = 0.55;
const SWORD_TWIST_MAX_RAD = 0.25;

// Raised-spear swing. When a spearman's spear is up (a friendly in the
// way, or bad footing), he can't thrust as part of a wall — he chops with
// the shaft instead. The chop is ADDED on top of the weapon's resting
// pitch (set by _applyWeaponPitch from spearRaiseAmount), so the arc
// starts wherever the spear happens to be held.
//
//   WINDUP: spear rises a little further at the start (delta negative).
//   DOWN:   total downward swing from the resting pitch, past horizontal.
//
// Strike occupies SPEAR_SWING_STRIKE_END - SPEAR_SWING_STRIKE_START of
// the clip; the rest is windup and recovery. Same duration as the sword
// swing so the arc reads at battle zoom.
const SPEAR_SWING_DURATION = 0.30;
const SPEAR_SWING_WINDUP = 0.35;
const SPEAR_SWING_DOWN = 1.80;
const SPEAR_SWING_STRIKE_START = 0.20;
const SPEAR_SWING_STRIKE_END = 0.55;

// Short spear. Distinct stance from the normal spear:
//   - idle/marching: held at a FIXED diagonal-up angle, never raised or
//     lowered. spearRaiseAmount is deliberately ignored — the visual is
//     decoupled from the SpearWall brace state, and there is no walk-
//     cycle bobbing on the weapon.
//   - attack:        swings DOWN to horizontal and thrusts forward,
//                    then returns to the diagonal-up stance.
//
// SHORT_SPEAR_IDLE_RAD is the fixed idle pitch. Negative = tip up (same
// sign convention as the normal spear's raise: -amount * fullRaiseRad).
// -0.9 rad ≈ 52° — clearly diagonal without being near-vertical, so the
// tip clears the next rank's heads while the line is marching.
//
// The thrust duration is slightly longer than ATTACK_ANIM_DURATION (0.18)
// because the tip has to travel from diagonal to horizontal, a larger
// angular sweep than a normal thrust from the resting horizontal pose.
const SHORT_SPEAR_IDLE_RAD = -0.9;
const SHORT_SPEAR_THRUST_DURATION = 0.22;

// Megabow carrier deployment (kneel + hinge tilt). _megabowDeploy runs 0..1.
// The steps are per synced frame, like the other smoothing factors here.
const MEGABOW_DEPLOY_STEP = 0.035;
const MEGABOW_RETRACT_STEP = 0.05;
// Leg pose thresholds: crouch pose above CROUCH_FROM, full kneel above KNEEL_FROM.
const MEGABOW_CROUCH_FROM = 0.12;
const MEGABOW_KNEEL_FROM = 0.60;
// The string only starts drawing once the bow is mostly deployed.
const MEGABOW_DRAW_FROM = 0.70;
// Aim limits (radians) and smoothing of the aim values.
const MEGABOW_DEFAULT_PITCH = 0.35;
const MEGABOW_MIN_PITCH = 0.08;
const MEGABOW_MAX_PITCH = 0.90;
const MEGABOW_MAX_YAW = 1.10;
const MEGABOW_AIM_SMOOTHING = 0.20;

const LANCE_RANK_BASE_RAISE = [0.00, 0.75, 0.88, 0.95];

const WALK_STRIDE_LENGTH = 1.2;
const WALK_LEG_SWING_RAD = 0.55;
const WALK_SPEED_SMOOTHING = 0.15;
const WALK_AMP_SMOOTHING = 0.12;
const WALK_MIN_SPEED = 0.05;
const WALK_IDLE_EPSILON = 0.001;

// Forward pitch applied to the torso while running. Combined with the
// wider leg swing from the run pose array, this is the classic "leaning
// into the stride" silhouette that distinguishes a run from a fast walk
// even at battle zoom. Small (8.6 degrees) so it reads as posture, not
// as toppling. Smoothly ramped in _updateRunLean, not snapped, so a
// gait toggle mid-march does not pop.
const RUN_FORWARD_LEAN_RAD = 0.15;
const RUN_LEAN_SMOOTHING = 0.15;

const KNEE_BASE_RAD = 0.10;
const KNEE_SWING_RAD = 0.80;

const HORSE_STRIDE_LENGTH = 2.0;
const HORSE_LEG_SWING_RAD = 0.5;
const HORSE_REAR_SWING_SCALE = 0.85;
const HORSE_REAR_PHASE_LAG = 0.35;
const HORSE_BOB_AMPLITUDE = 0.03;

const RIDER_THIGH_OUT_RAD = 1.05;

// LOD STRATEGY — SINGLE TIER, DISCARD ON CHANGE
//
// This class builds EXACTLY ONE tier model per soldier. A tier change
// composes the new tier, re-parents the flag, and drops the old model
// from the scene graph entirely. With hysteresis in place (see
// LodConfig.tierForDistanceWithHysteresis) tier changes are rare enough
// that the rebuild cost is invisible — and the scene graph stays at one
// tier's worth of nodes per soldier instead of four.
//
// The only scene-graph node owned outside the current tier model is the
// routing flag, which is re-parented on every tier change.

export class SoldierView {
  constructor(soldier, scene) {
    this.soldier = soldier;
    this._scene = scene;

    // Initial tier: whatever the player's settings say is the most
    // detailed tier they allow. If LOD is off, that IS the tier the
    // soldier will stay at forever, and no rebuild ever happens. If LOD
    // is on, the first sync re-tiers against the actual camera distance.
    this._tier = GraphicsMode.modelDetail;

    // Flag position varies by body variant — a goblin's head is well
    // below a human's, so the flag height has to match.
    const flagY = (soldier.bodyVariant === 'goblin'
      || soldier.bodyVariant === 'goblinSlave'
      || soldier.bodyVariant === 'goblinElite') ? 0.85 : 1.15;
    this.flag = SoldierMeshFactory.createWhiteFlag();
    this.flag.position.set(-0.18, flagY, -0.1);
    this.flag.visible = false;

    this.group = new THREE.Group();

    this._currentModel = null;
    this._buildModel(this._tier);

    scene.add(this.group);

    this.attackAnimTimeLeft = 0;
    this.blockFlashTimeLeft = 0;
    this.deathProgress = 0;

    const beastMounted = soldier.unitTypeDef.mountType === 'beast';
    // A riderless mount has no weapon mesh (see SoldierModelComposer's
    // riderless branch). Every weapon-animation branch must be disabled
    // on a null weapon, or _applyWeaponPitch / _applyAttackAnim crash
    // on the first frame.
    const hasWeapon = !!this.weapon;
    this._isBow = hasWeapon && !beastMounted && soldier.unitTypeDef.weaponType === 'bow';
    this._isSword = hasWeapon && !beastMounted && soldier.unitTypeDef.weaponType === 'sword';
    this._isLance = hasWeapon && !beastMounted && soldier.unitTypeDef.weaponType === 'lance';
    this._isShortSpear = hasWeapon && !beastMounted && soldier.unitTypeDef.weaponType === 'shortSpear';
    // A crew-served megabow's CARRIER carries the weapon and animates
    // its draw; the SHOOTER (front cell) fires but has no weapon mesh.
    // This flag routes the carrier's per-frame animation to
    // _applyMegabowDraw instead of _applyBowDraw. Set once in the
    // constructor — crewRole and rangedWeaponType never change for a
    // soldier, and every LOD rebuild produces a weapon (or doesn't) the
    // same way, so the flag stays correct across _buildModel.
    this._isMegabowCarrier = hasWeapon
      && !beastMounted
      && soldier.crewRole === 'carrier'
      && soldier.unitTypeDef.rangedWeaponType === 'crossbow';
    this._aimTarget = null;
    // Megabow carrier: deployment progress and smoothed aim (see
    // _applyMegabowDraw). Stay 0 / default for every other soldier.
    this._megabowDeploy = 0;
    this._megabowPitch = MEGABOW_DEFAULT_PITCH;
    this._megabowYaw = 0;
    this._bowDrawProgress = 0;

    this._walkPhase = 0;
    this._walkSpeed = 0;
    this._walkAmplitude = 0;
    this._prevWalkX = soldier.pos.x;
    this._prevWalkZ = soldier.pos.z;
    this._lastLegPoseIdx = -1;
    // Which pose array the last _applyLegPose call used. A gait change
    // swaps the array reference without changing _lastLegPoseIdx, so the
    // dirty check must compare both to detect a real change.
    this._lastLegPoseGeometries = null;
    // Current forward-pitch applied to the torso. Smoothed toward the
    // target (RUN_FORWARD_LEAN_RAD while running, 0 otherwise) so a gait
    // toggle does not pop the body upright in one frame.
    this._runLean = 0;

    this._horsePhase = 0;
    this._horseAmplitude = 0;

    this._syncCache = null;

    // Half-rate sync state for far soldiers. The phase alternates per
    // call; the stagger spreads views evenly across the two frame parities.
    this._skipCounter = _syncPhaseCounter++ % FAR_SYNC_PERIOD;
    this._carriedDelta = 0;
    this._forceSync = false;

    this._usingStaticLegs = false;

    // True once a full sync has rewritten this view's node tree. The
    // instancer clears it after re-walking the tree; while it stays clear
    // the tree is unchanged and the instancer replays its last walk.
    this._dirty = true;
  }

  // Builds a fresh model at the given tier and installs it as the active
  // model. Disposes the previous model's scene-graph contribution if one
  // existed. Sets every sub-reference the per-frame sync path reads.
  _buildModel(tier) {
    const old = this._currentModel;
    if (old) {
      old.rider.remove(this.flag);
      this.group.remove(old.group);
    }

    SoldierMeshFactory.setTier(tier);
    const model = SoldierModelComposer.compose(
      this.soldier.unitTypeDef,
      this.soldier.teamId,
      this.soldier.bodyVariant,
      this.soldier.crewRole
    );
    SoldierMeshFactory.setTier(LodTier.DETAILED);

    model.group.visible = true;
    this.group.add(model.group);
    model.rider.add(this.flag);

    this._currentModel = model;
    this._tier = tier;

    this.rider = model.rider;
    this.body = model.body;
    this.shield = model.shield;
    this.weapon = model.weapon;
    this.weaponArm = model.weaponArm;
    this.horseBase = model.horseBase;

    // YXZ euler order so body.rotation.x is a BODY-LOCAL pitch (forward
    // lean relative to the soldier's facing) rather than a world-axis
    // rotation. With the default 'XYZ' order, rotation.x applies around
    // the world X axis after rotation.y has already turned the body —
    // a running soldier facing sideways would lean left instead of
    // forward. See the lean write in sync() and RUN_FORWARD_LEAN_RAD.
    if (this.body) this.body.rotation.order = 'YXZ';

    this.body.userData.unitId = this.soldier.unitId;

    this._legLeftPivot = this.body.userData.legLeftPivot || null;
    this._legRightPivot = this.body.userData.legRightPivot || null;
    this._legLeftKnee = this.body.userData.legLeftKnee || null;
    this._legRightKnee = this.body.userData.legRightKnee || null;
    // Base hip positions, captured once per model build. The mounted
    // pose translates each pivot outward on X and forward on Z to clear
    // a broad mount; without the base values, repeated per-frame writes
    // would accumulate and walk the pivots off the body.
    this._legBaseX = this._legLeftPivot ? this._legLeftPivot.position.x : 0;
    this._legBaseXRight = this._legRightPivot ? this._legRightPivot.position.x : 0;
    this._legBaseZ = this._legLeftPivot ? this._legLeftPivot.position.z : 0;
    // Euler order 'ZYX' on the hip and knee pivots. With the default
    // 'XYZ' order, the forward-tilt X rotation is applied AFTER the
    // out-splay Z rotation, and it gets rotated into the splay axis
    // instead of pitching the leg forward — the thigh tips out further
    // and the shin stays forward of vertical. 'ZYX' applies X first
    // (pitch forward in body frame) then Z (splay out), which is the
    // composition the mounted pose needs. For unmounted soldiers (no
    // rotation is ever written) and for the horse / skeleton horse
    // mounted pose (only Z is written), the order has no visible effect
    // because there is no X component to reorder.
    if (this._legLeftPivot)  this._legLeftPivot.rotation.order  = 'ZYX';
    if (this._legRightPivot) this._legRightPivot.rotation.order = 'ZYX';
    if (this._legLeftKnee)   this._legLeftKnee.rotation.order   = 'ZYX';
    if (this._legRightKnee)  this._legRightKnee.rotation.order  = 'ZYX';
    this._staticLegsMesh = this.body.userData.staticLegsMesh || null;
    this._staticLegsPoseGeometries =
      this.body.userData.staticLegsPoseGeometries || null;
    this._staticLegsRunPoseGeometries =
      this.body.userData.staticLegsRunPoseGeometries || null;
    this._staticLegsPoseCount =
      this.body.userData.staticLegsPoseCount || 0;
    this._staticLegsRunPoseCount =
      this.body.userData.staticLegsRunPoseCount || 0;
    this._horseLegs = (this.horseBase && this.horseBase.userData.horseLegs) || null;

    this._baseShieldColor = this.shield
      ? this.shield.material.color.clone()
      : null;
    this._baseColor = this.body.userData.baseMaterial.color.clone();

    // Tint state for the shared-material system (see TintedMaterialCache).
    // The body's own material is only a template now: every mesh that used
    // it is collected here and later pointed at a shared tinted material.
    this._thrallBaseColor = this._baseColor.clone()
      .lerp(THRALL_TINT_COLOR, THRALL_TINT_BLEND);
    this._bodyTemplate = this.body.userData.baseMaterial;
    this._bodyMeshes = [];

    // Skin and hair are OPTIONAL. Only the human blob body currently sets
    // these templates; every other body builder leaves them undefined, so
    // _skinTemplate / _hairTemplate stay null and the empty arrays below
    // short-circuit _applyBodyTint's skin/hair branches. See
    // BlobBodyBuilder.js and the skin-tone / hair-tone constants there.
    this._skinTemplate = this.body.userData.skinMaterial || null;
    this._skinMeshes = [];
    this._skinBaseColor = this._skinTemplate
      ? this._skinTemplate.color.clone()
      : null;
    this._thrallSkinBaseColor = this._skinBaseColor
      ? this._skinBaseColor.clone().lerp(THRALL_TINT_COLOR, THRALL_TINT_BLEND)
      : null;

    this._hairTemplate = this.body.userData.hairMaterial || null;
    this._hairMeshes = [];
    this._hairBaseColor = this._hairTemplate
      ? this._hairTemplate.color.clone()
      : null;
    this._thrallHairBaseColor = this._hairBaseColor
      ? this._hairBaseColor.clone().lerp(THRALL_TINT_COLOR, THRALL_TINT_BLEND)
      : null;

    this.body.traverse((o) => {
      if (!o.isMesh) return;
      if (o.material === this._bodyTemplate) this._bodyMeshes.push(o);
      else if (this._skinTemplate && o.material === this._skinTemplate) this._skinMeshes.push(o);
      else if (this._hairTemplate && o.material === this._hairTemplate) this._hairMeshes.push(o);
    });
    this._bodyTintLevel = -1;
    this._bodyTintThrall = false;
    this._shieldTemplate = this.shield ? this.shield.material : null;
    this._shieldTintLevel = -1;
    this._corpseShadowsOff = false;

    if (this.weapon) {
      delete this.weapon.userData.basePos;
      this.weapon.userData.thrustOffset = 0;
    }

    this._usingStaticLegs = this.body.userData.staticLegsActive === true;
    this._lastLegPoseIdx = -1;

    this._forceSync = true;
  }

  setAimTarget(x, z) {
    this._aimTarget = { x, z };
  }

triggerAttackAnim() {
    if (GraphicsMode.disableAnimations) return;
    if (this._isShortSpear) {
      this.attackAnimTimeLeft = SHORT_SPEAR_THRUST_DURATION;
      return;
    }
    if (this._isSpearRaised()) {
      // A raised spearman chops; the arc needs longer than a thrust.
      this.attackAnimTimeLeft = SPEAR_SWING_DURATION;
      return;
    }
    this.attackAnimTimeLeft = this._isSword
      ? SWORD_ATTACK_ANIM_DURATION
      : ATTACK_ANIM_DURATION;
  }

  triggerBlockFlash() {
    if (GraphicsMode.disableAnimations) return;
    this.blockFlashTimeLeft = BLOCK_FLASH_DURATION;
  }

  sync(cameraPos, unitsById, deltaSeconds) {
    const s = this.soldier;

    this._maybeUpdateLod(cameraPos);

    // Far soldiers: sync every second frame and carry the skipped time
    // into the next full sync so timers and walk phase stay correct. A
    // pending forced sync (new model after a tier change) is never skipped.
    if (this._tier >= FAR_TIER && !this._forceSync) {
      this._skipCounter = (this._skipCounter + 1) % FAR_SYNC_PERIOD;
      if (this._skipCounter !== 0) {
        this._carriedDelta += deltaSeconds;
        return;
      }
      deltaSeconds += this._carriedDelta;
    }
    this._carriedDelta = 0;

    const c = this._syncCache;
    const hpRatio = s.maxHp > 0 ? s.hp / s.maxHp : 0;
    const hpBand = Math.max(0, Math.min(10, (hpRatio * 10) | 0));

    const shieldRatio = (s.hasShield && CombatConfig.shieldMaxHp > 0)
      ? Math.max(0, Math.min(1, s.shieldHp / CombatConfig.shieldMaxHp))
      : 0;
    const shieldBand = s.hasShield
      ? Math.max(0, Math.min(10, (shieldRatio * 10) | 0))
      : -1;

    const drawBand = this._isBow
      ? Math.max(0, Math.min(10, (this._bowDrawProgress * 10) | 0))
      : -1;

    const raiseBand = Math.max(0, Math.min(10, ((s.spearRaiseAmount || 0) * 10) | 0));

    // `this._walkSpeed > 0` must be part of the "still doing work" set —
    // otherwise the frame on which a soldier STOPS is also the frame the
    // dirty check sees no position change, short-circuits, and skips
    // _updateWalkSpeed. The EMA would then never decay, the walk cycle
    // would never settle, and the leg animation would never complete its
    // transition back to rest. (Same reasoning for _walkAmplitude; either
    // one staying positive keeps the full sync running until both reach
    // zero.)
    const animating =
      (deltaSeconds > 0 && this.attackAnimTimeLeft > 0) ||
      (deltaSeconds > 0 && this.blockFlashTimeLeft > 0) ||
      (deltaSeconds > 0 && s.state === 'dead' && this.deathProgress < 1) ||
      this._walkAmplitude > 0 ||
      this._walkSpeed > 0 ||
      this._horseAmplitude > 0 ||
      this._bowDrawProgress > 0 ||
      this._megabowDeploy > 0 ||
      s.crewPlanted === true ||
      (s.airborneTicksLeft > 0 && s.airborneTotalTicks > 0);

    if (!this._forceSync && c &&
        !animating &&
        s.pos.x === c.x && s.pos.z === c.z &&
        s.facing === c.facing &&
        s.state === c.state &&
        s.isRouting === c.isRouting &&
        hpBand === c.hpBand &&
        shieldBand === c.shieldBand &&
        drawBand === c.drawBand &&
        raiseBand === c.raiseBand) {
      return;
    }

    this._forceSync = false;
    this._dirty = true;
    if (!c) {
      this._syncCache = {
        x: NaN, z: NaN, facing: NaN,
        state: null, isRouting: false,
        hpBand: -1, shieldBand: -1, drawBand: -1, raiseBand: -1
      };
    }
    const cache = this._syncCache;
    cache.x = s.pos.x;
    cache.z = s.pos.z;
    cache.facing = s.facing;
    cache.state = s.state;
    cache.isRouting = s.isRouting;
    cache.hpBand = hpBand;
    cache.shieldBand = shieldBand;
    cache.drawBand = drawBand;
    cache.raiseBand = raiseBand;

    if (s.state === 'dead' && this.deathProgress < 1) {
      this.deathProgress = Math.min(
        1, this.deathProgress + deltaSeconds / DEATH_FALL_DURATION);
    }

    this.group.visible = true;

    // A corpse that has finished toppling lies on the ground inside its
    // own silhouette; its shadow adds nothing but draw calls.
    if (s.state === 'dead' && this.deathProgress >= 1 && !this._corpseShadowsOff) {
      this._corpseShadowsOff = true;
      this.group.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    }

    // Terrain-aware placement. Before the elevation batch this wrote the
    // foot at world Y = airborneY (0 when grounded), which was correct only
    // on flat terrain — a soldier standing on a hill was drawn airborneY
    // units BELOW the ground mesh and read as buried. Airborne Y is an
    // offset above the local ground (see _computeAirborneY), so the two
    // add: elevated soldiers sit on the hill, thrown soldiers arc over it.
    const groundY = ActiveTerrain.heightAt(s.pos.x, s.pos.z);
    const airborneY = this._computeAirborneY(s);
    this.group.position.set(s.pos.x, groundY + airborneY, s.pos.z);

    // Death / knockdown rotation. Hounds are QUADRUPEDS — the standard
    // forward X-rotation that makes a biped soldier face-plant stands a
    // quadruped on its nose, which reads as a glitch, not as a corpse.
    // They roll onto a flank instead.
    const isHoundMount = this.soldier.unitTypeDef.mountType === 'hound';
    let rotX;
    let rotZ;
    if (isHoundMount) {
      // Sideways death: rotate around Z so the back and flank settle
      // against the ground while the nose stays pointing forward — the
      // classic fallen-animal pose. The per-soldier side is chosen from
      // a hash of soldier id so a dying pack spreads both ways instead
      // of collapsing as one solid block.
      //
      // Alternative ("torso to ground"): swap rotZ for a rotX of +π/2
      // (nose down, belly flat, legs under the body). Reads as a
      // face-plant on a dog — passable but less convincing than a
      // flank collapse. Left as a documented alternative in case the
      // flank pose is rejected.
      rotX = 0;
      if (s.state === 'dead' && this.deathProgress > 0) {
        const side = this._houndDeathSide();
        rotZ = side * (Math.PI / 2) * this.deathProgress;
      } else if (s.state === 'knockedDown' && s.airborneTicksLeft <= 0) {
        // Knocked down mid-battle — go prone on one flank. Not fully
        // rotated because the hound gets back up after the stagger.
        rotZ = Math.PI / 2;
      } else {
        rotZ = 0;
      }
    } else {
      // Biped death — unchanged forward X-rotation.
      rotX = -Math.PI / 2 * this.deathProgress;
      if (s.airborneTicksLeft > 0 && s.airborneTotalTicks > 0) {
        const t = 1 - s.airborneTicksLeft / s.airborneTotalTicks;
        rotX += Math.PI * 2 * t;
      }
      rotZ = (s.state === 'knockedDown' && s.airborneTicksLeft <= 0) ? Math.PI / 2 : 0;
    }

    this.group.rotation.x = rotX;
    this.group.rotation.z = rotZ;

    const twist = this._computeSwordTwist();
    this.body.rotation.y = s.facing + twist;
    // Forward pitch while running. Body euler order is 'YXZ' (set in
    // _buildModel), so rotation.x pitches in the body's local frame —
    // leaning into the direction of travel, not into world +Z. Smoothed
    // toward the target so a mid-march gait toggle eases instead of pops.
    this._updateRunLean(s, deltaSeconds);
    this.body.rotation.x = this._runLean;
    // Riderless mounts have a null weapon (see SoldierModelComposer's
    // riderless branch). Skip the yaw reset for them.
    if (this.weapon) this.weapon.rotation.y = 0;
    this._applyWeaponPitch(s);
    this._applyAttackAnim(deltaSeconds);
    this._applyBowDraw(s);

    if (this.horseBase) {
      this.horseBase.rotation.y = s.facing;
      // hideMount is set on a bodyguard whose rider died after a
      // successful Orphaned Mount roll. The beast is now a separate
      // unit; the corpse topples alone. See Soldier.hideMount.
      this.horseBase.visible = !s.hideMount;
    }

    if (this.shield) {
      const lateralBase = s.shieldSide === 'front' ? 0 : -SHIELD_LATERAL;
      const lateralExtra = (this.horseBase && s.shieldSide !== 'front')
        ? -MOUNTED_SHIELD_LATERAL_EXTRA
        : 0;
      const lateral = lateralBase + lateralExtra;
      const forward = s.shieldSide === 'front' ? 0.32 : 0.30;
      const shieldFacing = s.facing + twist;
      const sinF = Math.sin(shieldFacing);
      const cosF = Math.cos(shieldFacing);
      this.shield.position.set(
        cosF * lateral + sinF * forward,
        0.55,
        -sinF * lateral + cosF * forward
      );
      this.shield.rotation.set(
        0,
        shieldFacing,
        this.horseBase ? -MOUNTED_SHIELD_SPIN_RAD : 0
      );
      this.shield.visible = s.hasShield;

      const shieldRatioExact = Math.max(0, Math.min(1,
        s.shieldHp / CombatConfig.shieldMaxHp));
      const tint = 0.15 + 0.85 * shieldRatioExact;
      this._applyShieldTint(tint);

      this._applyBlockFlash(deltaSeconds);
    }

    const hpRatioExact = Math.max(0, s.hp / s.maxHp);
    const deathDim = 1 - 0.5 * this.deathProgress;
    // Thrall tint. Blended from the team base colour toward green, then
    // hp- and death-dimmed exactly like a normal soldier — the tint is a
    // hue shift on the base, not a replacement, so a nearly-dead thrall
    // still reads as nearly-dead.
    this._applyBodyTint(s, hpRatioExact, deathDim);

    this.flag.visible = s.isRouting;

    this._updateWalkSpeed(s, deltaSeconds);
    this._applyWalkCycle(s, deltaSeconds);
    this._applyHorseWalkCycle(s, deltaSeconds);
  }

  // Wound / death dimming (and the thrall hue shift) through SHARED
  // materials. Only touches the meshes when the quantised step or the
  // thrall flag actually changes, so a stable soldier costs two compares.
_applyBodyTint(s, hpRatio, deathDim) {
    if (this._bodyMeshes.length === 0) return;
    const thrall = !!(s.isThrall && !s.isRiderlessMount);
    const level = quantizeTint((0.4 + 0.6 * hpRatio) * deathDim);
    if (level === this._bodyTintLevel && thrall === this._bodyTintThrall) return;
    this._bodyTintLevel = level;
    this._bodyTintThrall = thrall;

    // Torso (and legs — they share the torso template).
    const base = thrall ? this._thrallBaseColor : this._baseColor;
    const mat = getTintedMaterial(this._bodyTemplate, base, level);
    for (const mesh of this._bodyMeshes) mesh.material = mat;

    // Head (skin). Only present on the human blob body — see
    // BlobBodyBuilder. The base colour is the per-soldier random skin
    // tone; the tint cache shares material instances across soldiers at
    // the same (skin tone, level) pair.
    if (this._skinMeshes.length > 0 && this._skinTemplate) {
      const skinBase = thrall ? this._thrallSkinBaseColor : this._skinBaseColor;
      const skinMat = getTintedMaterial(this._skinTemplate, skinBase, level);
      for (const mesh of this._skinMeshes) mesh.material = skinMat;
    }

    // Hair. Same treatment as skin — separate tint cache entry per
    // (hair tone, level) pair.
    if (this._hairMeshes.length > 0 && this._hairTemplate) {
      const hairBase = thrall ? this._thrallHairBaseColor : this._hairBaseColor;
      const hairMat = getTintedMaterial(this._hairTemplate, hairBase, level);
      for (const mesh of this._hairMeshes) mesh.material = hairMat;
    }
  }

  // Shield damage dimming through shared materials.
  _applyShieldTint(tint) {
    if (!this._shieldTemplate) return;
    const level = quantizeTint(tint);
    if (level === this._shieldTintLevel) return;
    this._shieldTintLevel = level;
    this.shield.material = getTintedMaterial(
      this._shieldTemplate, this._baseShieldColor, level);
  }

  _maybeUpdateLod(cameraPos) {
    const s = this.soldier;
    const dx = cameraPos.x - s.pos.x;
    const dz = cameraPos.z - s.pos.z;
    const distXZ = Math.sqrt(dx * dx + dz * dz);

    const newTier = GraphicsMode.tierForDistanceWithHysteresis(distXZ, this._tier);
    if (newTier === this._tier) return;

    this._buildModel(newTier);
  }

  _updateWalkSpeed(s, deltaSeconds) {
    const dx = s.pos.x - this._prevWalkX;
    const dz = s.pos.z - this._prevWalkZ;
    this._prevWalkX = s.pos.x;
    this._prevWalkZ = s.pos.z;

    const dt = deltaSeconds > 1e-4 ? deltaSeconds : 1e-4;
    const instantSpeed = Math.sqrt(dx * dx + dz * dz) / dt;
    this._walkSpeed += (instantSpeed - this._walkSpeed) * WALK_SPEED_SMOOTHING;
    if (this._walkSpeed < 0.01) this._walkSpeed = 0;
  }

// Ramps the forward torso lean toward its target for this frame.
  // Target is RUN_FORWARD_LEAN_RAD while running, 0 otherwise; the
  // exponential smoothing is frame-rate independent enough for a
  // purely cosmetic pose (a slight overshoot or undershoot on a very
  // low-FPS frame is invisible). A dead or knocked-down soldier
  // never leans — the corpse rotation would combine with it and
  // produce a weird compound pose.
  _updateRunLean(s, deltaSeconds) {
    let target = 0;
    if (s.gaitRunning && s.state !== 'dead'
        && s.state !== 'knockedDown'
        && s.airborneTicksLeft <= 0) {
      target = RUN_FORWARD_LEAN_RAD;
    }
    const blend = Math.min(1, RUN_LEAN_SMOOTHING * (deltaSeconds / 0.016));
    this._runLean += (target - this._runLean) * blend;
    if (Math.abs(this._runLean) < 0.001) this._runLean = 0;
  }

// Walk cycle. When the composer produced pose geometries (every foot
  // soldier), this is a single geometry swap on the merged leg mesh — no
  // per-pivot rotation, one draw call per soldier whether idle or walking.
  //
  // Mounted soldiers keep the animated pivots; they never received pose
  // geometries because a rider's legs are not part of the walk cycle.
  _applyWalkCycle(s, deltaSeconds) {
    if (!this._legLeftPivot || !this._legRightPivot) return;

    if (this.horseBase) {
      // Per-mount pose overrides. A broad mount — the beast, whose body
      // is wider than the horse's barrel, and which seats its rider
      // lower relative to its back — needs the hip pivots moved outward
      // AND forward, and needs the thigh pitched forward and the shin
      // pitched back, before the whole leg clears the body. Without
      // these the horse-tuned defaults leave the knee inside the mount
      // and the shin emerges from the mount's interior, reading as
      // clipping. A mount builder declares its own values in userData;
      // absent values fall back to the original horse-tuned defaults,
      // so the horse and skeleton horse poses are unchanged.
      //
      // The pose composes as:
      //   hip  translate +outX on X, +forwardZ on Z
      //   hip  Rz(±outRad) · Rx(-forwardRad)   — thigh out AND forward
      //   knee Rz(∓outRad) · Rx(+shinBackRad)  — shin back down past vertical
      // Because both pivots use Euler order 'ZYX' (set in _buildModel),
      // the X rotations pitch in the body frame and are not twisted by
      // the Z splay. Net result: thigh points out-forward-down, shin
      // drops down-and-behind — the classic rider's leg over a barrel.
      const outRad     = this.horseBase.userData.riderThighOutRad     ?? RIDER_THIGH_OUT_RAD;
      const outX       = this.horseBase.userData.riderThighOutX       ?? 0;
      const forwardZ   = this.horseBase.userData.riderThighForwardZ   ?? 0;
      const forwardRad = this.horseBase.userData.riderThighForwardRad ?? 0;
      const shinBack   = this.horseBase.userData.riderShinBackRad     ?? 0;

      this._legLeftPivot.position.x  = this._legBaseX     - outX;
      this._legRightPivot.position.x = this._legBaseXRight + outX;
      this._legLeftPivot.position.z  = this._legBaseZ + forwardZ;
      this._legRightPivot.position.z = this._legBaseZ + forwardZ;

      this._legLeftPivot.rotation.x  = -forwardRad;
      this._legRightPivot.rotation.x = -forwardRad;
      this._legLeftPivot.rotation.z  = -outRad;
      this._legRightPivot.rotation.z = outRad;

      if (this._legLeftKnee) {
        this._legLeftKnee.rotation.x = shinBack;
        this._legLeftKnee.rotation.z = outRad;
      }
      if (this._legRightKnee) {
        this._legRightKnee.rotation.x = shinBack;
        this._legRightKnee.rotation.z = -outRad;
      }
      return;
    }

    if (GraphicsMode.disableAnimations) {
      this._applyLegPose(0);
      return;
    }

    const dt = deltaSeconds > 1e-4 ? deltaSeconds : 1e-4;

    const grounded = s.state !== 'dead'
      && s.state !== 'knockedDown'
      && s.airborneTicksLeft <= 0;

    const targetAmp = (grounded && this._walkSpeed > WALK_MIN_SPEED)
      ? WALK_LEG_SWING_RAD
      : 0;
    this._walkAmplitude += (targetAmp - this._walkAmplitude) * WALK_AMP_SMOOTHING;
    if (this._walkAmplitude < WALK_IDLE_EPSILON) this._walkAmplitude = 0;

    // Snap amplitude to zero the instant ground speed drops below the
    // walk threshold. The EMA above decays asymptotically and would take
    // ~1.6 s to cross the idle epsilon — long enough that the pose would
    // stay mid-stride after the soldier has clearly stopped. Snapping
    // sends the pose straight to 0 (rest), which is exactly what the
    // eye expects when a soldier halts.
    if (this._walkSpeed < WALK_MIN_SPEED) {
      this._walkAmplitude = 0;
    }

    this._walkPhase += (this._walkSpeed * dt / WALK_STRIDE_LENGTH) * Math.PI * 2;

    // Pose selection. When the walk amplitude has settled to zero, use
    // the rest pose at index 0 — both legs straight, no knee flex.
    // Otherwise map the walk phase to a walk pose at index 1..N.
    //
    // An earlier version always mapped phase to a walk pose, which left
    // an idle soldier frozen in whatever mid-stride position it stopped
    // at: the walk amplitude snapping to zero only cleared a flag, it
    // did not change which geometry was displayed. The rest pose baked
    // at index 0 is the fix — it is the pose the eye expects a soldier
    // to settle into when it halts.
    // Pick the walk or run pose array. A running soldier uses the wider
    // baked amplitude (RUN_LEG_SWING_RAD / RUN_KNEE_SWING_RAD), so the
    // same physical leg cycle reads as a real stride instead of "walking
    // faster". Falls back to walk poses when the run array is absent
    // (older models, mounted units, ultra tier).
    const useRun = s.gaitRunning === true &&
      this._staticLegsRunPoseGeometries !== null;
    const poseGeometries = useRun
      ? this._staticLegsRunPoseGeometries
      : this._staticLegsPoseGeometries;
    const poseCount = useRun
      ? this._staticLegsRunPoseCount
      : this._staticLegsPoseCount;

    let poseIdx;
    if (this._walkAmplitude < WALK_IDLE_EPSILON || poseCount === 0) {
      poseIdx = 0;
    } else {
      const phaseNorm = ((this._walkPhase / (Math.PI * 2)) % 1 + 1) % 1;
      // +1: skip past the rest pose at index 0 to the walk poses.
      // The final % guards against a phase of exactly 1.0 landing one
      // past the array end after the initial modulo.
      poseIdx = 1 + (Math.floor(phaseNorm * poseCount) % poseCount);
    }

    // Kneeling megabow carrier: the kneel poses sit after the walk poses in
    // both pose arrays.
    const kneelIdx = this._kneelPoseIndex();
    if (kneelIdx >= 0 && poseGeometries) {
      this._applyLegPose(kneelIdx, poseGeometries);
      return;
    }
    this._applyLegPose(poseIdx, poseGeometries);
  }

  // Writes `poseIdx` to the merged leg mesh. Cached so a soldier whose
  // phase is stable does not pay the geometry-reference assignment every
  // frame. When pose geometries are absent (mounted, ultra tier), this is
  // a no-op — those soldiers either have no merged leg mesh at all or
  // use the animated pivots directly.
  _applyLegPose(poseIdx, poseGeometries) {
    if (!this._staticLegsMesh || !poseGeometries) return;
    if (poseIdx === this._lastLegPoseIdx &&
        poseGeometries === this._lastLegPoseGeometries) return;
    this._lastLegPoseIdx = poseIdx;
    this._lastLegPoseGeometries = poseGeometries;
    this._staticLegsMesh.userData.poseIdx = poseIdx;
    this._staticLegsMesh.geometry = poseGeometries[poseIdx];
  }

  _applyHorseWalkCycle(s, deltaSeconds) {
    if (!this._horseLegs) return;

    if (GraphicsMode.disableAnimations) {
      const legs = this._horseLegs;
      legs.fl.rotation.x = 0;
      legs.fr.rotation.x = 0;
      legs.bl.rotation.x = 0;
      legs.br.rotation.x = 0;
      this.horseBase.position.y = 0;
      const riderBaseY = this.horseBase.userData.riderMountHeight ?? 0;
      this.rider.position.y = riderBaseY;
      return;
    }

    const dt = deltaSeconds > 1e-4 ? deltaSeconds : 1e-4;

    const grounded = s.state !== 'dead'
      && s.state !== 'knockedDown'
      && s.airborneTicksLeft <= 0;

    const targetAmp = (grounded && this._walkSpeed > WALK_MIN_SPEED)
      ? HORSE_LEG_SWING_RAD
      : 0;
    this._horseAmplitude += (targetAmp - this._horseAmplitude) * WALK_AMP_SMOOTHING;
    if (this._horseAmplitude < 0.001) this._horseAmplitude = 0;

    this._horsePhase += (this._walkSpeed * dt / HORSE_STRIDE_LENGTH) * Math.PI * 2;

    const p = this._horsePhase;
    const amp = this._horseAmplitude;
    const legs = this._horseLegs;

    const frontSwing = Math.sin(p) * amp;
    const rearSwing = Math.sin(p - HORSE_REAR_PHASE_LAG) * amp * HORSE_REAR_SWING_SCALE;

    legs.fl.rotation.x = frontSwing;
    legs.fr.rotation.x = -frontSwing;
    legs.br.rotation.x = rearSwing;
    legs.bl.rotation.x = -rearSwing;

    const intensity = amp / HORSE_LEG_SWING_RAD;
    const bob = HORSE_BOB_AMPLITUDE * intensity * Math.abs(Math.sin(p));
    this.horseBase.position.y = bob;
    const riderBaseY = this.horseBase.userData.riderMountHeight ?? 0;
    this.rider.position.y = riderBaseY + bob;
  }

  _computeAirborneY(s) {
    if (s.airborneTicksLeft <= 0) return 0;
    const total = s.airborneTotalTicks || 1;
    const t = 1 - s.airborneTicksLeft / total;
    return Math.sin(Math.PI * t) * (s.throwPeakHeight || 0);
  }

_applyAttackAnim(deltaSeconds) {
    if (this._isBow || !this.weapon) return;

    if (GraphicsMode.disableAnimations) {
      if (this.attackAnimTimeLeft > 0) {
        this.attackAnimTimeLeft = 0;
        this.weapon.userData.thrustOffset = 0;
        this._applyWeaponThrust(0);
      }
      return;
    }

    if (this.attackAnimTimeLeft <= 0) {
      this.weapon.userData.thrustOffset = 0;
      this._applyWeaponThrust(0);
      return;
    }

    this.attackAnimTimeLeft = Math.max(0, this.attackAnimTimeLeft - deltaSeconds);

    if (this._isShortSpear) {
      const p = 1 - this.attackAnimTimeLeft / SHORT_SPEAR_THRUST_DURATION;
      this._applyShortSpearAttack(p);
      return;
    }

    if (this._isSpearRaised()) {
      const p = 1 - this.attackAnimTimeLeft / SPEAR_SWING_DURATION;
      this._applyRaisedSpearSwing(p);
      return;
    }

    if (this._isSword && this.weaponArm) {
      const p = 1 - this.attackAnimTimeLeft / SWORD_ATTACK_ANIM_DURATION;
      this._applySwordSlash(p);
      return;
    }

    const t = this.attackAnimTimeLeft / ATTACK_ANIM_DURATION;
    const thrust = Math.sin((1 - t) * Math.PI) * 0.35;
    this._applyWeaponThrust(thrust);
  }



  // True when the soldier is a spearman whose spear is up. Reuses the
  // sim-side check so the animation and the damage penalty agree on the
  // same threshold. Guards against a null weapon (riderless mount) and a
  // beast mount (whose weaponType is inherited from its source but whose
  // scythe is not a spear that can be raised into a swing).
  //
  // Short spear opts out entirely: its visual stance is fixed diagonal,
  // so the raised-spear CHOP animation never applies. The unit may still
  // brace mechanically in the sim if its UnitType declares spear-wall
  // behaviour — that is a data decision outside this class.
  _isSpearRaised() {
    if (!this.weapon) return false;
    if (this._isShortSpear) return false;
    // Beast-mounted and hound-mounted units do not raise a spear into a
    // chop swing. The hound is riderless and its `bite` weapon never
    // reaches SpearWall, but the explicit `hound` term keeps the contract
    // clean for any future hound-mounted polearm unit.
    const mountType = this.soldier.unitTypeDef.mountType;
    if (mountType === 'beast' || mountType === 'hound') return false;
    return SpearWall.isSpearRaised(this.soldier);
  }

  _applyRaisedSpearSwing(p) {
    // Overhead chop from the raised position. The weapon's base pitch was
    // already set this frame by _applyWeaponPitch (from spearRaiseAmount);
    // the swing delta is ADDED on top, so the arc starts wherever the
    // spear is held:
    //   p = 0.00  windup starts, delta 0 (spear at raised pitch)
    //   p = 0.20  windup peak, delta -WINDUP (spear further up)
    //   p = 0.55  strike end,  delta +DOWN (spear past horizontal, tip down)
    //   p = 1.00  recovery complete, delta 0 (back to raised pitch)
    let delta;
    if (p < SPEAR_SWING_STRIKE_START) {
      const u = p / SPEAR_SWING_STRIKE_START;
      delta = -SPEAR_SWING_WINDUP * u;
    } else if (p < SPEAR_SWING_STRIKE_END) {
      const u = (p - SPEAR_SWING_STRIKE_START) /
        (SPEAR_SWING_STRIKE_END - SPEAR_SWING_STRIKE_START);
      // Ease-in on the strike so it accelerates into the chop.
      const eased = u * u;
      delta = -SPEAR_SWING_WINDUP +
        (SPEAR_SWING_WINDUP + SPEAR_SWING_DOWN) * eased;
    } else {
      const u = (p - SPEAR_SWING_STRIKE_END) /
        (1 - SPEAR_SWING_STRIKE_END);
      // Ease-out recovery back to the raised pitch pose.
      const eased = 1 - (1 - u) * (1 - u);
      delta = SPEAR_SWING_DOWN * (1 - eased);
    }
    this.weapon.rotation.x += delta;
  }

  _applySwordSlash(p) {
    let armRot;
    let wristRot;

    if (p < SWORD_STRIKE_FRACTION) {
      const u = p / SWORD_STRIKE_FRACTION;
      const eased = u * u;
      armRot = eased * SWORD_ARM_SWING_MAX;
      wristRot = SWORD_REST_RAD + eased * SWORD_WRIST_SWING_MAX;
    } else {
      const u = (p - SWORD_STRIKE_FRACTION) / (1 - SWORD_STRIKE_FRACTION);
      const eased = 1 - (1 - u) * (1 - u);
      armRot = eased * SWORD_ARM_SWING_MAX;
      wristRot = SWORD_REST_RAD + eased * SWORD_WRIST_SWING_MAX;
    }

    this.weaponArm.rotation.x = armRot;
    this.weapon.rotation.x = wristRot;
  }

  // Death side for a hound — left flank (rotZ = -π/2) or right
  // (rotZ = +π/2). Deterministic per soldier so a fallen hound does not
  // flip sides on a camera scroll or a paused frame. Uses a hash of the
  // soldier id so a unit of dying hounds spreads both ways instead of
  // collapsing in lockstep.
  _houndDeathSide() {
    const id = this.soldier.id;
    let n = 0;
    if (typeof id === 'number') {
      n = id;
    } else if (typeof id === 'string') {
      for (let i = 0; i < id.length; i++) {
        n = ((n * 31) + id.charCodeAt(i)) | 0;
      }
    }
    return (n & 1) ? 1 : -1;
  }

  _computeSwordTwist() {
    if (!this._isSword || this.attackAnimTimeLeft <= 0) return 0;
    const p = 1 - this.attackAnimTimeLeft / SWORD_ATTACK_ANIM_DURATION;
    if (p < SWORD_STRIKE_FRACTION) {
      return (p / SWORD_STRIKE_FRACTION) * SWORD_TWIST_MAX_RAD;
    }
    const u = (p - SWORD_STRIKE_FRACTION) / (1 - SWORD_STRIKE_FRACTION);
    return (1 - u) * SWORD_TWIST_MAX_RAD;
  }

  _applyWeaponThrust(thrustAmount) {
    if (!this.weapon) return;
    const basePos = this.weapon.userData.basePos
      || (this.weapon.userData.basePos = this.weapon.position.clone());
    this.weapon.position.set(basePos.x, basePos.y, basePos.z + thrustAmount);
  }

_applyWeaponPitch(s) {
    if (!this.weapon) return;
    if (this._isBow) {
      if (!this._aimTarget) {
        if (this.weaponArm) this.weaponArm.rotation.x = 0;
        this.weapon.rotation.x = 0;
        return;
      }
      const aim = ArrowArc.computeAim(s.pos.x, s.pos.z, this._aimTarget.x, this._aimTarget.z);
      if (this.weaponArm) {
        this.weaponArm.rotation.x = -aim.pitch;
        this.weapon.rotation.x = 0;
      } else {
        this.weapon.rotation.x = -aim.pitch;
      }
      return;
    }

    // Short spear: fixed diagonal-up stance, never modulated by
    // spearRaiseAmount. The attack animation layers its own rotation
    // delta on top of this base value (see _applyShortSpearAttack).
    if (this._isShortSpear) {
      this.weapon.rotation.x = SHORT_SPEAR_IDLE_RAD;
      return;
    }

    if (this._isSword) {
      this.weapon.rotation.x = SWORD_REST_RAD;
      return;
    }

    if (this._isLance) {
      const rank = Math.min(
        s.formationRank || 0,
        LANCE_RANK_BASE_RAISE.length - 1
      );
      const rankBase = LANCE_RANK_BASE_RAISE[rank];
      const amount = Math.max(s.spearRaiseAmount || 0, rankBase);
      const maxRad = CombatConfig.spearHandling.fullRaiseRad;
      this.weapon.rotation.x = -amount * maxRad;
      return;
    }

    const amount = s.spearRaiseAmount || 0;
    const maxRad = CombatConfig.spearHandling.fullRaiseRad;
    this.weapon.rotation.x = -amount * maxRad;
  }

  _applyBowDraw(s) {
    if (!this._isBow) return;

    // Megabow carriers animate their weapon with a different driver —
    // three prods flexing + a windlass + a single shared nock. The
    // standard layoutBowString path only knows about a single bow's
    // two limb pivots, so route crew carriers elsewhere before that
    // method touches userData it does not have.
    if (this._isMegabowCarrier) {
      this._applyMegabowDraw(s);
      return;
    }

    if (GraphicsMode.disableAnimations) {
      layoutBowString(this.weapon, 0, 0);
      const nockedArrow = this.weapon.userData.nockedArrow;
      if (nockedArrow) nockedArrow.visible = false;
      return;
    }

    // Denominator for the draw curve. Reads the cooldown THIS draw
    // cycle was started with — RangedCombatSystem stamps
    // s.bowDrawMaxTicks on every shooter when it arms a wind-up or
    // releases a volley, and that value already carries the unit's
    // fatigue-scaled cadence
    // (CombatConfig.fatigue.maxRangedCooldownAtZeroFatigue). Reading the
    // static CombatConfig.rangedCooldownTicks instead clamps a fatigued
    // unit's 60-tick cycle at 35: the string sits slack for the first
    // 25 ticks and the visible draw runs only across the tail — the
    // archer reads as late, not tired. Falls back to the static base
    // when no cycle has ever been stamped (a fresh archer that has not
    // fired yet, or a build that never ran the ranged path).
    //
    // The Math.min clamp below is defensive: under normal flow
    // attackCooldownTicks is always <= bowDrawMaxTicks during a cycle
    // (both were stamped from the same value at fire time), but a
    // stale value from a prior cycle should never push targetProgress
    // negative.
    const maxCooldown = s.bowDrawMaxTicks || CombatConfig.rangedCooldownTicks || 1;
    let targetProgress = 0;
    if (s.state === 'ranged' && s.attackCooldownTicks > 0) {
      const cooldownLeft = Math.min(s.attackCooldownTicks, maxCooldown);
      targetProgress = 1 - cooldownLeft / maxCooldown;
    }

    this._bowDrawProgress += (targetProgress - this._bowDrawProgress) * BOW_DRAW_SMOOTHING;
    if (this._bowDrawProgress < 0.001) this._bowDrawProgress = 0;

    const nockZ = -this._bowDrawProgress * BOW_MAX_DRAW;
    const flexAngle = this._bowDrawProgress * BOW_MAX_FLEX_RAD;

    layoutBowString(this.weapon, nockZ, flexAngle);

    const nockedArrow = this.weapon.userData.nockedArrow;
    if (this._bowDrawProgress > 0.05) {
      nockedArrow.visible = true;
      nockedArrow.position.set(0, 0, nockZ + BOW_ARROW_REST_CENTER_Z);
    } else {
      nockedArrow.visible = false;
    }
  }

  // Megabow draw driver — the crew CARRIER's per-frame animation.
  //
  // Drives the whole mechanical draw cycle (three prods flexing, three
  // strings tightening into a V bundle, winch winding, bolt sliding
  // back with the nock) from a single drawProgress in [0, 1]. See
  // layoutMegabowDraw in MegabowBuilder.js for the model contract.
  //
  // TRIGGER SOURCE — READ THIS IF THE ANIMATION DOES NOT PLAY
  // The sim-side fire event is emitted for the SHOOTER (`attackerId`
  // in the ranged fire event), not the carrier. There are two ways the
  // carrier's draw progress can be derived:
  //
  //   A) The crew system mirrors the shooter's state onto the carrier
  //      (both enter 'ranged', both share the cooldown countdown).
  //      This is the design of every crew-served weapon in real-time
  //      games, because otherwise the carrier would walk toward its
  //      formation slot during the fire cycle while the shooter stood
  //      still aiming — visibly broken. If (A) holds, the code below
  //      drives the animation correctly out of the box.
  //
  //   B) The crew system only marks the shooter, leaving the carrier
  //      in 'idle' / 'marching' the whole battle. If (B) is the actual
  //      behaviour, this method returns targetProgress = 0 always and
  //      the animation silently fails. The fix is to add a
  //      triggerMegabowShot() method here and call it from
  //      BattleRenderer._applyRangedEvent when the attacker is a crew
  //      shooter (look up the paired carrier via CrewPairing), then
  //      drive drawProgress from a wall-clock countdown instead of
  //      soldier state.
  //
  // The `s.bowDrawMaxTicks` field is the cooldown value stamped on the
  // SHOOTER at fire time (see RangedCombatSystem). Its presence on the
  // carrier is therefore the clearest indicator of which model (A or B)
  // applies. If bowDrawMaxTicks is undefined on carriers, fall back to
  // the unit type's declared rangedCooldownTicks (90 for the
  // megabowman) so at least the draw rate matches the intended cadence
  // even if the animation only plays when the carrier happens to be
  // in 'ranged' state.
// Megabow carrier driver. Three layers, all fed by the sim:
  //
  //   DEPLOY  When CrewFireControl plants the carrier (s.crewPlanted) the
  //           carrier kneels (leg pose + rider drop) and the hinge tips the
  //           bow forward over the head, sliding it through the carriage.
  //           When released everything runs backwards: the bow hangs
  //           upright on the back again.
  //   AIM     Pitch / yaw come from _aimTarget (setAimTarget). Without an
  //           aim target a default pitch is used.
  //   DRAW    attackCooldownTicks / bowDrawMaxTicks stamped by
  //           RangedCombatSystem._stampHolder drive the string draw, but it
  //           is only visible once the bow is mostly deployed.
  //
  // s.crewPlanted is undefined on snapshot soldiers (multiplayer guest);
  // then the 'ranged' state is used as the planted signal.
  _applyMegabowDraw(s) {
    if (!this.weapon || !this.weaponArm) return;

    const animated = !GraphicsMode.disableAnimations;
    const planted = s.crewPlanted !== undefined
      ? s.crewPlanted === true
      : s.state === 'ranged';
    const wantDeploy = animated && planted && s.state !== 'dead';

    if (animated) {
      const step = wantDeploy ? MEGABOW_DEPLOY_STEP : -MEGABOW_RETRACT_STEP;
      this._megabowDeploy = Math.max(0, Math.min(1, this._megabowDeploy + step));
    } else {
      this._megabowDeploy = 0;
      this._bowDrawProgress = 0;
    }
    const deploy = this._megabowDeploy;

    // --- aim ---
    let pitchGoal = MEGABOW_DEFAULT_PITCH;
    let yawGoal = 0;
    if (this._aimTarget) {
      const aim = ArrowArc.computeAim(s.pos.x, s.pos.z, this._aimTarget.x, this._aimTarget.z);
      pitchGoal = Math.max(MEGABOW_MIN_PITCH, Math.min(MEGABOW_MAX_PITCH, aim.pitch));
      let yaw = Math.atan2(this._aimTarget.x - s.pos.x, this._aimTarget.z - s.pos.z) - s.facing;
      yaw = ((yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      yawGoal = Math.max(-MEGABOW_MAX_YAW, Math.min(MEGABOW_MAX_YAW, yaw));
    }
    this._megabowPitch += (pitchGoal - this._megabowPitch) * MEGABOW_AIM_SMOOTHING;
    this._megabowYaw += (yawGoal - this._megabowYaw) * MEGABOW_AIM_SMOOTHING;

    // --- draw ---
    const maxCooldown = s.bowDrawMaxTicks
      || this.soldier.unitTypeDef.rangedCooldownTicks
      || CombatConfig.rangedCooldownTicks
      || 1;
    let targetProgress = 0;
    if (animated && s.state === 'ranged' && s.attackCooldownTicks > 0) {
      const cooldownLeft = Math.min(s.attackCooldownTicks, maxCooldown);
      targetProgress = 1 - cooldownLeft / maxCooldown;
    }
    this._bowDrawProgress += (targetProgress - this._bowDrawProgress) * BOW_DRAW_SMOOTHING;
    if (this._bowDrawProgress < 0.001) this._bowDrawProgress = 0;

    const t = Math.max(0, Math.min(1, (deploy - MEGABOW_DRAW_FROM) / (1 - MEGABOW_DRAW_FROM)));
    const drawVisible = t * t * (3 - 2 * t);

    // The bow's own frame is rotated by the harness mount; _applyWeaponPitch
    // may have written a bow pitch here, so reset it.
    this.weapon.rotation.x = 0;
    layoutMegabowDeploy(this.weapon, this.weaponArm, deploy, this._megabowPitch, this._megabowYaw);
    layoutMegabowDraw(this.weapon, this._bowDrawProgress * drawVisible);

    // --- kneel drop: lowers the whole rider so the rear knee touches the ground ---
    const hip = this._legLeftPivot ? this._legLeftPivot.position.y : 0.21;
    const thigh = this._legLeftKnee ? -this._legLeftKnee.position.y : 0.105;
    const drop = Math.max(0, hip - thigh * Math.cos(KNEEL_REAR_HIP_RAD));
    this.rider.position.y = -drop * deploy;
  }

  _applyBlockFlash(deltaSeconds) {
    if (GraphicsMode.disableAnimations) {
      this.blockFlashTimeLeft = 0;
      this.shield.scale.set(1, 1, 1);
      return;
    }
    if (this.blockFlashTimeLeft <= 0) {
      this.shield.scale.set(1, 1, 1);
      return;
    }
    this.blockFlashTimeLeft = Math.max(0, this.blockFlashTimeLeft - deltaSeconds);
    const t = this.blockFlashTimeLeft / BLOCK_FLASH_DURATION;
    const bump = 1 + Math.sin(t * Math.PI) * 0.4;
    this.shield.scale.set(bump, bump, 1);
  }

// Index into the leg pose arrays for the current deployment, or -1 when
  // the legs should follow the normal walk cycle. Kneel poses sit after the
  // walk poses: poseCount + 1 + stage (see SoldierModelComposer).
  _kneelPoseIndex() {
    const d = this._megabowDeploy;
    if (!(d > MEGABOW_CROUCH_FROM)) return -1;
    if (!this._staticLegsPoseGeometries || !(this._staticLegsPoseCount > 0)) return -1;
    const stage = d >= MEGABOW_KNEEL_FROM ? KNEEL_STAGE_KNEEL : KNEEL_STAGE_CROUCH;
    return this._staticLegsPoseCount + 1 + stage;
  }

// Short spear thrust. The weapon's idle stance is a fixed diagonal-
  // up angle (SHORT_SPEAR_IDLE_RAD, set every frame by _applyWeaponPitch).
  // The attack adds a rotation delta that cancels that angle — bringing
  // the weapon to horizontal — plus a small forward positional lunge.
  // Both peak at the middle of the animation and return to zero, so the
  // spear snaps back to its fixed diagonal stance the instant the attack
  // ends. There is no windup or recovery pose beyond this curve: the
  // short spear reads as a quick forward jab from a ready diagonal, not
  // as a raised-spear chop.
  //
  // p is the attack progress in [0, 1]. sin(p * π) is 0 at both ends and
  // 1 at the midpoint, giving a smooth out-and-back arc with no
  // discontinuity between the resting diagonal stance and the thrust.
  _applyShortSpearAttack(p) {
    const curve = Math.sin(p * Math.PI);
    // Cancel the idle diagonal and reach horizontal at the peak. Idle
    // is negative (tip up), so the delta is positive.
    this.weapon.rotation.x += -SHORT_SPEAR_IDLE_RAD * curve;
    // Small forward lunge; the spear also gets visual reach from the
    // rotation alone, so the positional thrust stays modest.
    this._applyWeaponThrust(curve * 0.30);
  }

  dispose(scene) {
    scene.remove(this.group);
  }
}

