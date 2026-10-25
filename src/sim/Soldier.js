import { CombatConfig } from '../config/CombatConfig.js';
import { MoraleConfig } from '../config/MoraleConfig.js';
import { toSimSpeed } from '../config/SpeedScale.js';
import { raceOf } from '../config/RaceConfig.js';
import { isCavalry } from '../config/UnitClasses.js';

// Plain data object for one soldier. No behavior methods beyond simple accessors.

let nextId = 1;

// MurmurHash3 fmix32 — the 32-bit finalizer step from MurmurHash3.
// Fully avalanches the bits of a 32-bit integer: two adjacent inputs
// produce completely uncorrelated outputs, and any change to any input
// bit flips roughly half the output bits.
//
// Exported so other jitter sites (Unit.previewFormationSlots) can share
// the exact same function. A weaker hash — e.g. one multiply and a
// single xor-shift — leaves the high bits of the output varying roughly
// linearly with the input, which on a grid of soldiers laid out in
// sequential-id order produced a visible gradient or wave across the
// formation instead of the intended scatter.
//
// Math.imul keeps the multiplies in 32-bit integer space, which is what
// makes the function behave identically on every JS engine — a plain *
// would overflow into float and lose the low bits.
export function hash32(n) {
  n = n >>> 0;
  n ^= n >>> 16;
  n = Math.imul(n, 0x85ebca6b);
  n ^= n >>> 13;
  n = Math.imul(n, 0xc2b2ae35);
  n ^= n >>> 16;
  return n >>> 0;
}

