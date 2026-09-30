import * as THREE from 'three';
import { SoldierModelComposer } from './SoldierModelComposer.js';
import { SoldierMeshFactory } from './SoldierMeshFactory.js';
import { SelectionRingFactory } from './SelectionRingFactory.js';
import { ArrowArc } from './ArrowArc.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { isCavalry } from '../config/UnitClasses.js';

const ATTACK_ANIM_DURATION = 0.18;
const BLOCK_FLASH_DURATION = 0.22;
const DEATH_FALL_DURATION = 0.55;

// Sword pose and slash animation.
//
// REST POSE: blade held up beside the body, tilted slightly forward off
// vertical — a ready guard, not a parade-ground perpendicular. The blade
// points +Z in the sword's local frame; SWORD_REST_RAD maps that to a
// near-vertical direction via the weapon's rotation.x.
//
// SWING: a slashing attack is split between two joints, because a sword
// is held at the end of an arm — the swing is not a pure rotation of the
// blade around its own hilt.
//
//   weaponArm.rotation.x  — the shoulder. Rotates the hand (and the
//     sword it holds) through an arc, as if the arm were a rigid rod
//     from shoulder to hand. This is what makes the swing read as
//     "held by a person" rather than "the blade is doing a spin".
//   weapon.rotation.x     — the wrist. Adds blade rotation relative to
//     the hand, so the sword sweeps through a wider angle than the arm
//     alone would allow. Together the two produce a realistic arc:
//     shoulder carries the hand forward, wrist flips the blade over.
//
// The arm group wraps the sword and sits at the shoulder position (see
// SoldierModelComposer). Because the arm is parented under BODY, the
// body's yaw carries the swing — see _computeSwordTwist.
//
// SWORD_ARM_SWING_MAX is small (45° forward) so the arm's contribution
// reads as a real extension without the hand ending up over the head.
// SWORD_WRIST_SWING_MAX carries the blade through the rest of the arc,
// sweeping it from upright all the way to down-forward.
//
// Applies only to the sword's weapon+arm groups. The sim's attack
// cadence is driven by attackCooldownTicks, not by this duration — a
// slower animation just means the last slash may still be settling when
// the next event fires, which reads fine at battle zoom.
const SWORD_ATTACK_ANIM_DURATION = 0.30;
const SWORD_REST_RAD = -Math.PI / 2 + 0.20;
const SWORD_ARM_SWING_MAX = -Math.PI / 4;
const SWORD_WRIST_SWING_MAX = Math.PI;
const SWORD_STRIKE_FRACTION = 0.55;

// Maximum torso twist during a slash, in radians. The body rotates into
// the swing — right shoulder comes forward as the blade comes down — and
// returns to neutral on the recovery. Small: 0.25 rad ≈ 14° is enough
// to sell the follow-through without spinning the soldier away from the
// target it is still facing.
const SWORD_TWIST_MAX_RAD = 0.25;

// Skeleton walk cycle tuning.
//
// WALK_STRIDE_LENGTH — world distance travelled per full left-right leg
//   cycle. Cadence tracks actual ground speed, so a fast marcher's legs
//   swing fast and a slow one's swing slow.
// WALK_LEG_SWING_RAD — peak forward/back hip rotation, in radians.
//
// The remaining constants exist because soldier.pos updates on fixed
// sim ticks (10-20 Hz) while sync() runs every render frame (60 Hz).
// Reading per-frame position deltas as "speed" gives one big spike per
// tick and zero on the frames between — which reads as a jittery,
// shaking cadence. The fix is to smooth speed across frames (EMA) and
// advance the phase continuously by that smoothed speed, so the cycle
// is driven by a stable signal rather than a bursty one.
//
// WALK_SPEED_SMOOTHING  — EMA weight for new instantaneous speed samples.
//                         0.15 ≈ averages over ~7 frames (~0.11 s at 60 fps).
//                         Lower = smoother but laggier to speed changes.
// WALK_AMP_SMOOTHING    — EMA weight for swing amplitude target.
// WALK_MIN_SPEED        — below this smoothed speed, amplitude target is 0
//                         so legs settle to neutral instead of freezing
//                         mid-stride.
const WALK_STRIDE_LENGTH = 1.2;
const WALK_LEG_SWING_RAD = 0.55;
const WALK_SPEED_SMOOTHING = 0.15;
const WALK_AMP_SMOOTHING = 0.12;
const WALK_MIN_SPEED = 0.05;

