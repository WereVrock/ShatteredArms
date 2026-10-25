import * as THREE from 'three';
import { SoldierModelComposer } from './SoldierModelComposer.js';
import { SoldierMeshFactory } from './SoldierMeshFactory.js';
import { ArrowArc } from '../sim/ArrowArc.js';
import { layoutBowString } from './mesh/BowBuilder.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { isCavalry } from '../config/UnitClasses.js';
import { GraphicsMode } from './GraphicsMode.js';
import { LodTier } from './LodConfig.js';
import { getTintedMaterial, quantizeTint } from './TintedMaterialCache.js';

const ATTACK_ANIM_DURATION = 0.18;
const BLOCK_FLASH_DURATION = 0.22;
const DEATH_FALL_DURATION = 0.55;

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

const LANCE_RANK_BASE_RAISE = [0.00, 0.75, 0.88, 0.95];

const WALK_STRIDE_LENGTH = 1.2;
const WALK_LEG_SWING_RAD = 0.55;
const WALK_SPEED_SMOOTHING = 0.15;
const WALK_AMP_SMOOTHING = 0.12;
const WALK_MIN_SPEED = 0.05;
const WALK_IDLE_EPSILON = 0.001;

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
    const flagY = soldier.bodyVariant === 'goblin' ? 0.85 : 1.15;
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
    this._aimTarget = null;
    this._bowDrawProgress = 0;

    this._walkPhase = 0;
    this._walkSpeed = 0;
    this._walkAmplitude = 0;
    this._prevWalkX = soldier.pos.x;
    this._prevWalkZ = soldier.pos.z;
    this._lastLegPoseIdx = -1;

    this._horsePhase = 0;
    this._horseAmplitude = 0;

    this._syncCache = null;
    this._forceSync = false;

    this._usingStaticLegs = false;
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
      this.soldier.bodyVariant
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
    this._staticLegsPoseCount =
      this.body.userData.staticLegsPoseCount || 0;
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
    this.body.traverse((o) => {
      if (o.isMesh && o.material === this._bodyTemplate) this._bodyMeshes.push(o);
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
      this.attackAnimTimeLeft > 0 ||
      this.blockFlashTimeLeft > 0 ||
      (s.state === 'dead' && this.deathProgress < 1) ||
      this._walkAmplitude > 0 ||
      this._walkSpeed > 0 ||
      this._horseAmplitude > 0 ||
      this._bowDrawProgress > 0 ||
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

    const airborneY = this._computeAirborneY(s);
    this.group.position.set(s.pos.x, airborneY, s.pos.z);

    let rotX = -Math.PI / 2 * this.deathProgress;
    if (s.airborneTicksLeft > 0 && s.airborneTotalTicks > 0) {
      const t = 1 - s.airborneTicksLeft / s.airborneTotalTicks;
      rotX += Math.PI * 2 * t;
    }
    this.group.rotation.x = rotX;
    this.group.rotation.z =
      (s.state === 'knockedDown' && s.airborneTicksLeft <= 0) ? Math.PI / 2 : 0;

    const twist = this._computeSwordTwist();
    this.body.rotation.y = s.facing + twist;
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

    const base = thrall ? this._thrallBaseColor : this._baseColor;
    const mat = getTintedMaterial(this._bodyTemplate, base, level);
    for (const mesh of this._bodyMeshes) mesh.material = mat;
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
    const instantSpeed = Math.hypot(dx, dz) / dt;
    this._walkSpeed += (instantSpeed - this._walkSpeed) * WALK_SPEED_SMOOTHING;
    if (this._walkSpeed < 0.01) this._walkSpeed = 0;
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
    let poseIdx;
    if (this._walkAmplitude < WALK_IDLE_EPSILON) {
      poseIdx = 0;
    } else {
      const phaseNorm = ((this._walkPhase / (Math.PI * 2)) % 1 + 1) % 1;
      // +1: skip past the rest pose at index 0 to the walk poses.
      // The final % guards against a phase of exactly 1.0 landing one
      // past the array end after the initial modulo.
      poseIdx = 1 + (Math.floor(phaseNorm * this._staticLegsPoseCount) %
        this._staticLegsPoseCount);
    }

    this._applyLegPose(poseIdx);
  }

  // Writes `poseIdx` to the merged leg mesh. Cached so a soldier whose
  // phase is stable does not pay the geometry-reference assignment every
  // frame. When pose geometries are absent (mounted, ultra tier), this is
  // a no-op — those soldiers either have no merged leg mesh at all or
  // use the animated pivots directly.
  _applyLegPose(poseIdx) {
    if (!this._staticLegsMesh || !this._staticLegsPoseGeometries) return;
    if (poseIdx === this._lastLegPoseIdx) return;
    this._lastLegPoseIdx = poseIdx;
    this._staticLegsMesh.userData.poseIdx = poseIdx;
    this._staticLegsMesh.geometry = this._staticLegsPoseGeometries[poseIdx];
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

    if (this._isSword && this.weaponArm) {
      const p = 1 - this.attackAnimTimeLeft / SWORD_ATTACK_ANIM_DURATION;
      this._applySwordSlash(p);
      return;
    }

    const t = this.attackAnimTimeLeft / ATTACK_ANIM_DURATION;
    const thrust = Math.sin((1 - t) * Math.PI) * 0.35;
    this._applyWeaponThrust(thrust);
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

  dispose(scene) {
    scene.remove(this.group);
  }
}