export class Soldier {
  constructor({ unitId, teamId, unitTypeDef, x, z, facing, isUndead }) {
    this.id = nextId++;
    this.unitId = unitId;
    this.teamId = teamId;
    this.unitTypeDef = unitTypeDef;

    this.pos = { x, z };

    // `facing` is the soldier's ACTUAL current facing, and only ever
    // changes inside FacingSystem, gradually, at a bounded turn rate (see
    // CombatConfig.turning). Every other system that wants the soldier to
    // face something (engaged target, threat reaction, movement heading)
    // sets `desiredFacing` instead — FacingSystem is the single place that
    // reconciles the two. This split is what makes brace/flank mechanics
    // meaningful: nothing outside FacingSystem is allowed to snap `facing`
    // directly anymore.
    this.facing = facing;
    this.desiredFacing = facing;
    this.moveFacing = facing;

    this.formationSlot = { x, z };
    this.formationOffset = { x: 0, z: 0 };

    // Rank distance from the FRONT of the formation: 0 = front rank
    // (closest to the enemy in the unit's facing direction), 1 = one rank
    // behind it, and so on. Set by every formation layout pass
    // (Unit._layoutGrid / _applyExistingShape / _recomputeShapeForWidth)
    // whenever formationOffset is written.
    //
    // IMPORTANT: the layout loop's row index r runs 0..rows-1 with r=0 at
    // the formation anchor and rows extending FORWARD along +localZ (see
    // Unit._applyFormationAt). So the raw row index counts from the BACK.
    // Every writer stores the inverted value here, so consumers can rely
    // on 0 == front rank without re-deriving the direction.
    //
    // Read by SoldierView to give rear-rank lance-armed soldiers a higher
    // baseline raise so their lances do not clip through the rank in
    // front. Not read by any sim system — pure render-side hint.
    this.formationRank = 0;

    this.state = 'idle';
    this.targetId = null;
    // Transient contact target for passing attacks. Set each tick by
    // ContactAttackSystem while the soldier is walking (marching /
    // impetuous) and in melee contact with an enemy inside its forward
    // arc. Read by CombatResolutionSystem as the defender for that
    // soldier's attack this tick. Cleared the moment contact ends.
    // Distinct from targetId, which is the soldier's persistent
    // engagement target set by TargetingSystem and unaffected by
    // passing contacts.
    this.contactTargetId = null;
    // True once the soldier has landed the charge bonus on the CURRENT
    // passing contact. Reset by ContactAttackSystem whenever
    // contactTargetId changes. Passing attackers get one full charge
    // hit on first touch and normal melee attacks thereafter until
    // contact breaks — a cavalryman sweeping a formation lands one
    // momentum hit per enemy, not a repeated throw on the same man.
    this.contactChargeBonusSpent = false;
    // Logical state the soldier held when the current stagger landed.
    // Read by CombatResolutionSystem.update on stagger expiry so an
    // arrow-staggered soldier who was marching when hit returns to
    // marching rather than being forced into 'engaged', and so
    // Soldier.isInMelee can distinguish "staggered in melee" from
    // "staggered by an arrow across the field". Null when not currently
    // staggered.
    this.stateBeforeStagger = null;

    this.isImpetuous = false;
    this.rallyTargetId = null;

    // Undead is a race-level capability, not a per-call request. Races
    // with supportsUndead === false (currently only goblin) never carry
    // the flag, regardless of what the caller passed in. Resolved here,
    // BEFORE maxHp, because maxHp depends on it — skeletons take an extra
    // brittleness multiplier on top of the normal HP path.
    //
    // Enforced here rather than at each call site so a UI slip, a stale
    // save, or a future roster entry cannot produce a unit whose race has
    // no skeleton body. See RaceConfig.raceSupportsUndead.
    const raceAllowsUndead = raceOf(unitTypeDef).supportsUndead !== false;
    this.isUndead = raceAllowsUndead && !!isUndead;

    // HP path. Base from the unit type, scaled by the race's HP multiplier
    // (the type is a shared template; two races using the same type get
    // different HP). Undead soldiers then take a uniform brittleness
    // discount on top — see CombatConfig.skeleton.hpMultiplier. Floor of 1
    // so a heavily-multiplied unit never starts dead.
    const hpMult = raceOf(unitTypeDef).hpMultiplier ?? 1.0;
    let maxHp = unitTypeDef.baseHp * hpMult;
    if (this.isUndead) {
      maxHp *= CombatConfig.skeleton.hpMultiplier ?? 1.0;
    }
    this.maxHp = Math.max(1, Math.round(maxHp));
    this.hp = this.maxHp;

    this.hasShield = unitTypeDef.hasShield;
    this.shieldSide = unitTypeDef.shieldSide;
    this.shieldHp = unitTypeDef.hasShield ? CombatConfig.shieldMaxHp : 0;

    this.fatigue = 100;

    this.staggerTicksLeft = 0;
    this.knockedDownTicksLeft = 0;
    this.attackCooldownTicks = 0;
    this.disengageGraceTicksLeft = 0;

    this.knockbackVel = { x: 0, z: 0 };
    this.airborneTicksLeft = 0;
    this.airborneTotalTicks = 0;
    this.throwPeakHeight = 0;

    // Race morale ceiling. maxMorale is a new per-soldier field the race
    // can lower (goblins do); starting morale equals it, so a fresh unit
    // is at full strength relative to its own race rather than the
    // universal 100. MoraleSystem is responsible for clamping regen
    // against soldier.maxMorale rather than MoraleConfig.maxMorale
    // directly — see the note there for the field's contract.
    const moraleMult = raceOf(unitTypeDef).maxMoraleMultiplier ?? 1.0;
    this.maxMorale = Math.max(1, Math.round(MoraleConfig.maxMorale * moraleMult));
    // Fixed race-based ceiling, kept intact for the whole battle.
    // `maxMorale` above is mutable: MoraleSystem recomputes it each tick
    // from the unit's current casualty fraction, shrinking the ceiling
    // as the unit takes losses. Any code that needs the ORIGINAL cap
    // (race ceiling before casualties) reads baseMaxMorale; any code
    // that wants the CURRENT cap reads maxMorale.
    this.baseMaxMorale = this.maxMorale;
    this.morale = this.maxMorale;
    this.isRouting = false;
    this.justKilled = false;
    this.fleeDirection = { x: 0, z: 0 };

    // Number of distinct rout events this soldier has entered since the
    // battle began. Persists across rallies (a soldier who routs, rallies,
    // and routs again has routCountThisBattle === 2). Used by MoraleSystem
    // to decide whether a new rout becomes a shatter — 1st rout is normal,
    // 2nd rout is a 30/70 roll (rout/shatter), 3rd+ rout shatters
    // unconditionally. Reset per battle by construction (a fresh Soldier
    // is created for each battle).
    this.routCountThisBattle = 0;

    // Per-soldier kill counters, cumulative for the battle. Split into
    // two fields so the UI can report friendly-fire separately from
    // real kills — an archer whose stray arrow clips its own line is
    // not the same as an archer who is picking off the enemy.
    //
    // Melee combat can never produce a friendly-fire kill: an attacker
    // in 'engaged' state always targets an enemy soldier via targetId,
    // and CombatResolutionSystem has no code path that damages a
    // same-team soldier. Both melee and brace-counter kills therefore
    // increment killsThisBattle only.
    //
    // Ranged combat CAN produce friendly fire (see ProjectileSystem,
    // which sweeps every living soldier in the arrow's path including
    // friendlies from other units), so only ProjectileSystem._resolveHit
    // writes friendlyFireKillsThisBattle.
    //
    // A kill is credited to the shooter even if the shooter has since
    // died — the record is of what the soldier accomplished during the
    // battle, not a live-only score. Reset per battle by construction
    // (a fresh Soldier is created for each battle), like
    // routCountThisBattle.
    this.killsThisBattle = 0;
    this.friendlyFireKillsThisBattle = 0;

    // --- Champion / captain plumbing ---
    // The champion is a flag on the soldier, not a separate unit type.
    // The campaign battle builder sets isChampion on soldiers[0] of the
    // champion's retinue unit at battle-build time. combatMods is then
    // populated from the champion's unlocked skills. Any captain added
    // later uses the same shape.
    this.isChampion = false;
    // Bodyguard markers for the champion's retinue soldiers. Used by
    // Shoulder to Shoulder (per-living-bodyguard bonus) and Interpose
    // (redirect the champion's damage).
    this.isBodyguard = false;
    // combatMods shape is defined by ChampionSkills.computeCombatMods.
    // null when the soldier has no champion-style modifiers.
    this.combatMods = null;
    // Raw in-battle XP accumulated for this soldier. Read by the campaign
    // layer at battle end. Reset at battle start by construction.
    this.championXpRaw = 0;
    // Per-battle heal-on-kill accumulator (Blood Frenzy). Capped at
    // combatMods.healOnKillCap.
    this.championHealUsedThisBattle = 0;
    // Back-reference so a bodyguard can check whether the champion is
    // alive (Devoted). Set at unit build time on retinue bodyguards.
    this.championRef = null;
    // Devoted flag — a bodyguard with this set cannot enter routing while
    // its championRef is alive. Read in MoraleSystem.
    this.cannotRoutWhileChampionLives = false;
    // Shoulder to Shoulder marker — set on retinue bodyguards when the
    // champion has unlocked the node. Read in CombatResolutionSystem to
    // count living bodyguards and scale damage/to-hit.
    this.shoulderToShoulderActive = false;
    // Cached per-soldier power of this soldier's unit, refreshed once per
    // tick by BattleSimulation. Consumed by CombatResolutionSystem when
    // accruing champion combat XP. Values: unit power / non-routing alive
    // count; zero when the unit has no fighting soldiers.
    this.soldierPowerCache = 0;

    // Per-soldier ranged scatter multiplier. Default 1.0 (no change).
    // Levelled ranged units set this to a smaller value at battle build
    // time (see UnitXp.js and CampaignBattleBuilder.applyPlayerUnitLevels)
    // — RangedCombatSystem multiplies the archer's declared
    // `rangedAccuracy` by this on every shot, so a level 3 archer's
    // arrows land in a 0.81× scatter radius. Irrelevant for melee units;
    // stored anyway so a future non-standard unit type can carry it
    // without further Soldier changes.
    this.rangedAccuracyMult = 1.0;

    // --- Blood Thrall fields ---
    // Raised by the Blood Thrall champion skill from a dead enemy. Thralls
    // are half-statted, morale-immune, and expire after a fixed lifetime.
    // They spawn as soldiers of their own thrall unit (see
    // BloodThrallSystem). See CombatConfig.thrall.
    this.isThrall = false;
    // Absolute sim tick at which this thrall expires. Null on non-thralls.
    this.thrallExpiresAtTick = null;
    // Champion soldier this thrall was raised by. Thralls target the
    // nearest enemy to THIS soldier, not to themselves — matches the
    // skill's "hunts the champion's nearest enemy" contract. Null on
    // non-thralls.
    this.thrallChampionRef = null;
    // Skeleton type-id of the source soldier, kept for the render layer
    // (a thrall uses the source model, tinted). Null on non-thralls.
    this.thrallSourceTypeId = null;

    // --- Orphaned Mount fields ---
    // Set true on a beast whose rider died and rolled the champion's
    // Orphaned Mount skill. The beast is spawned as a NEW soldier in a
    // NEW unit (see BloodThrallSystem._spawnMount) with this flag set,
    // so SoldierModelComposer draws the mount alone — no rider body,
    // no shield, no weapon. The fresh mount keeps a championRef so its
    // kills can raise blood thralls, but is explicitly NOT a bodyguard:
    // no interpose, no shoulder-to-shoulder, no blood debt, no XP share.
    this.isRiderlessMount = false;

    // Set on the DYING BODYGUARD the instant an orphaned-mount roll
    // succeeds. SoldierView reads it to hide the mount that used to
    // carry the falling rider, so the corpse topples alone.
    this.hideMount = false;

    // --- Champion striker marking ---
    // Set of champion soldier ids this soldier has struck in melee. When
    // this soldier is later killed by one of those champions, the champion's
    // Blood Thrall skill raises at bloodThrallMarkedChance instead of the
    // base chance. Null until first use; lazily initialized.
    this.championStruck = null;

    // --- Blood Fury cooldown ---
    // Sim tick before which this soldier's Blood Fury blast may not fire
    // again. Only meaningful on champion soldiers that have unlocked the
    // skill. 0 = ready.
    this.bloodFuryCooldownUntil = 0;

    this.currentSpeed = 0;
    this.movedThisTick = false;

    // Set true by any system that moves this soldier by external force
    // — collision push, throw integration, anything that is not the
    // soldier's own walk. Read by MovementSystem at the start of the
    // soldier's next walk decision (then cleared), so the slot-walk
    // logic can distinguish "I chose to move" from "I was shoved".
    this.pushedSinceLastMovement = false;

    // Friendly-yield state. Set by MovementSystem when a soldier is
    // routing around a different-unit friendly. yieldTicksLeft > 0 means
    // the soldier is committed to the (yieldSideX, yieldSideZ) direction
    // for that many remaining ticks, ignoring small geometry changes that
    // would otherwise flip the side choice and produce jitter.
    this.yieldTicksLeft = 0;
    this.yieldSideX = 0;
    this.yieldSideZ = 0;
    // Last committed side, retained across commit cycles so a fresh
    // commit can prefer the same side (see sideStickyDot). Distinct from
    // yieldSideX/Z which are zeroed on a clean exit from yield.
    this.lastYieldSideX = 0;
    this.lastYieldSideZ = 0;

    // Spear-handling state. Updated by FacingSystem._updateSpearHandling
    // when a spear soldier needs to reorient. States:
    //   'lowered' | 'raising' | 'raised' | 'lowering'
    // Non-spear soldiers never leave 'lowered' and always have amount 0.
    this.spearRaiseState = 'lowered';
    this.spearRaiseTicksLeft = 0;
    // 0..1, purely for rendering the mesh tilt. FacingSystem is the only
    // writer.
    this.spearRaiseAmount = 0;

    // Body style is picked here, once per soldier, and read by
    // SoldierModelComposer at render time. Delegated to a resolver so
    // Soldier.setChampion can re-run it when the champion flag is set
    // after construction — see the campaign battle builder.
    this.bodyVariant = this._resolveBodyVariant();
  }