// Knee-bend walk cycle. The leg is a two-piece joint (see LegBuilder): a hip
// holding the thigh, and a nested knee holding the shin. The walk cycle
// swings the hip fore/aft AND bends the knee backward so the shin trails the
// thigh — a proper two-jointed stride instead of a rigid pendulum.
//
// KNEE_BASE_RAD  — constant knee flex carried through the whole cycle.
//   Without it, the leg would snap straight at the two double-contact
//   moments and read as a stiff marionette. A small base keeps the leg
//   looking weighted at all times.
// KNEE_SWING_RAD — additional flex added on top of the base, on the
//   swing-phase leg only, at its peak. The two legs are half a cycle
//   apart: when one is at mid-swing (max flex, foot lifting) the other is
//   at mid-stance (base flex only, planted). Both knees flex the same
//   direction — backward — matching a human knee.
const KNEE_BASE_RAD = 0.10;
const KNEE_SWING_RAD = 0.80;

// Horse walk-cycle tuning. Shares the smoothed _walkSpeed signal with the
// rider (same ground speed) and the same smoothing constants, but has its
// own stride length and swing amplitude.
//
// HORSE_STRIDE_LENGTH — world distance per full front-back leg cycle.
//   Longer than the rider's stride, so the same ground speed produces a
//   slower, heavier cadence — which is what makes the horse read as a horse
//   rather than as a rider with four legs.
// HORSE_LEG_SWING_RAD  — peak forward/back rotation at the shoulder/hip.
const HORSE_STRIDE_LENGTH = 2.0;
const HORSE_LEG_SWING_RAD = 0.5;
// Rear legs swing slightly less than front legs and lag a little behind
// them in phase, so the gait reads as a horse trot rather than a mirrored
// puppet. Both are scale factors on the front-leg swing; 1.0 / 0 would
// reproduce a perfectly symmetric gait.
const HORSE_REAR_SWING_SCALE = 0.85;
const HORSE_REAR_PHASE_LAG = 0.35;
// Vertical body bob, in world units. A trotting horse rises once per
// diagonal pair — twice per stride cycle — so |sin(phase)| (which peaks
// twice per 2π) drives it. Both the mount and the rider move together;
// a bobbing mount with a static rider reads as the rider floating.
const HORSE_BOB_AMPLITUDE = 0.03;

// Mounted rider leg pose. The leg is built as a two-piece joint (see
// LegBuilder): a hip holding the thigh, and a nested knee holding the shin.
// Unmounted, the knee stays straight and the leg reads as a single piece —
// the walk cycle drives only the hip. Mounted, the thigh angles outward and
// the knee counter-rotates so the shin drops vertically, giving the classic
// L-shaped rider's leg over the barrel.
//
// The hip position is NOT slid outward: the top of the thigh must stay
// attached to the pelvis so the leg reads as coming from the body, not from
// thin air. The thigh's outward angle is what carries the knee out to the
// barrel's edge (world radius ~0.21 at mount scale); a hip slid out instead
// leaves a visible gap between the pelvis and the leg, which is exactly the
// disjointed look this pose is fixing.
//
// RIDER_THIGH_OUT_RAD — thigh outward tilt around Z, and the exact opposite
//   on the knee, so the shin returns to vertical. 1.05 rad ≈ 60° carries
//   the knee from hip X ±0.08 out to ±0.21 over a 0.15 thigh — a knee
//   landing right at the barrel's edge, with the shin dropping clear of it.
const RIDER_THIGH_OUT_RAD = 1.05;