  // Resolves the render-only body model for this soldier. Order of
  // precedence, highest first:
  //
  //   undead         — an undead soldier is a skeleton regardless of
  //                    race or champion status.
  //   champion       — if the soldier is flagged isChampion and its unit
  //                    type declares championBodyVariant, that variant
  //                    wins. Used by the Goblin Warlord, a unique
  //                    character whose body differs from the rank-and-
  //                    file hobgoblin retinue it leads.
  //   type override  — a unit type may declare bodyVariant directly,
  //                    decoupling the rendered model from the sim-facing
  //                    race field (see the bodyVariant doc in
  //                    UnitTypes.js — hobgoblins use it).
  //   race default   — goblin for the goblin race, blob otherwise.
  //
  // Read by SoldierView and mirrored in UnitIconComposer, so a live
  // soldier and its army-bar icon can never disagree about which body
  // model the unit uses.
  _resolveBodyVariant() {
    // Riderless mount wins over every other variant: a beast without a
    // rider is the beast alone — not a skeleton, not a champion, not a
    // goblin. Checked first so a later setChampion/isUndead flag flip
    // cannot override it.
    if (this.isRiderlessMount) return 'riderlessBeast';
    if (this.isUndead) return 'skeleton';
    if (this.isChampion && this.unitTypeDef.championBodyVariant) {
      return this.unitTypeDef.championBodyVariant;
    }
    if (this.unitTypeDef.bodyVariant) return this.unitTypeDef.bodyVariant;
    if (this.unitTypeDef.race === 'goblin') return 'goblin';
    return 'blob';
  }

  // Marks this soldier as a champion (or clears the flag) and, when the
  // unit type declares a championBodyVariant, re-resolves the body model.
  // Called by the campaign battle builder when it post-processes a
  // formation's lead soldier into the champion — see
  // CampaignBattleBuilder.buildChampionUnit.
  //
  // Idempotent: setting the flag to its current value is a no-op, so a
  // repeated build does not thrash the body variant.
  setChampion(isChampion) {
    const next = !!isChampion;
    if (next === this.isChampion) return;
    this.isChampion = next;
    this.bodyVariant = this._resolveBodyVariant();
  }

// Marks this soldier as a riderless beast and re-resolves the body
  // model. Called by BloodThrallSystem._spawnMount at spawn time. Same
  // idempotency contract as setChampion — setting the flag to its
  // current value is a no-op.
  setRiderlessMount(isRiderless) {
    const next = !!isRiderless;
    if (next === this.isRiderlessMount) return;
    this.isRiderlessMount = next;
    this.bodyVariant = this._resolveBodyVariant();
  }

get effectiveMass() {
    const base = this.unitTypeDef.mass;
    let mass = this.isUndead ? base * CombatConfig.skeleton.massMult : base;
    // Blood Thralls are half-mass. Set by BloodThrallSystem._spawn at
    // raise time. Applied here rather than on the type so a raised thrall
    // does not mutate the shared unit-type definition.
    if (typeof this._thrallMassMultiplier === 'number') {
      mass *= this._thrallMassMultiplier;
    }
    return mass;
  }