// Wraps the THREE objects for one soldier and syncs them to sim state each frame.
//
// The static model shape (body + helmet + mount + shield + weapon) is built
// by SoldierModelComposer, which the thumbnail capture also uses. This class
// adds the per-instance pieces the thumbnail has no use for: the selection
// ring, the routing flag, the invisible pick proxy, and the unit-id tags the
// raycast path resolves hits through.
export class SoldierView {
  constructor(soldier, scene) {
    this.soldier = soldier;

    const model = SoldierModelComposer.compose(
      soldier.unitTypeDef,
      soldier.teamId,
      soldier.bodyVariant
    );
    this.group = model.group;
    this.rider = model.rider;
    this.body = model.body;
    this.shield = model.shield;
    this.weapon = model.weapon;
    this.weaponArm = model.weaponArm;
    this.horseBase = model.horseBase;

    // Tag the visible body with the owning unit so a raycast that lands on a
    // body mesh (rather than the pick proxy) still resolves. The proxy below
    // is the primary pick target — this is a fallback.
    this.body.userData.unitId = soldier.unitId;

    // Cache the shield's pristine material colour so sync() can tint it
    // toward black as shieldHp drops. Captured before any damage is applied.
    this._baseShieldColor = this.shield
      ? this.shield.material.color.clone()
      : null;

    this.selectionRing = SelectionRingFactory.createRing();
    this.group.add(this.selectionRing);

    // White flag shown above the soldier's head while routing. Lives in the
    // rider sub-group so it tracks the rider's raised position on cavalry.
    this.flag = SoldierMeshFactory.createWhiteFlag();
    this.flag.position.set(-0.18, 1.15, -0.1);
    this.flag.visible = false;
    this.rider.add(this.flag);

    // Invisible, generous raycast volume for click-picking. See
    // SoldierMeshFactory.createPickProxy — this is the ONLY thing the
    // raycast picks against, which is why clicks are so much more reliable.
    this.pickProxy = SoldierMeshFactory.createPickProxy(isCavalry(soldier.unitTypeDef));
    this.pickProxy.userData.unitId = soldier.unitId;
    this.group.add(this.pickProxy);

    scene.add(this.group);

    this.attackAnimTimeLeft = 0;
    this.blockFlashTimeLeft = 0;

    // 0..1 over DEATH_FALL_DURATION seconds after the soldier dies. Drives the
    // topple animation. Once at 1, the soldier is a corpse and stays rendered
    // on the ground — the group is never hidden.
    this.deathProgress = 0;

    // Bow aiming. `_isBow` selects the aim path in _applyWeaponPitch();
    // `_aimTarget` is the last point this archer fired at, fed in by
    // BattleRenderer on each 'fire' event. Null until the first shot, so the
    // bow starts level.
    this._isBow = soldier.unitTypeDef.weaponType === 'bow';
    this._isSword = soldier.unitTypeDef.weaponType === 'sword';
    this._aimTarget = null;

    this._baseColor = this.body.userData.baseMaterial.color.clone();

    // Skeleton walk-cycle state. Blob bodies leave legLeftPivot/legRightPivot
    // undefined on userData, so _applyWalkCycle is a no-op for them.
    //
    // _walkSpeed is an EMA of instantaneous (per-frame-distance / deltaTime)
    // speed. Because pos only changes on sim ticks, this smoothing is what
    // turns the tick-rate position steps into a continuous cadence signal.
    // _walkAmplitude fades swing in/out with speed so a stopping soldier
    // settles to neutral rather than freezing mid-swing.
    this._legLeftPivot = this.body.userData.legLeftPivot || null;
    this._legRightPivot = this.body.userData.legRightPivot || null;
    // Knee joints. Null on bodies built before the two-piece leg existed —
    // the mounted pose and the walk cycle both treat a missing knee as
    // "leave it straight", which is a no-op on the old geometry.
    this._legLeftKnee = this.body.userData.legLeftKnee || null;
    this._legRightKnee = this.body.userData.legRightKnee || null;
    this._walkPhase = 0;
    this._walkSpeed = 0;
    this._walkAmplitude = 0;
    this._prevWalkX = soldier.pos.x;
    this._prevWalkZ = soldier.pos.z;

    // Horse walk-cycle state. Null on foot units, so _applyHorseWalkCycle
    // is a no-op for them. The horse shares _walkSpeed with the rider — the
    // same smoothed ground-speed signal drives both cadences.
    this._horseLegs = (this.horseBase && this.horseBase.userData.horseLegs) || null;
    this._horsePhase = 0;
    this._horseAmplitude = 0;
  }