  // Stagger length this soldier should receive when staggered. Base value
  // from CombatConfig.staggerDurationTicks, scaled by the smallest
  // per-class multiplier that applies to any of this soldier's
  // unitClasses (see CombatConfig.staggerDurationMultiplierByClass).
  // Archers get half — light troops recover faster. Falls back to the
  // base value when the unit declares no classes, no keyed class, or a
  // multiplier of exactly 1.0. Floored at 1 tick so a future heavily-
  // reduced class can never produce a zero-tick no-op stagger that sets
  // state but clears on the same tick.
  get staggerDurationTicks() {
    const base = CombatConfig.staggerDurationTicks;
    const classes = this.unitTypeDef.unitClasses;
    if (!classes || classes.length === 0) return base;
    const map = CombatConfig.staggerDurationMultiplierByClass;
    if (!map) return base;
    let mult = 1.0;
    for (const cls of classes) {
      const m = map[cls];
      if (m !== undefined && m < mult) mult = m;
    }
    if (mult === 1.0) return base;
    return Math.max(1, Math.round(base * mult));
  }

  get effectiveMoveSpeed() {
    const base = this.unitTypeDef.baseMoveSpeed;
    let speed = this.hasShield ? base * CombatConfig.shield.moveSpeedMult : base;
    // Spear movement malus. Stacked after the shield mult, so a shielded
    // spearman carries both penalties. Applies to skeletons as well — an
    // undead spear-holder is exactly as awkward with the shaft as a living
    // one. See CombatConfig.spearHandling.moveSpeedMult for tuning.
    if (this.unitTypeDef.weaponType === 'spear') {
      speed *= CombatConfig.spearHandling.moveSpeedMult;
    }
    // Race move-speed multiplier, applied LAST so it stacks on top of the
    // equipment penalties — a shielded goblin spearman would carry all
    // three. See RaceConfig.js for the per-race values.
    const raceMult = raceOf(this.unitTypeDef).moveSpeedMultiplier;
    if (raceMult !== 1.0) speed *= raceMult;
    // Undead shambling penalty. Foot skeletons move far slower than their
    // living counterparts; undead CAVALRY are exempt — a skeletal horse
    // still gallops. See CombatConfig.skeleton.moveSpeedMultiplier for the
    // tuning value and the exemption rationale.
    if (this.isUndead && !isCavalry(this.unitTypeDef)) {
      speed *= CombatConfig.skeleton.moveSpeedMultiplier;
    }
    return speed;
  }