  // Called by BattleRenderer when a 'fire' event names this soldier as the
  // attacker. Records the target point so the bow can be pitched to the same
  // angle the arrow will leave at (see ArrowArc).
  setAimTarget(x, z) {
    this._aimTarget = { x, z };
  }

  triggerAttackAnim() {
    // Swords need a longer window for the raise-then-slash to read; every
    // other weapon uses the single-phase thrust duration.
    this.attackAnimTimeLeft = this._isSword
      ? SWORD_ATTACK_ANIM_DURATION
      : ATTACK_ANIM_DURATION;
  }

  triggerBlockFlash() {
    this.blockFlashTimeLeft = BLOCK_FLASH_DURATION;
  }

  sync(cameraPos, unitsById, deltaSeconds) {
    const s = this.soldier;

    // Advance the death topple. Dead soldiers are still rendered — they lie
    // on the ground as corpses — so this is the only place the death visual
    // is driven.
    if (s.state === 'dead') {
      this.deathProgress = Math.min(1, this.deathProgress + deltaSeconds / DEATH_FALL_DURATION);
    }

    this.group.visible = true;

    // Airborne throw: raised Y along a parabola over the airborne window.
    const airborneY = this._computeAirborneY(s);
    this.group.position.set(s.pos.x, airborneY, s.pos.z);

    // Rotation composition:
    //   - death:  fall backward around world X, reaching -90deg at full
    //   - throw:  one full tumble around world X over the airborne window
    //   - knocked down (and not airborne): lie on side via world Z
    let rotX = -Math.PI / 2 * this.deathProgress;
    if (s.airborneTicksLeft > 0 && s.airborneTotalTicks > 0) {
      const t = 1 - s.airborneTicksLeft / s.airborneTotalTicks;
      rotX += Math.PI * 2 * t;
    }
    this.group.rotation.x = rotX;
    this.group.rotation.z =
      (s.state === 'knockedDown' && s.airborneTicksLeft <= 0) ? Math.PI / 2 : 0;

    // Sword attacks twist the torso with the swing. The twist is written
    // to the body, which carries the sword arm — see SoldierModelComposer
    // for the parent chain. Non-sword units and un-swinging swordsmen get
    // twist = 0. _computeSwordTwist reads the CURRENT anim clock, so the
    // twist and the arm swing stay in lockstep.
    const twist = this._computeSwordTwist();
    this.body.rotation.y = s.facing + twist;
    // The sword is parented under the body, so the body's yaw already
    // carries it — its own rotation.y stays 0. Other weapons are parented
    // under the rider and need to pick up facing directly.
    this.weapon.rotation.y = this._isSword ? 0 : s.facing;
    this._applyWeaponPitch(s);
    this._applyAttackAnim(deltaSeconds);

    if (this.horseBase) {
      this.horseBase.rotation.y = s.facing;
    }

    if (this.shield) {
      const side = s.shieldSide === 'left' ? -0.28 : 0.28;
      // Off-hand rides the same yawed frame as the torso — a body twist
      // moves the shield with it, not past it.
      const shieldFacing = s.facing + twist;
      this.shield.position.set(
        Math.sin(shieldFacing + Math.PI / 2) * side,
        0.55,
        Math.cos(shieldFacing + Math.PI / 2) * side
      );
      this.shield.rotation.y = shieldFacing;
      this.shield.visible = s.hasShield;

      // Tint toward black proportional to damage taken. shieldHp = max →
      // pristine brown; shieldHp → 0 → nearly black, so the moment of break
      // is the visual culmination of a shield that already looked beaten-up.
      const shieldRatio = Math.max(0, Math.min(1, s.shieldHp / CombatConfig.shieldMaxHp));
      const tint = 0.15 + 0.85 * shieldRatio;
      this.shield.material.color.copy(this._baseShieldColor).multiplyScalar(tint);

      this._applyBlockFlash(deltaSeconds);
    }

    const hpRatio = Math.max(0, s.hp / s.maxHp);
    const bodyMat = this.body.userData.baseMaterial;
    // Corpses also darken with the topple progress, so the moment of death
    // reads distinctly even before the body hits the ground.
    const deathDim = 1 - 0.5 * this.deathProgress;
    bodyMat.color.copy(this._baseColor).multiplyScalar((0.4 + 0.6 * hpRatio) * deathDim);

    const unit = unitsById.get(s.unitId);
    this.selectionRing.visible = !!(unit && unit.selected) && s.state !== 'dead';

    this.flag.visible = s.isRouting;

    this._updateWalkSpeed(s, deltaSeconds);
    this._applyWalkCycle(s, deltaSeconds);
    this._applyHorseWalkCycle(s, deltaSeconds);
  }