  // Multiplier applied to every fatigue DRAIN this soldier incurs.
  // Race-level — a goblin (RaceConfig.goblin.fatigueDrainMultiplier 1.5)
  // tires 1.5x as fast as a human on every swing, block attempt, arrow
  // loosed, and walking tick. Does NOT affect regen: a goblin resting
  // recovers at the same per-tick rate as a human, it just has to rest
  // longer to make up for the faster drain.
  //
  // Read at every drain site — CombatResolutionSystem (attack and block
  // attempts), RangedCombatSystem (arrows loosed), and MovementSystem
  // (walking) — so a race tweak in RaceConfig propagates without
  // touching call sites.
  get fatigueDrainMultiplier() {
    // Per-type override wins over the race value. Used by hobgoblins,
    // which are goblin-race but tire at the normal rate.
    if (this.unitTypeDef.fatigueDrainMultiplier !== undefined) {
      return this.unitTypeDef.fatigueDrainMultiplier;
    }
    return raceOf(this.unitTypeDef).fatigueDrainMultiplier ?? 1.0;
  }

  // Persistent per-soldier formation offset, in the formation's LOCAL
  // space (x = lateral, z = forward). Low-discipline soldiers get a
  // non-zero offset, so their slots sit off the perfect grid — the
  // visible result is a wobbly, loosely-arranged line. High-discipline
  // troops keep a clean lattice.
  //
  // The offset is derived DETERMINISTICALLY from the soldier's id, so it
  // never changes during a battle. A static wobble reads as "undisciplined
  // formation"; a per-tick wobble would read as "glitchy".
  //
  // Applied at slot-computation time in Unit._applyFormationAt, NOT
  // written into formationOffset. The underlying grid — and every
  // consumer that reasons about it (reflow, anchor best-fit, order
  // centre) — is therefore unaffected by the jitter. Only the final
  // world slot the soldier walks to carries the offset.
  //
  // Amplitude comes from CombatConfig.discipline[typeDef.discipline]
  // .formationJitterUnits. Cached on first access.
  get disciplineJitter() {
    if (this._disciplineJitter !== undefined) return this._disciplineJitter;

    const disciplineKey = this.unitTypeDef.discipline || 'normal';
    const cfg = CombatConfig.discipline[disciplineKey]
      || CombatConfig.discipline.normal;
    const amp = cfg.formationJitterUnits || 0;

    if (!(amp > 0)) {
      this._disciplineJitter = { x: 0, z: 0 };
      return this._disciplineJitter;
    }

    // Two independent hashes of the soldier id, each mapped to
    // [-amp, +amp]. Math.imul keeps the multiply in 32-bit integer
    // space, so the hash behaves the same on every engine — a plain
    // multiply would overflow to float and lose low bits.
    const h1 = Math.imul(this.id, 2654435761) >>> 0;
    const h2 = Math.imul(this.id, 22695477) >>> 0;
    const rx = (((h1 ^ (h1 >>> 16)) >>> 0) / 4294967295) * 2 - 1;
    const rz = (((h2 ^ (h2 >>> 16)) >>> 0) / 4294967295) * 2 - 1;

    this._disciplineJitter = { x: rx * amp, z: rz * amp };
    return this._disciplineJitter;
  }