  // Updates the smoothed walk speed from the per-frame position delta.
  // Called once per frame from sync() so both the rider's legs and (if
  // mounted) the horse's legs read the same speed signal.
  //
  // The soldier's pos updates on fixed sim ticks, not per render frame. A
  // direct per-frame delta would therefore spike once per tick and sit at
  // zero on the frames between — a visible shake at a beat equal to
  // (renderFps / simTickRate). An EMA over the raw per-frame speed smooths
  // those spikes into a continuous signal that cadence can be driven from.
  // dt is clamped so a hitch frame doesn't blow the sample up.
  _updateWalkSpeed(s, deltaSeconds) {
    const dx = s.pos.x - this._prevWalkX;
    const dz = s.pos.z - this._prevWalkZ;
    this._prevWalkX = s.pos.x;
    this._prevWalkZ = s.pos.z;

    const dt = deltaSeconds > 1e-4 ? deltaSeconds : 1e-4;
    const instantSpeed = Math.hypot(dx, dz) / dt;
    this._walkSpeed += (instantSpeed - this._walkSpeed) * WALK_SPEED_SMOOTHING;
  }

  // Skeleton rider walk cycle. Blob bodies have no hip pivots on userData,
  // so this is a no-op for them. Also a no-op when the soldier is mounted —
  // a rider is sitting, not walking, and the horse supplies the ground
  // contact instead.
  //
  // Phase advances continuously by smoothed speed × deltaSeconds, so cadence
  // decouples from sim-tick boundaries. Amplitude fades in/out with speed so
  // a stopping soldier settles to neutral rather than freezing mid-stride.
  // Swing is suppressed while dead, knocked down, or airborne — the whole
  // group is already rotating in those states and leg swing reads as noise.
  _applyWalkCycle(s, deltaSeconds) {
    if (!this._legLeftPivot || !this._legRightPivot) return;

    if (this.horseBase) {
      // Mounted: thigh angles outward from the pelvis and the knee folds
      // the shin back to vertical, giving an L-shaped rider leg. The hip
      // stays at its natural position (attached to the pelvis) — the
      // outward thigh angle alone carries the knee to the barrel's edge.
      // rotation.x is zeroed on both pivots so no residual walk pose
      // remains (defensive — no soldier dismounts today, but the branch is
      // idempotent).
      this._legLeftPivot.rotation.x = 0;
      this._legRightPivot.rotation.x = 0;
      this._legLeftPivot.rotation.z = -RIDER_THIGH_OUT_RAD;
      this._legRightPivot.rotation.z = RIDER_THIGH_OUT_RAD;

      // Knee counter-rotates by the same angle around Z, so the shin's
      // world orientation is vertical regardless of the thigh's tilt.
      // Missing knees (pre-two-piece geometry) simply skip — the leg then
      // stays straight, which is the previous look.
      if (this._legLeftKnee) {
        this._legLeftKnee.rotation.x = 0;
        this._legLeftKnee.rotation.z = RIDER_THIGH_OUT_RAD;
      }
      if (this._legRightKnee) {
        this._legRightKnee.rotation.x = 0;
        this._legRightKnee.rotation.z = -RIDER_THIGH_OUT_RAD;
      }
      return;
    }

    // Not mounted: clear the mounted straddle pose (hip Z) and the rider
    // knee counter-rotation (knee Z), so the walk cycle can drive a clean
    // fore/aft hip swing and a knee bend.
    this._legLeftPivot.rotation.z = 0;
    this._legRightPivot.rotation.z = 0;
    if (this._legLeftKnee) this._legLeftKnee.rotation.z = 0;
    if (this._legRightKnee) this._legRightKnee.rotation.z = 0;

    const dt = deltaSeconds > 1e-4 ? deltaSeconds : 1e-4;

    const grounded = s.state !== 'dead'
      && s.state !== 'knockedDown'
      && s.airborneTicksLeft <= 0;

    const targetAmp = (grounded && this._walkSpeed > WALK_MIN_SPEED)
      ? WALK_LEG_SWING_RAD
      : 0;
    this._walkAmplitude += (targetAmp - this._walkAmplitude) * WALK_AMP_SMOOTHING;

    this._walkPhase += (this._walkSpeed * dt / WALK_STRIDE_LENGTH) * Math.PI * 2;

    const p = this._walkPhase;

    // Amplitude scales the whole stride — hip swing and knee bend alike —
    // so an idle soldier's legs settle to a straight, vertical rest pose.
    const intensity = this._walkAmplitude / WALK_LEG_SWING_RAD;

    // Hip swing: the two legs are exactly out of phase.
    const swing = Math.sin(p) * this._walkAmplitude;
    this._legLeftPivot.rotation.x = swing;
    this._legRightPivot.rotation.x = -swing;

    // Knee bend: peaks on the swing-phase leg and relaxes to the base on
    // the stance-phase leg, so one knee folds and lifts its foot as the
    // leg comes forward while the other holds nearly straight under the
    // body's weight. The two legs are half a cycle apart: at p = π the
    // left is at mid-swing (max bend) and the right at mid-stance (base
    // only); at p = 0 the roles swap. Bend is always positive — the shin
    // trails the thigh, matching a human knee.
    const cosP = Math.cos(p);
    const kneeBase = KNEE_BASE_RAD * intensity;
    const kneeSwing = KNEE_SWING_RAD * intensity;
    const leftKnee = kneeBase + kneeSwing * Math.max(0, -cosP);
    const rightKnee = kneeBase + kneeSwing * Math.max(0, cosP);

    if (this._legLeftKnee) this._legLeftKnee.rotation.x = leftKnee;
    if (this._legRightKnee) this._legRightKnee.rotation.x = rightKnee;
  }