  // Distance from its formation slot at which this soldier considers
  // itself "arrived" and stops walking. High and normal discipline use a
  // near-zero tolerance, so their formations stay tight. Low discipline
  // accepts a large offset — this is what kills the jitter loop:
  // collision pushes the soldier off its slot, it accepts the new
  // position, and the walk-back that would re-create the overlap never
  // fires.
  //
  // Read by MovementSystem._moveToward (via the call site, which only
  // applies this tolerance when the target IS the formation slot) and by
  // MovementSystem._holdFormationSlot for ranged units.
  get slotArrivalTolerance() {
    const disciplineKey = this.unitTypeDef.discipline || 'normal';
    const cfg = CombatConfig.discipline[disciplineKey]
      || CombatConfig.discipline.normal;
    return cfg.slotToleranceUnits ?? 0.01;
  }

  // Personal target distance from the formation slot. The soldier walks
  // toward its slot and stops when it is within this distance, UNLESS
  // it was pushed while already within slotArrivalTolerance — see the
  // walk decision in MovementSystem.update.
  //
  // Deterministic per soldier: derived from the id via the same hash32
  // used for formationJitterUnits, so the same soldier always settles at
  // the same depth. Range is [0.01, slotAttemptUnits]. When the tier
  // declares slotAttemptUnits at or below 0.01 the range collapses to a
  // point and behaviour is identical to a fixed 0.01 tolerance.
  //
  // Cached on first access.
  get slotAttemptTarget() {
    if (this._slotAttemptTarget !== undefined) return this._slotAttemptTarget;

    const disciplineKey = this.unitTypeDef.discipline || 'normal';
    const cfg = CombatConfig.discipline[disciplineKey]
      || CombatConfig.discipline.normal;
    const upper = cfg.slotAttemptUnits ?? cfg.slotToleranceUnits ?? 0.01;

    if (!(upper > 0.01)) {
      this._slotAttemptTarget = 0.01;
      return this._slotAttemptTarget;
    }

    // Same avalanched hash the jitter uses, with a distinct salt so the
    // attempt target does not correlate with the jitter axis.
    const h = hash32((this.id ^ 0x5bd1e995) >>> 0);
    const r = h / 4294967295;
    this._slotAttemptTarget = 0.01 + r * (upper - 0.01);
    return this._slotAttemptTarget;
  }

  // Persistent per-soldier formation offset, in the formation's LOCAL
  // space (x = lateral, z = forward). Low-discipline soldiers get a
  // non-zero offset, so their slots sit off the perfect grid — the
  // visible result is a wobbly, loosely-arranged line, while high-
  // discipline troops keep a clean lattice. The offset is derived
  // deterministically from the soldier's id so it never changes during
  // a battle (a static wobble reads as "undisciplined formation"; a
  // per-tick wobble would read as "glitchy").
  //
  // Applied at slot-computation time in Unit._applyFormationAt, NOT
  // written into formationOffset. The underlying grid — and every
  // consumer that reasons about it (reflow, anchor best-fit, order
  // centre) — is therefore unaffected by the jitter. Only the final
  // world slot the soldier walks to carries the offset.
  //
  // Amplitude comes from CombatConfig.discipline[typeDef.discipline]
  // .formationJitterUnits. Cached on first access.
  get disciplineJitter() {
    if (this._disciplineJitter !== undefined) return this._disciplineJitter;

    const disciplineKey = this.unitTypeDef.discipline || 'normal';
    const cfg = CombatConfig.discipline[disciplineKey]
      || CombatConfig.discipline.normal;
    const amp = cfg.formationJitterUnits || 0;

    if (!(amp > 0)) {
      this._disciplineJitter = { x: 0, z: 0 };
      return this._disciplineJitter;
    }

    // Two independent avalanched hashes of the soldier id, each mapped
    // to [-amp, +amp]. See hash32 above for why the avalanche step
    // matters: the previous multiply-and-xor-shift hash left the high
    // bits of the output varying roughly linearly with the id, so a
    // formation laid out in sequential-id order showed a visible
    // gradient rather than noise.
    //
    // Two hashes, not one, because the two axes need to vary
    // independently — a single hash used for both would produce a 1-D
    // diagonal wobble, which reads as a wave, not scatter.
    const hx = hash32(this.id);
    const hz = hash32((this.id ^ 0x9E3779B9) >>> 0);
    const rx = (hx / 4294967295) * 2 - 1;
    const rz = (hz / 4294967295) * 2 - 1;

    this._disciplineJitter = { x: rx * amp, z: rz * amp };
    return this._disciplineJitter;
  }