  // Horse walk cycle. Same pattern as _applyWalkCycle — smoothed speed,
  // continuous phase, amplitude fades with speed — but with a longer stride
  // (slower, heavier cadence for the same ground speed) and a four-leg
  // diagonal trot: front-left and back-right share a phase, front-right and
  // back-left are their opposites. Reads as a trotting horse at battle zoom
  // and costs nothing beyond the four rotations already here. No-op on foot
  // units (no _horseLegs).
  _applyHorseWalkCycle(s, deltaSeconds) {
    if (!this._horseLegs) return;

    const dt = deltaSeconds > 1e-4 ? deltaSeconds : 1e-4;

    const grounded = s.state !== 'dead'
      && s.state !== 'knockedDown'
      && s.airborneTicksLeft <= 0;

    const targetAmp = (grounded && this._walkSpeed > WALK_MIN_SPEED)
      ? HORSE_LEG_SWING_RAD
      : 0;
    this._horseAmplitude += (targetAmp - this._horseAmplitude) * WALK_AMP_SMOOTHING;

    this._horsePhase += (this._walkSpeed * dt / HORSE_STRIDE_LENGTH) * Math.PI * 2;

    const p = this._horsePhase;
    const amp = this._horseAmplitude;
    const legs = this._horseLegs;

    // Diagonal trot: FL and BR move together, FR and BL move together.
    // Rear legs swing slightly less and lag slightly behind their diagonal
    // partners — see HORSE_REAR_SWING_SCALE / HORSE_REAR_PHASE_LAG.
    const frontSwing = Math.sin(p) * amp;
    const rearSwing = Math.sin(p - HORSE_REAR_PHASE_LAG) * amp * HORSE_REAR_SWING_SCALE;

    legs.fl.rotation.x = frontSwing;
    legs.fr.rotation.x = -frontSwing;
    legs.br.rotation.x = rearSwing;
    legs.bl.rotation.x = -rearSwing;

    // Body bob: peaks twice per stride cycle (|sin| has a period of π), so
    // the horse rises on each diagonal pair. Scaled by gait intensity so
    // the mount settles flat when stopped and while dead / knocked down /
    // airborne. The rider moves with the mount — a bobbing horse under a
    // static rider reads as the rider floating off the saddle.
    const intensity = amp / HORSE_LEG_SWING_RAD;
    const bob = HORSE_BOB_AMPLITUDE * intensity * Math.abs(Math.sin(p));
    this.horseBase.position.y = bob;
    const riderBaseY = this.horseBase.userData.riderMountHeight ?? 0;
    this.rider.position.y = riderBaseY + bob;
  }