  // Current turn rate in rad/sec, context-sensitive per CombatConfig.turning.
  // Charging takes priority over engaged (a charging soldier by definition
  // isn't in melee yet — currentSpeed >= speedThreshold and engaged are
  // mutually exclusive states in practice, but charging is checked first
  // for clarity of intent).
  get effectiveTurnRateRadPerSec() {
    const t = CombatConfig.turning;
    let rate = t.baseTurnRateRadPerSec;
    if (this.currentSpeed >= toSimSpeed(CombatConfig.charge.speedThreshold)) {
      rate *= t.chargingTurnRateMult;
    } else if (this.state === 'engaged') {
      rate *= t.engagedTurnRateMult;
    }
    // Spear-armed soldiers turn proportionally slower than their sword/
    // archer equivalents, in every state. Applied after state modifiers so
    // the relationship holds across states.
    if (this.unitTypeDef.weaponType === 'spear') {
      rate *= t.spearTurnRateMult;
    }
    return rate;
  }

  // Multiplier on this soldier's MELEE attack speed, derived from
  // current fatigue. 1.0 at full fatigue (no change), falling linearly
  // to CombatConfig.fatigue.minAttackSpeedMultiplierAtZeroFatigue at
  // zero. Applied in CombatResolutionSystem._resolveAttack on top of
  // the weapon's attackSpeedMultiplier (sword 1.2) and any champion
  // attackSpeedMult, so the two effects stack multiplicatively — an
  // exhausted swordsman is slower than a fresh one, but still faster
  // than an exhausted spearman.
  //
  // This is NOT the same as UnitPower's fatigueFactor. That term is a
  // SCORING estimate of a unit's reduced sustained output; this getter
  // is the actual per-attack cooldown the sim uses. The two are
  // deliberately separate so tuning one does not silently change the
  // other — the sim drives what happens, the score describes it.
  //
  // Read by CombatResolutionSystem._resolveAttack. Ranged attack speed
  // is not affected HERE: archer cadence is gated at the unit level
  // by RangedCombatSystem.volleyCooldownByUnit, and scales with unit-
  // average fatigue via RangedCombatSystem._volleyCooldownFor.
  get fatigueAttackSpeedMultiplier() {
    const f = CombatConfig.fatigue;
    const floor = f.minAttackSpeedMultiplierAtZeroFatigue ?? 1.0;
    if (floor >= 1.0) return 1.0;
    const t = Math.max(0, Math.min(1, this.fatigue / f.max));
    return floor + t * (1 - floor);
  }

  // True when this soldier is in physical melee contact with an enemy.
  //
  // 'engaged' is direct evidence. 'staggered' is ambiguous: a soldier
  // can be staggered by an arrow from a ranged unit twenty units away,
  // and treating that as "in melee" was causing cavalry to abort
  // charges and run to a flank slot the moment an archer volley landed
  // (see FlankerBehavior._decideCommitted and TeamAI._unitIsInCombat).
  // The disambiguation is stateBeforeStagger — the state the soldier
  // held when the stagger landed. A soldier staggered while 'engaged'
  // really is in melee; a soldier staggered while 'marching' or 'idle'
  // is not.
  isInMelee() {
    if (this.state === 'engaged') return true;
    if (this.state === 'staggered' && this.stateBeforeStagger === 'engaged') return true;
    return false;
  }

  isAlive() {
    // 'extracted' is a terminal non-alive state — a routing soldier that
    // fled past the map edge is removed from the battle exactly like a
    // corpse for all sim purposes (targeting skips them, units count them
    // as dead for isDefeated, battle-over check ignores them), but is
    // distinguishable from 'dead' so the campaign layer can read survivors
    // back out of the extraction record.
    return this.state !== 'dead' && this.state !== 'extracted';
  }
}