  // Parabola peak at the midpoint of the airborne window, scaled by the
  // throw's peak height. Zero when grounded.
  _computeAirborneY(s) {
    if (s.airborneTicksLeft <= 0) return 0;
    const total = s.airborneTotalTicks || 1;
    const t = 1 - s.airborneTicksLeft / total;
    return Math.sin(Math.PI * t) * (s.throwPeakHeight || 0);
  }

  _applyAttackAnim(deltaSeconds) {
    if (this.attackAnimTimeLeft <= 0) {
      this.weapon.userData.thrustOffset = 0;
      this._applyWeaponThrust(0);
      // No sword-specific reset needed: _applyWeaponPitch has already
      // written the raised rest pose to rotation.x this frame, before
      // this method ran. The sword pose returns to guard automatically
      // the instant the animation clock expires.
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

  // Sword slash pose. `p` is 0..1 progress through the animation.
  //
  // Two segments, since the blade already starts raised at rest (see
  // SWORD_REST_RAD) and needs no separate wind-up:
  //
  //   Down-swing (ease-in): arm extends and wrist flips the blade over.
  //     Ease-in reads as weight-driven — the cut gathers speed into impact
  //     rather than moving at a constant rate.
  //   Recovery (ease-out): both joints return to rest. Slower on purpose,
  //     so the sword settles into the guard rather than snapping back.
  //
  // Both joints are driven together over the same progress curve, so the
  // hand and blade stay in a coherent relationship throughout. The arm's
  // rotation carries the hand forward through an arc (shoulder pivot), and
  // the wrist's rotation adds the blade's own sweep — together producing
  // the two-joint motion of an arm-and-sword.
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

  // Torso twist for the current frame, in radians. Zero for anything that
  // is not currently mid-sword-slash. Peaks at the strike, releases on
  // the recovery — same timing shape as the arm swing, so body and blade
  // move as one.
  //
  // Read by sync() BEFORE _applyAttackAnim runs, using this frame's
  // still-current attackAnimTimeLeft. One frame of lag is imperceptible
  // at battle zoom.
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
    const basePos = this.weapon.userData.basePos || (this.weapon.userData.basePos = this.weapon.position.clone());
    this.weapon.position.set(basePos.x, basePos.y, basePos.z + thrustAmount);
  }

  // Pitch the weapon.
  //   - Bow: aim at the recorded fire target using the same parabola the
  //     arrow flies under (ArrowArc), so bow angle and arrow trajectory
  //     agree by construction. Level until the first shot is fired.
  //   - Everything else: sim-driven spear raise (a no-op that resets to 0
  //     for non-spear soldiers, since spearRaiseAmount is 0 on those).
  _applyWeaponPitch(s) {
    if (this._isBow) {
      if (!this._aimTarget) {
        this.weapon.rotation.x = 0;
        return;
      }
      const aim = ArrowArc.computeAim(s.pos.x, s.pos.z, this._aimTarget.x, this._aimTarget.z);
      this.weapon.rotation.x = -aim.pitch;
      return;
    }

    if (this._isSword) {
      // Base pose: blade held upright. The attack anim overrides this
      // while a slash is playing, then hands control back here once it
      // finishes, so a resting swordsman always snaps to the raised
      // guard.
      this.weapon.rotation.x = SWORD_REST_RAD;
      return;
    }

    const amount = s.spearRaiseAmount || 0;
    const maxRad = CombatConfig.spearHandling.fullRaiseRad;
    this.weapon.rotation.x = -amount * maxRad;
  }

  _applyBlockFlash(deltaSeconds) {
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