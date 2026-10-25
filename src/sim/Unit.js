// Groups soldiers into a formation. Holds formation-level facing/orders and
// dynamically computes formation shape (rows/cols) from a target width during
// drag orders. isUndead is a unit-level trait: the whole formation is either
// skeleton-bodied or not, never mixed.
//
// MARCHING FORMATION (moving block):
// A Unit marching to a destination (move order) or chasing an enemy unit
// (attack order) does not have its soldiers path independently straight to
// their final slots. Instead, `formationMarchOrigin` is a live anchor point
// that advances toward the order's destination every tick (see update()),
// and every soldier's formationSlot is recomputed each tick from that live
// anchor — so the whole shape (e.g. a 2x8 spear block) visibly travels
// together, elastically, rather than each soldier independently beelining
// its own final position.
//
// BREAK-OFF (discipline):
// Once the march anchor's distance to the order's ultimate target (the
// destination for a move order, the enemy unit's center for an attack
// order) is within a soldier's unitTypeDef.breakoffRange, that INDIVIDUAL
// soldier is released from block-following: marchReleased[soldier.id] is
// set true, and downstream systems (MovementSystem/TargetingSystem) treat
// it as free to walk its own remaining distance / chase its own personal
// target instead of the shared slot. Higher discipline (shorter
// breakoffRange) holds the block together longer.

// Formation grid spacing. Wider than the collision minimum separation
// (0.5) so same-unit soldiers don't sit right at the collision push
// threshold, and loose enough that a yielding soldier has real room to
// slide past a neighbour. Anything above ~0.75 puts the gap between two
// facing front ranks close to CombatConfig.engagementRange (1.6), so
// 0.7 is the practical ceiling before formation-vs-formation distance
// starts mattering for engagement detection.
const SOLDIER_SPACING = 0.7;

// Settle-in tolerance step. After a move/attack order clears, each tick
// the unit's effective slot tolerance grows by this amount, until every
// slot-follower has stopped moving. The growth is what removes the
// residual fidget where a soldier at rest inside the tolerance band is
// nudged by collision and walks back to its attempt target — the band
// grows until the whole formation is still, then freezes. Reset to 0 on
// any new order.
//
// Read by Unit.update's settle block (which owns the ramp state) and by
// MovementSystem's slot-walk decision (which adds the ramp to the
// soldier's discipline base tolerance).
const SETTLE_TOLERANCE_STEP = 0.1;

// Hard ceiling on how fast the live marching anchor closes the distance to
// its destination, in world-units/second. The actual per-tick anchor speed
// is the MINIMUM of this value and the slowest slot-following soldier's
// walk speed (see _computeAnchorSpeed) — the anchor must never advance
// faster than the soldiers converging on it, or the formation slots race
// ahead of the block. Set close to typical infantry walk speed so a fresh,
// un-fatigued unit still marches at the intended block pace. Tune here if
// formations look like they're being dragged too fast/slow toward their
// destination relative to how quickly soldiers close the gap to their
// slot.
const MARCH_ANCHOR_SPEED = 1.3;

// Safety margin (world units) kept INSIDE a ranged unit's max range when
// computing the focus-target standoff — see Unit._focusTargetStandoff.
// The standoff is chosen so the shooter's FRONT rank halts at
// (maxRange - FOCUS_TARGET_STANDOFF_BUFFER) from the enemy's NEAREST
// soldier, i.e. the archers use essentially the whole envelope while
// leaving a small buffer against range-edge flicker (the enemy center
// drifting a fraction of a unit between the anchor's halt and the next
// firing tick) and minor formation-alignment error.
const FOCUS_TARGET_STANDOFF_BUFFER = 1.5;

// Elastic pull-back per the "soldiers allowed to lag/catch up slightly"
// design: the anchor is allowed to advance even if soldiers haven't fully
// caught up to their slots, keeping the block visually cohesive without
// being perfectly rigid (perfectly rigid would require the anchor to stall
// on the single slowest/most-blocked soldier, which risks the whole
// formation freezing behind one stuck soldier).

export class Unit {
  constructor({ id, teamId, formationFacing, isUndead }) {
    this.id = id;
    this.teamId = teamId;
    this.formationFacing = formationFacing;
    this.soldiers = [];
    this.orderTarget = null;
    this.hasActiveOrder = false;
    this.selected = false;
    this.isUndead = !!isUndead;

    // Set by a right-click "attack that unit" order. When non-null, the
    // unit is marching its formation block toward that enemy unit's LIVE
    // center (re-read every tick in update()) until soldiers individually
    // break off per their breakoffRange, at which point TargetingSystem's
    // existing focus-target chase behavior takes over for that soldier.
    // Cleared by any normal move / formation order.
    //
    // IMPORTANT: Unit.update() marches the formation anchor toward this
    // id. That is the correct meaning for a player attack order (the
    // block walks at the target), but it is WRONG for AI focus fire —
    // an AI archer should shoot at the focused unit from its standoff
    // position, not walk toward it. The AI uses aiFocusTargetUnitId
    // (below) instead.
    this.focusTargetUnitId = null;

    // AI-only focus: identical meaning to focusTargetUnitId for
    // TargetingSystem — every soldier in this unit prefers the nearest
    // soldier of this enemy unit as their target — but has NO movement
    // side effects. Unit.update() does not read this field, so setting
    // it does not shift the march anchor. Persisted across ordinary
    // move orders (issueMoveOrder clears focusTargetUnitId but leaves
    // aiFocusTargetUnitId intact), because AI focus fire and AI
    // repositioning are orthogonal concerns that were previously
    // fighting each other through the single focusTargetUnitId field.
    // Cleared by a player attack order (issueAttackOrder), which takes
    // precedence.
    this.aiFocusTargetUnitId = null;

    // Fire-at-will toggle. When false, this unit's ranged soldiers do not
    // fire at enemies on their own — the player has to select the unit and
    // click an enemy for it to shoot. An explicit attack order
    // (focusTargetUnitId set) overrides the hold: that is the click.
    // Read by RangedCombatSystem; toggled by the player via CommandBarView.
    // Meaningless for melee units, kept as a plain field so the check in
    // the ranged system stays a single boolean.
    this.fireAtWill = true;

    this.formationOrigin = { x: 0, z: 0 };
    this.currentWidthUnits = 0;

    // Persisted formation shape (column count). Set whenever the shape is
    // explicitly (re)computed — initial deployment (finalizeFormationOffsets)
    // or an explicit width-drag reshape (_recomputeShapeForWidth). A plain
    // move or attack order NEVER changes this — it only rotates the existing
    // shape to face the new direction. This is what makes a 2x8 "spear"
    // block stay a 2x8 spear when turned, instead of being re-flattened into
    // however many columns fit whatever width a move happened to imply.
    this.formationCols = 1;

    // --- Marching formation state ---
    // Live anchor the formation block marches from/around. Distinct from
    // formationOrigin (which downstream debug/HUD code reads as "the
    // ordered destination" — see PathLineView). formationMarchOrigin is
    // where the BLOCK actually currently is on its way there.
    this.formationMarchOrigin = { x: 0, z: 0 };
    // The ultimate target the anchor is advancing toward this order. For a
    // move order: a fixed {x, z}. For an attack order: null here — the
    // target is read live from the focus unit's center each tick instead,
    // since the enemy unit moves.
    this._marchDestination = null;
    // Per-soldier release state: Set of soldier ids that have broken off
    // from block-following (see class comment). Cleared on every new
    // move/attack order.
    this._marchReleased = new Set();

    // Average soldier-to-slot distance across slot-followers, measured
    // after each update(). Compared tick-over-tick by
    // _followersFallingBehind: if it GREW, the followers are losing ground
    // to their slots (standing in ranged/engaged state, collision push,
    // knockback — anything that stops them walking), and the anchor must
    // hold still so the slots stay reachable. Null until the first
    // measurement and on every fresh order (reset alongside _marchReleased
    // so a new order never gates on a stale measurement).
    this._followerSlotDist = null;

    // Shared flee direction for this unit. Lazily computed the first time
    // any soldier of this unit enters 'routing' or 'shattered' state — from
    // the unit's center away from the nearest enemy soldier — and cached
    // for the rest of the battle. All routing / shattered soldiers of this
    // unit read the same vector, so a broken formation flees coherently
    // in one direction instead of each soldier fleeing away from its own
    // nearest enemy and fanning the unit apart. See
    // Unit.getOrComputeFleeDirection.
    this._fleeDirection = null;

    // Settle-in state. After a move/attack order clears, the formation's
    // effective slot tolerance ramps up by SETTLE_TOLERANCE_STEP per
    // tick until every slot-follower has stopped moving, then freezes.
    // Reset by any new order. This is what kills the residual fidget
    // where a soldier at rest inside the tolerance band is nudged by
    // collision and walks back. Read by MovementSystem's slot-walk
    // decision.
    this._settleToleranceBonus = 0;
    this._settled = false;

    // Reference to the champion soldier in this unit, or null. Set by the
    // campaign battle builder when a champion's retinue is built. The sim
    // does not need to know it exists except as a fast lookup: "is this
    // unit's champion still alive?" reads championSoldier.isAlive().
    this.championSoldier = null;

    // Lateral formation spread factor. 1.0 = normal spacing; above 1.0 =
    // the formation has widened its ranks to open a corridor for a
    // friendly different-unit soldier passing through. Applied to the
    // formation-local x (lateral) component of each soldier's offset in
    // _applyFormationAt — the depth axis is untouched, so the unit opens
    // a corridor without advancing or recoiling.
    //
    // Written by MovementSystem._updateUnitSpread, which ramps it up
    // while the unit is being passed through and back to 1.0 once the
    // pass-through ends. Engaged units are excluded — a unit in melee
    // holds formation.
    this._spreadFactor = 1.0;
  }

  // Count of soldiers alive and not in 'routing' or 'shattered' state.
  // Used by BattleSimulation's per-tick soldier-power cache (champion XP
  // denominator) and by anything else that needs "effective fighters"
  // without re-deriving the predicate.
  getNonRoutingAliveCount() {
    let n = 0;
    for (const s of this.soldiers) {
      if (!s.isAlive()) continue;
      if (s.state === 'routing' || s.state === 'shattered') continue;
      n++;
    }
    return n;
  }

  addSoldier(soldier) {
    this.soldiers.push(soldier);
    if (this.soldiers.length === 1) {
      this.formationOrigin = { x: soldier.pos.x, z: soldier.pos.z };
      this.formationMarchOrigin = { x: soldier.pos.x, z: soldier.pos.z };
    }
  }

finalizeFormationOffsets(cols) {
    const spacing = this.getFormationSpacing();
    // Discipline clamp. The requested column count is a WISH — the
    // formation's discipline tier may override it. Low-discipline units
    // cannot be narrower than minFormationCols or shallower than
    // minFormationRows, and when the row floor applies, rows are
    // rebalanced so there is no stub back row. See
    // FormationGrid.constrainColsForDiscipline.
    const clampedCols = this._constrainFormationCols(cols);
    this.currentWidthUnits = clampedCols * spacing;
    this.formationCols = clampedCols;
    this._layoutGrid(clampedCols, spacing);
  }

_layoutGrid(cols, spacing, soldiers = this.soldiers) {
    const slots = FormationGrid.computeSlots(soldiers.length, cols, spacing);
    for (let i = 0; i < slots.length; i++) {
      soldiers[i].formationOffset = { x: slots[i].x, z: slots[i].z };
      soldiers[i].formationRank = slots[i].rank;
    }
    this._laidOutCount = soldiers.length;
  }

  getAliveSoldiers() {
    return this.soldiers.filter(s => s.isAlive());
  }

  // Grid spacing for this unit's formation. A unit type may declare
  // formationSpacing (e.g. cavalry, whose mounts are ~1.0 long and need
  // wider ranks); everything else uses the shared SOLDIER_SPACING.
  getFormationSpacing() {
    const typeDef = this.soldiers[0]?.unitTypeDef;
    return typeDef?.formationSpacing ?? SOLDIER_SPACING;
  }

// Called by TargetingSystem the tick a soldier of this unit first becomes
  // 'engaged' while the unit still believes it has an active march order.
  // Without this, soldiers who haven't personally arrived at their
  // formation slot yet stay marching (TargetingSystem's rally branch is
  // gated on !underOrder) even while their unit-mates are already fighting
  // — they walk past or around the fight toward a slot that no longer
  // matters, oblivious, until they physically arrive. Clearing the order
  // here makes contact itself the interrupt, same as a player's own order
  // would interrupt a march.
  interruptOrderForContact() {
    if (this.hasActiveOrder) {
      this.hasActiveOrder = false;
      this.orderTarget = null;
    }
  }

  isDefeated() {
    return this.getAliveSoldiers().length === 0;
  }

  getCenter() {
    const alive = this.getAliveSoldiers();
    if (alive.length === 0) return { x: 0, z: 0 };
    const sum = alive.reduce((acc, s) => ({ x: acc.x + s.pos.x, z: acc.z + s.pos.z }), { x: 0, z: 0 });
    return { x: sum.x / alive.length, z: sum.z / alive.length };
  }

  // Ranged power: a single number representing this unit's contribution
  // to the ranged duel. Zero for melee units. For ranged units, sums the
  // per-soldier output of every alive, non-routing soldier.
  //
  // The per-soldier figure is the SAME value UnitPower.compute uses for
  // its ranged axis (UnitPower.rangedPerSoldierOffense), so the team's
  // ranged-duel assessment and the AI's per-unit power score cannot
  // disagree about what a ranged unit is worth. That shared figure
  // already includes:
  //   - the cooldown-to-rate conversion (attacks per second), so the
  //     number is a DPS proxy rather than a per-volley count;
  //   - the to-hit modifier;
  //   - the race outgoing-damage multiplier (goblin archers ×0.6) — the
  //     previous inline formula omitted this, so a goblin archer read
  //     the same as a human one here while UnitPower correctly scored
  //     it lower;
  //   - the ranged-envelope scale: range reach, accuracy, and the
  //     RANGED_POWER_BASELINE calibration (see UnitPower.js).
  //
  // Routing and shattered soldiers are excluded — they don't fire (see
  // RangedCombatSystem's state filter), so counting them would inflate
  // the team's own ranged power and hide the exact situation the
  // archer-pressure flip check exists to detect. Same predicate as
  // TeamAI._effectiveCombatantCount, so the two reads agree.
  //
  // Deliberately a method, not a cached field: the underlying formula can
  // be extended later (fatigue scaling, shield-broken penalty, per-unit-
  // type multipliers) without touching any call site.
  getRangedPower() {
    const typeDef = this.soldiers[0]?.unitTypeDef;
    if (!typeDef || !isRanged(typeDef)) return 0;

    const perSoldier = UnitPower.rangedPerSoldierOffense(typeDef);
    if (perSoldier <= 0) return 0;

    let count = 0;
    for (const s of this.soldiers) {
      if (!s.isAlive()) continue;
      if (s.state === 'routing' || s.state === 'shattered') continue;
      count++;
    }
    return count * perSoldier;
  }

  // Dynamic power score for this unit. See src/sim/UnitPower.js for the
  // full formula, the input tables it reads, and the returned breakdown.
  //
  // Returns { total, melee, ranged, durability, moraleFactor,
  //           healthFactor, fatigueFactor, fighters, deployed }.
  //
  // `total` is comparable across unit types, races, and equipment because
  // every input is normalized through the same config/registry tables the
  // sim uses at combat time — a spearman at 80% HP and an archer at 80% HP
  // are scored on the same scale, so an AI behavior can compare them
  // directly without knowing anything about their type.
  //
  // Callers that only care about "how much damage can this unit put out"
  // can pass { includeDurability: false }; callers scoring a horse-archer
  // as a melee flanker can pass { includeRanged: false }.
  getPower(options = {}) {
    return UnitPower.compute(this, options);
  }

  // Shared flee direction for every routing / shattered soldier of this
  // unit. Computed lazily on first request — from the unit's current
  // center, away from the nearest enemy soldier on the field — and cached
  // for the rest of the battle. Subsequent routers of the same unit reuse
  // the same vector even if the battlefield geometry changes, so a broken
  // formation visibly runs as one body in one direction instead of each
  // soldier fleeing away from its own local nearest enemy and fanning out.
  //
  // Callers pass the full soldier list because Unit does not keep a
  // reference to enemy units — the caller (MovementSystem) already has it.
  getOrComputeFleeDirection(allSoldiers) {
    if (this._fleeDirection) return this._fleeDirection;

    const center = this.getCenter();
    let nearest = null;
    let nearestDistSq = Infinity;

    for (const other of allSoldiers) {
      if (other.teamId === this.teamId) continue;
      if (!other.isAlive()) continue;
      const dx = other.pos.x - center.x;
      const dz = other.pos.z - center.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < nearestDistSq) {
        nearestDistSq = dSq;
        nearest = other;
      }
    }

    if (!nearest) {
      this._fleeDirection = { x: 0, z: 1 };
      return this._fleeDirection;
    }

    const dx = center.x - nearest.pos.x;
    const dz = center.z - nearest.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 0.001) {
      this._fleeDirection = { x: 0, z: 1 };
    } else {
      this._fleeDirection = { x: dx / d, z: dz / d };
    }
    return this._fleeDirection;
  }

  // Per-tick update, called once per sim tick by BattleSimulation BEFORE
  // targeting/movement run. Advances the live marching anchor toward its
  // destination (fixed point for a move order, the focus unit's live
  // center for an attack order), recomputes every soldier's formationSlot
  // from the advanced anchor, and releases individual soldiers from
  // block-following once the anchor is within their breakoffRange of the
  // ultimate target.
  //
  // No-op (but still safe to call) when the unit has no active march: a
  // unit that has arrived (hasActiveOrder false, no focus target) simply
  // keeps its soldiers' formationSlot pinned at the current anchor, which
  // by then equals formationOrigin.
update(deltaSeconds, unitsById) {
    const alive = this.getAliveSoldiers();
    if (alive.length === 0) return;

    // Settle-in tolerance ramp. While an order (move or attack) is
    // active, the ramp is held at zero — a marching formation uses its
    // discipline base tolerance, which is what makes goblins trail
    // loosely during the march. Once the order clears, the ramp grows
    // per tick until every slot-follower is still, then freezes. If a
    // settled formation later gains a moving follower (a push beyond
    // the frozen tolerance, a fresh sub-formation after stop), the
    // ramp resumes so tolerance grows to cover it.
    //
    // The ramp is ALSO frozen while the formation is spread (see
    // _spreadFactor / MovementSystem._updateUnitSpread). Without this,
    // the ramp absorbs the spread: the formation's slots widen, a
    // soldier takes one step toward his new slot, the ramp sees the
    // movement and grows by 0.1 this tick, and after ~6 ticks the
    // accumulated bonus exceeds the remaining distance to the widened
    // slot — so the soldier stops short and the formation stays visually
    // unchanged despite its slots having moved. Freezing the ramp at 0
    // during spread lets the soldier actually walk the full distance
    // out to his widened slot; the ramp resumes normally once the
    // spread closes back to 1.0.
    //
    // Runs at the top of update() so the walk decision in
    // MovementSystem (which runs AFTER Unit.update in the sim tick)
    // sees this tick's tolerance value.
    const spreadActive = (this._spreadFactor ?? 1.0) > 1.0;
    if (this.hasActiveOrder || this.focusTargetUnitId || spreadActive) {
      this._settleToleranceBonus = 0;
      this._settled = false;
    } else {
      const followers = this._slotFollowers(alive);
      if (followers.length > 0) {
        let anyMoved = false;
        for (const s of followers) {
          if (s.movedThisTick) { anyMoved = true; break; }
        }
        if (!this._settled) {
          if (anyMoved) {
            this._settleToleranceBonus += SETTLE_TOLERANCE_STEP;
          } else {
            this._settled = true;
          }
        } else if (anyMoved) {
          // Settled but a follower started moving — un-settle and let
          // the ramp resume. Covers a soldier pushed beyond the frozen
          // tolerance and the post-stop re-formation.
          this._settled = false;
        }
      }
    }

    // Resolve this tick's ultimate target: fixed destination for a move
    // order, or the focus unit's LIVE center for an attack order (re-read
    // every tick since the enemy is moving too).
    let target = null;
    if (this.focusTargetUnitId && unitsById) {
      const focusUnit = unitsById.get(this.focusTargetUnitId);
      if (focusUnit && !focusUnit.isDefeated()) {
        const center = focusUnit.getCenter();
        const standoff = this._focusTargetStandoff(focusUnit);
        if (standoff > 0) {
          // Ranged unit: advance the anchor toward a standoff point in
          // front of the enemy instead of the enemy center. Without
          // this, the anchor keeps walking forward, every archer's
          // formationSlot moves with it, and MovementSystem's
          // _holdFormationSlot drags the archer forward even while it
          // is in 'ranged' state and shooting. Once the anchor is
          // within standoff distance the target stays null, so the
          // anchor (and every slot attached to it) holds position and
          // the archers shoot from where they are.
          const dx = this.formationMarchOrigin.x - center.x;
          const dz = this.formationMarchOrigin.z - center.z;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d > standoff) {
            target = {
              x: center.x + (dx / d) * standoff,
              z: center.z + (dz / d) * standoff
            };
          }
        } else {
          target = center;
        }
      }
    } else if (this._marchDestination) {
      target = this._marchDestination;
    }

    const preAnchorX = this.formationMarchOrigin.x;
    const preAnchorZ = this.formationMarchOrigin.z;
    const preCenter = this.getCenter();

    if (target) {
      // Self-regulating gate: advance the anchor only if the soldiers who
      // are supposed to be following their slots were NOT falling behind
      // last tick. Soldiers in states MovementSystem skips ('ranged',
      // 'engaged', 'staggered', 'knockedDown') or slowed by collision/
      // knockback lose ground while the anchor marches on — without this
      // gate their slots run away from them to the destination. When the
      // gate fires, slots hold still for a tick and the followers close
      // the gap; the anchor resumes the moment they stop falling behind.
      if (!this._followersFallingBehind(alive)) {
        const anchorSpeed = this._computeAnchorSpeed(alive);
        this._advanceMarchAnchor(target, deltaSeconds, anchorSpeed);
      }
      this._releaseSoldiersInBreakoffRange(alive, target);
    }

    this._applyFormationAt(this.formationMarchOrigin.x, this.formationMarchOrigin.z, this.formationFacing);

    // Record this tick's follower distance for next tick's gate. Measured
    // after _applyFormationAt so the stored value always corresponds to
    // the anchor position the comparison is made against.
    this._followerSlotDist = this._avgFollowerSlotDist(alive);

    if (target && Unit.DEBUG_WATCH_UNIT_IDS.has(this.id)) {
      const anchorDx = target.x - this.formationMarchOrigin.x;
      const anchorDz = target.z - this.formationMarchOrigin.z;
      const anchorDist = Math.sqrt(anchorDx * anchorDx + anchorDz * anchorDz);
      const anchorMoved = Math.sqrt(
        (this.formationMarchOrigin.x - preAnchorX) ** 2 +
        (this.formationMarchOrigin.z - preAnchorZ) ** 2
      );
      const centerMoved = Math.sqrt(
        (this.getCenter().x - preCenter.x) ** 2 +
        (this.getCenter().z - preCenter.z) ** 2
      );
      const stateCounts = {};
      for (const s of alive) {
        stateCounts[s.state] = (stateCounts[s.state] || 0) + 1;
      }
      const states = Object.entries(stateCounts).map(([k, v]) => `${k}=${v}`).join(',');
      const first = alive[0];
      const slotDx = first.formationSlot.x - first.pos.x;
      const slotDz = first.formationSlot.z - first.pos.z;
      const firstSlotDist = Math.sqrt(slotDx * slotDx + slotDz * slotDz);

      AIDebugLog.log('unitmove', 0,
        `unit=${this.id} alive=${alive.length} ` +
        `anchor=(${this.formationMarchOrigin.x.toFixed(2)},${this.formationMarchOrigin.z.toFixed(2)}) ` +
        `target=(${target.x.toFixed(2)},${target.z.toFixed(2)}) anchorDist=${anchorDist.toFixed(2)} ` +
        `anchorMovedThisTick=${anchorMoved.toFixed(3)} centerMovedThisTick=${centerMoved.toFixed(3)} ` +
        `followerSlotDist=${this._followerSlotDist !== null ? this._followerSlotDist.toFixed(3) : 'null'} ` +
        `hasOrder=${this.hasActiveOrder} ` +
        `firstSoldier pos=(${first.pos.x.toFixed(2)},${first.pos.z.toFixed(2)}) ` +
        `slot=(${first.formationSlot.x.toFixed(2)},${first.formationSlot.z.toFixed(2)}) slotDist=${firstSlotDist.toFixed(2)} ` +
        `states=[${states}]`);
    }
  }

  // Moves formationMarchOrigin a bounded step toward `target`. Elastic, not
  // rigid: the anchor advances at a fixed rate regardless of whether every
  // soldier has caught up to their current slot yet (soldiers who lag are
  // still pulled toward wherever the slot currently is by MovementSystem).
// Moves formationMarchOrigin a bounded step toward `target`. Elastic, not
  // rigid: the anchor advances regardless of whether every soldier has
  // caught up to their current slot yet (soldiers who lag are still pulled
  // toward wherever the slot currently is by MovementSystem) — but never
  // faster than `anchorSpeed`, which update() caps at the slowest
  // slot-following soldier's actual walk speed. That cap is what stops the
  // formation slots from visibly racing ahead of the soldiers chasing them.
  _advanceMarchAnchor(target, deltaSeconds, anchorSpeed) {
    const dx = target.x - this.formationMarchOrigin.x;
    const dz = target.z - this.formationMarchOrigin.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist <= 0.001) {
      this.formationMarchOrigin.x = target.x;
      this.formationMarchOrigin.z = target.z;
      return;
    }

    const step = Math.min(dist, anchorSpeed * deltaSeconds);
    this.formationMarchOrigin.x += (dx / dist) * step;
    this.formationMarchOrigin.z += (dz / dist) * step;
  }

  // Standoff distance (world units) the formation anchor halts at when
  // marching at a focus target. Melee units return 0 — they march all the
  // way to the enemy's center as before. Ranged units return a fraction
  // of their firing range (FOCUS_TARGET_STANDOFF_FRACTION), so the block
  // stops in front of the enemy and shoots from there instead of walking
  // into melee. See the focus-target branch of update() for how the value
  // is used.
  _focusTargetStandoff(focusUnit) {
    const typeDef = this.soldiers[0]?.unitTypeDef;
    if (!typeDef) return 0;
    if (!isRanged(typeDef)) return 0;

    const maxRange = getRangedRange(typeDef);
    if (maxRange <= 0) return 0;

    // update()'s standoff gate measures anchor-to-enemy-CENTER distance,
    // but the firing gate (RangedCombatSystem) and target-acquisition
    // gate (TargetingSystem) both measure soldier-to-SOLDIER distance.
    // The relationship between the two depends on BOTH formations' depth:
    //
    //   anchor ---- ourDepth ----> our front rank
    //          ... frontToFront ...
    //   enemy front rank <--- enemyDepth ---- enemy center
    //
    //   anchorToCenter = ourDepth + frontToFront + enemyDepth
    //
    // Setting frontToFront = maxRange - buffer and solving for
    // anchorToCenter gives the standoff below. The previous version
    // subtracted ourDepth and a fixed buffer from maxRange and ignored
    // enemy depth entirely, which placed the front rank several units
    // short of its own max range — a player right-clicking a deep enemy
    // formation saw the archers halt well inside their envelope and had
    // to close manually to get shots off.
    //
    // Both depths are re-derived per call from the current alive count
    // and persisted column count, so casualties that have already been
    // reflowed into a shorter formation are reflected without any extra
    // bookkeeping.
    const ourDepth = this._formationDepth();
    const enemyDepth = focusUnit ? focusUnit._formationDepth() : 0;

    const standoff =
      maxRange + ourDepth + enemyDepth - FOCUS_TARGET_STANDOFF_BUFFER;
    // Never return 0 or negative: update() treats a standoff of 0 as
    // "melee, march all the way to the enemy center", which is the exact
    // behaviour this method exists to prevent.
    return Math.max(1.0, standoff);
  }

  // Depth (world units) from the formation anchor to the front rank along
  // the formation's facing axis. Row 0 sits at the anchor; each successive
  // row adds one spacing step forward, so the front rank is (rows - 1) *
  // spacing ahead of the anchor. Rows are re-derived from the current
  // alive count so a reflowed (casualty-thinned) formation reports its
  // real depth rather than the deployed one.
  _formationDepth() {
    const alive = Math.max(1, this.getAliveSoldiers().length);
    const cols = Math.max(1, Math.min(this.formationCols || 1, alive));
    const rows = Math.ceil(alive / cols);
    const spacing = this.getFormationSpacing();
    return Math.max(0, rows - 1) * spacing;
  }

  // Constrains a desired column count against this unit's discipline
  // minimums. Delegates to FormationGrid.constrainColsForDiscipline —
  // the single source of truth for the clamp, including the stub check
  // that rejects an under-full back row (a 26-soldier unit at 12 cols
  // would end 12/12/2; the check rebalances to ceil(26/3) = 9, giving
  // 9/9/8).
  //
  // Called from every site that chooses a column count:
  // finalizeFormationOffsets (deployment), _recomputeShapeForWidth
  // (live reshape), and previewFormationSlots (drag ghost). One
  // function means the drag ghost and the accepted shape agree by
  // construction, and the FormationFactory deployment paths
  // (createGridUnit / createUnitWithCount) call the same helper
  // directly.
  _constrainFormationCols(desiredCols) {
    const typeDef = this.soldiers[0]?.unitTypeDef;
    const count = Math.max(1, this.getAliveSoldiers().length);
    return FormationGrid.constrainColsForDiscipline(
      desiredCols, count, typeDef, CombatConfig
    );
  }

// Speed cap for the live marching anchor, derived from the soldiers
  // themselves: the lowest effectiveMoveSpeed among alive soldiers still
  // following the block (not released per breakoffRange, not
  // routing/shattered — those don't chase slots), scaled by the same
  // global speed multiplier MovementSystem applies to every step. A
  // soldier walking straight at a slot that moves at most this fast can
  // only ever close the gap, never fall further behind it.
  //
  // MARCH_ANCHOR_SPEED remains as a hard ceiling so a fast, fresh unit
  // still marches at the intended block pace instead of being dragged by
  // its slowest member. If no soldier qualifies (all released, all
  // routers), the anchor falls back to the plain constant.
  _computeAnchorSpeed(aliveSoldiers) {
    let minSpeed = Infinity;
    let counted = 0;
    for (const s of aliveSoldiers) {
      if (s.state === 'routing' || s.state === 'shattered') continue;
      if (this._marchReleased.has(s.id)) continue;
      if (!(s.effectiveMoveSpeed > 0)) continue;
      if (s.effectiveMoveSpeed < minSpeed) minSpeed = s.effectiveMoveSpeed;
      counted++;
    }
    if (counted === 0 || !isFinite(minSpeed)) return MARCH_ANCHOR_SPEED;

    const scale = (CombatConfig.movement && CombatConfig.movement.globalSpeedScale) || 1;
    return Math.min(MARCH_ANCHOR_SPEED, minSpeed * scale);
  }

  // Soldiers who are expected to be ACTIVELY walking to their formation
  // slot this tick: alive, not released from block-following, and in a
  // state MovementSystem moves toward formationSlot ('idle' / 'marching').
  // Everyone else is driven by something other than their slot — engaged /
  // staggered / knockedDown hold melee, 'ranged' stands to shoot,
  // routing/shattered flee, impetuous chases a target — and must NOT count
  // toward the falling-behind measurement, or the anchor would freeze
  // every time archers stopped to volley or the front rank made contact.
  _slotFollowers(aliveSoldiers) {
    const followers = [];
    for (const s of aliveSoldiers) {
      if (this._marchReleased.has(s.id)) continue;
      if (s.state !== 'idle' && s.state !== 'marching') continue;
      followers.push(s);
    }
    return followers;
  }

  // Average soldier-to-slot distance across this unit's slot-followers.
  // Null when nobody is following (all released, all fighting, all
  // routing) — callers treat null as "no signal", never as "falling
  // behind".
  _avgFollowerSlotDist(aliveSoldiers) {
    const followers = this._slotFollowers(aliveSoldiers);
    if (followers.length === 0) return null;

    let sum = 0;
    for (const s of followers) {
      const dx = s.formationSlot.x - s.pos.x;
      const dz = s.formationSlot.z - s.pos.z;
      sum += Math.sqrt(dx * dx + dz * dz);
    }
    return sum / followers.length;
  }

  // True when the unit's slot-followers were, on average, FARTHER from
  // their slots at the last measurement than the one before — i.e. the
  // block is losing ground to its own anchor. The epsilon absorbs
  // float/measurement noise so a holding unit with settled soldiers does
  // not flap the gate on rounding dust.
  _followersFallingBehind(aliveSoldiers) {
    if (this._followerSlotDist === null || this._followerSlotDist === undefined) {
      return false;
    }
    const current = this._avgFollowerSlotDist(aliveSoldiers);
    if (current === null) return false;
    return current > this._followerSlotDist + 0.005;
  }

  // A soldier releases from block-following once the LIVE anchor-to-target
  // distance is within that soldier's own breakoffRange. Using the anchor's
  // distance to target (not each soldier's individual distance) means the
  // whole block breaks off together as it nears the destination/enemy,
  // rather than only the soldiers on the near side peeling off first.
  _releaseSoldiersInBreakoffRange(aliveSoldiers, target) {
    const dx = target.x - this.formationMarchOrigin.x;
    const dz = target.z - this.formationMarchOrigin.z;
    const anchorDist = Math.sqrt(dx * dx + dz * dz);

    for (const s of aliveSoldiers) {
      if (this._marchReleased.has(s.id)) continue;
      const range = s.unitTypeDef.breakoffRange ?? 6.0;
      if (anchorDist <= range) {
        this._marchReleased.add(s.id);
      }
    }
  }

  // Is this specific soldier still following the block, or has it broken
  // off to chase/walk individually? Consulted by MovementSystem (to decide
  // whether to target formationSlot vs. an individual target) and
  // TargetingSystem (to decide whether a focus-targeted soldier should
  // already be individually chasing). A soldier with no active march/attack
  // order at all is always considered released (nothing to follow).
  isMarchReleased(soldierId) {
    if (!this.hasActiveOrder && !this.focusTargetUnitId) return true;
    return this._marchReleased.has(soldierId);
  }

// Current order destination for this unit, or null when it has no
  // pending order. Used by the Ctrl-held order-destination reveal (see
  // main.js's render loop) to show where the unit was told to go — the
  // live target for an attack, the fixed destination for a move.
  //
  // Attack takes precedence over move because a right-click attack order
  // clears any move fields (see issueAttackOrder). Both cases read live
  // state rather than a cached snapshot, so the reveal stays accurate
  // while the unit is en route and while an attacked target moves.
  //
  // `unitsById` is required only to resolve an attack target's center;
  // a move-only call can pass undefined.
  //
  // Facing and width come from the unit's PERSISTENT formation state
  // (formationFacing, currentWidthUnits), not from whatever transient
  // width a drag may have previewed. This is the shape the unit will
  // actually form into at the destination.
  getOrderDestination(unitsById) {
    if (this.focusTargetUnitId && unitsById) {
      const focusUnit = unitsById.get(this.focusTargetUnitId);
      if (focusUnit && !focusUnit.isDefeated()) {
        const c = focusUnit.getCenter();
        return {
          x: c.x,
          z: c.z,
          facing: this.formationFacing,
          width: this.currentWidthUnits
        };
      }
    }
    // hasActiveOrder guard is required: interruptOrderForContact clears
    // hasActiveOrder but leaves _marchDestination set (deliberately —
    // nothing else reads it in that state), so testing _marchDestination
    // alone would show a stale destination for a unit whose march was
    // cancelled by contact.
    if (this.hasActiveOrder && this._marchDestination) {
      return {
        x: this._marchDestination.x,
        z: this._marchDestination.z,
        facing: this.formationFacing,
        width: this.currentWidthUnits
      };
    }
    return null;
  }

_recomputeShapeForWidth(widthUnits) {
    const spacing = this.getFormationSpacing();
    const alive = this.getAliveSoldiers();
    const count = alive.length;
    if (count === 0) return;

    // Desired column count from the requested world-unit width, then
    // clamped against this unit's discipline minimums. Low-discipline
    // units cannot be squeezed into a narrow column or a single-file
    // line; see CombatConfig.discipline and _constrainFormationCols.
    const desiredCols = Math.max(1, Math.round(widthUnits / spacing));
    const cols = this._constrainFormationCols(desiredCols);

    this._layoutGrid(cols, spacing, alive);

    this.currentWidthUnits = cols * spacing;
    this.formationCols = cols;
  }

  // Re-lays out every soldier's offset using the CURRENT formationCols —
  // same grid math as _recomputeShapeForWidth, but the column count is not
  // touched. Used by move/attack orders so a unit's shape (e.g. a 2x8 deep
  // spear column) survives being pointed in a new direction. Soldier count
  // can still change between calls (casualties), so this re-derives rows
  // from the alive count each time rather than caching row count too.
  // Local (formation-frame) offset of the shape's CENTER, given the
  // current formationCols and alive count. FormationGrid.computeSlots
  // lays slots out with the BACK row at local z = 0 and each successive
  // row one spacing further forward (positive z). Row 0 is the anchor
  // row, so the shape's center sits at z = (rows - 1) * spacing / 2.
  // Local x is symmetric around 0 (computeSlots centers each row
  // individually), so the x-component is always 0.
  //
  // Used by issueMoveOrder's facing-change anchor adjustment to keep the
  // formation's WORLD-SPACE center fixed when the facing changes. Without
  // it, rotating the facing swings the shape's center through a circle
  // around the anchor, forcing every soldier to walk in step with that
  // swing even on a rotate-in-place order.
  _shapeCenterLocalOffset() {
    const count = this.getAliveSoldiers().length;
    if (count === 0) return { x: 0, z: 0 };
    const spacing = this.getFormationSpacing();
    const cols = Math.max(1, Math.min(this.formationCols || 1, count));
    const rows = Math.ceil(count / cols);
    return { x: 0, z: (rows - 1) * spacing / 2 };
  }

  _applyExistingShape() {
    const spacing = this.getFormationSpacing();
    const alive = this.getAliveSoldiers();
    const count = alive.length;
    if (count === 0) return;

    const cols = Math.max(1, Math.min(this.formationCols, count));
    const slots = FormationGrid.computeSlots(count, cols, spacing);

    // Match soldiers to slots by WORLD position, not by local offset.
    //
    // The previous version matched by formationOffset, which meant a
    // soldier "kept his slot" across a facing change — but his slot's
    // world position rotates with the formation, so keeping the local
    // slot forces him to walk to a new world position. On a 180° turn of
    // a multi-row formation the west-end soldiers swapped world sides
    // with the east-end soldiers and walked straight through each other.
    //
    // World-position matching pairs each soldier with the new slot
    // nearest to where he already is, preserving world ordering: a
    // rotate-in-place leaves every soldier at his current position (with
    // a new local offset reflecting the new facing), and a translate-
    // and-rotate sends each soldier to the slot on his own world side.
    FormationReflow.assignByWorldPosition(
      alive, slots, this.formationMarchOrigin, this.formationFacing
    );

    this.currentWidthUnits = cols * spacing;
    this._laidOutCount = count;
  }

// Called once per tick by BattleSimulation before update(). Offsets were
  // previously only recomputed on orders, so casualties left holes in the
  // grid (a thin, off-centre front row) until the next order. When the
  // living count differs from the count the layout was built for, re-lay
  // out now so the smaller row ends up centered at the back.
reflowIfCasualties() {
    if (this._laidOutCount === undefined) return;
    const count = this.getAliveSoldiers().length;
    if (count === 0 || count === this._laidOutCount) return;

    // Reflow reassigns formation offsets by world position, which is
    // only correct while the formation is settled on its slots. During
    // a march or a charge, survivors are either converging on the
    // moving anchor or have broken off entirely — pairing them to
    // slots by world position walks them sideways to a slot on the
    // other side of the formation instead of continuing toward the
    // objective. The visible symptom is a charging cavalry unit that
    // reshuffles sideways every time an archer volley kills one of
    // its soldiers.
    //
    // Gate 1: an active move order means the anchor is advancing and
    // every slot is being recomputed from it each tick — a reflow here
    // would race the anchor and yank soldiers off their bearing.
    if (this.hasActiveOrder) return;

    // Gate 2: an attack order (focusTargetUnitId) marches the block at
    // the enemy's live center without ever setting hasActiveOrder, so
    // the check above does not cover a charge. This is the case the
    // cavalry reshuffle was actually coming from: the block is
    // approaching in formation, archers land kills, and every survivor
    // gets a new offset on the wrong side. TargetingSystem clears this
    // field the moment the target is defeated, so the gate lifts as
    // soon as the charge resolves.
    if (this.focusTargetUnitId) return;

    // Gate 3: any surviving soldier who has broken off from block-
    // following, or who has gone impetuous and is chasing a personal
    // target, is no longer near his slot — world-position matching
    // would pair him with the wrong one. Covers the window after the
    // order clears but before survivors have walked home and settled.
    for (const s of this.soldiers) {
      if (!s.isAlive()) continue;
      if (this._marchReleased.has(s.id)) return;
      if (s.state === 'impetuous') return;
    }

    this._applyExistingShape();
  }

  _applyFormationAt(originX, originZ, facing) {
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    // Lateral formation spread. 1.0 = normal spacing; above 1.0 = the
    // formation has widened its ranks to open a corridor for a friendly
    // different-unit soldier passing through (see
    // MovementSystem._updateUnitSpread). Only the local x-component is
    // scaled, so the formation's depth and front-line position are
    // unaffected — the unit opens a corridor without advancing or
    // recoiling.
    const spread = this._spreadFactor ?? 1.0;

    for (const s of this.getAliveSoldiers()) {
      const off = s.formationOffset;
      // Low-discipline soldiers stand off their slot by a persistent
      // per-soldier jitter (see Soldier.disciplineJitter). The jitter is
      // in the formation's LOCAL space, so the wobble rotates with the
      // formation — a goblin line turned 90° has the same irregular
      // silhouette, not a different one. High-discipline soldiers get a
      // zero jitter and keep a clean grid.
      //
      // Spread is applied on top of the jitter, so the corridor opens
      // from where soldiers already are regardless of how loosely the
      // formation was arranged.
      const jit = s.disciplineJitter;
      const localX = (off.x + jit.x) * spread;
      const localZ = off.z + jit.z;
      const rotatedX = localX * cos + localZ * sin;
      const rotatedZ = -localX * sin + localZ * cos;

      s.formationSlot = {
        x: originX + rotatedX,
        z: originZ + rotatedZ
      };
    }
  }

  // Move order shape/facing rule:
  // - Distance from the unit's current center to (x, z) is measured first.
  // - If the move is MORE than 5 units: the unit's facing updates to the
  //   resolved facing, and its EXISTING shape (formationCols) is rotated to
  //   point that way — a 2x8 spear stays a 2x8 spear, just turned. Shape is
  //   never resized here; only issueFormationOrder resizes.
  // - If the move is 5 units or less (a small nudge): formationFacing is
  //   left completely untouched — the unit keeps facing whatever direction
  //   it already faced.
  //
  // The unit does NOT teleport its formation to (x, z) immediately anymore.
  // formationMarchOrigin (the live block anchor) starts from wherever it
  // currently is and advances toward (x, z) over subsequent ticks via
  // update() — this is what makes the formation visibly travel as a block
  // instead of each soldier independently beelining its own final slot.
  // options.directMarch: when true, the live marching anchor is snapped to
  // the destination immediately instead of advancing over subsequent ticks.
  // That makes every soldier walk STRAIGHT to their final formation slot
  // rather than the whole block assembling into shape as it travels. Used
  // by the double-click move order path — see OrderDragController.
issueMoveOrder(x, z, facing, options = {}) {
    const directMarch = !!options.directMarch;
    // forceFacing: the caller (player formation drag) explicitly chose this
    // facing, so it must be honoured even for short moves. Without it, the
    // legacy distance rule below applies (facing only updates on moves > 5
    // units), which AI orders and plain clicks rely on.
    const forceFacing = !!options.forceFacing && facing !== undefined && facing !== null;
    const origin = this.getCenter();
    const dx = x - origin.x;
    const dz = z - origin.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // No-op guard. A move order whose destination is (essentially) the
    // unit's current center is not a move — it is a "stay here" order.
    // Multiple AI behaviors issue these every decision cycle:
    // LineBehavior._holdInPlace (defence stance), the healthy-hold branch
    // of _holdOrRetreatLine (retreat posture), ReserveBehavior's arrival
    // case, and plan-role 'hold'. Without this guard each of those ran
    // the full order path and called _clearEngagedState, which (a)
    // knocked archers out of 'ranged' state every 15 ticks, destroying
    // their rate of fire, and (b) produced the visible "single step"
    // jitter on units that were already at their slot.
    //
    // The threshold matches the collision minimum separation (0.5): any
    // displacement smaller than that is inside the soldiers' own
    // footprint and is not a meaningful relocation.
    //
    // FACING IS NOT PART OF THE GUARD. The previous version required
    // facing to be unchanged too, and that was the bug: hold orders
    // carry a facing derived from the formation's forward axis, which
    // rotates fractionally every decision cycle as units shuffle. So
    // facingDiff routinely exceeded the 0.05 threshold even at dist=0,
    // the guard missed, and the full order path ran anyway. Facing is
    // now applied in place without touching combat state.
    const NO_OP_DIST = 0.5;
    const NO_OP_FACING_RAD = 0.05;
    let facingDiff = 0;
    if (facing !== undefined) {
      let d = facing - this.formationFacing;
      d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      facingDiff = Math.abs(d);
    }

    // Same-order detection. When the unit already has an active march
    // order and this call requests essentially the same destination and
    // facing, do NOT run the full order path. Running it would re-anchor
    // the formation (snapping formationMarchOrigin back to the unit's
    // current center), recompute every soldier's formationSlot from the
    // new anchor, reset _marchReleased (un-releasing any soldier that
    // had broken off to chase individually), and — most damaging —
    // call _clearEngagedState, which force-ends any melee or ranged
    // state and hands the soldier a 12-tick disengage grace. For a
    // cavalry unit in melee that the AI re-targets every decision
    // cycle, that produces the visible stutter: fight, freeze 12 ticks,
    // re-engage, freeze again.
    //
    // The AI is the primary source of redundant orders (TeamAI._decide
    // re-derives each unit's destination every cycle and calls
    // issueMoveOrder unconditionally), but the same applies to a player
    // re-clicking the same destination. Absorbing the redundant order
    // here keeps both paths from thrashing the formation.
    //
    // Thresholds are generous on purpose: 1.5 world units covers a
    // slow-moving target's drift between decision cycles (15 ticks at
    // 15 Hz = 1 s), and 0.15 rad (~8.6°) covers the small facing
    // updates a rotating formation axis produces. A genuinely different
    // order (new destination, meaningfully different facing) still runs
    // the full path.
    const SAME_ORDER_DIST = 1.5;
    const SAME_ORDER_FACING_RAD = 0.15;
    // Player-issued formation drags always set forceFacing. They must
    // never be absorbed by this AI-redundancy guard: the player
    // explicitly asked for a new formation, and silently discarding
    // the order (especially while paused, where no sim tick runs to
    // visibly catch up) reads as a bug. AI orders do not set
    // forceFacing, so they keep the redundant-order absorption.
    if (this.hasActiveOrder && this._marchDestination && !forceFacing) {
      const destDx = x - this._marchDestination.x;
      const destDz = z - this._marchDestination.z;
      const destDist = Math.sqrt(destDx * destDx + destDz * destDz);
      if (destDist < SAME_ORDER_DIST && facingDiff < SAME_ORDER_FACING_RAD) {
        // Refresh the destination so the anchor keeps tracking a moving
        // target, and update the recorded formationOrigin for HUD/debug
        // consistency. Nothing else is touched — anchor, slots, release
        // state, and combat state all continue uninterrupted.
        this._marchDestination = { x, z };
        this.formationOrigin = { x, z };
        return;
      }
    }

    const guardWouldFire = dist < NO_OP_DIST;

    // Debug: log small-distance orders that were NOT treated as no-ops,
    // so residual "single step" jitter can be traced back to its source
    // (which behavior, which unit, how much distance, whether the facing
    // was the deciding factor). Enable with the 'orders' category.
    if (!guardWouldFire && dist < 3.0) {
      AIDebugLog.log('orders', 0,
        `unit=${this.id} team=${this.teamId} small-step ` +
        `dist=${dist.toFixed(3)} facingDiff=${facingDiff.toFixed(3)} ` +
        `order=(${x.toFixed(2)},${z.toFixed(2)}) ` +
        `center=(${origin.x.toFixed(2)},${origin.z.toFixed(2)}) ` +
        `formationFacing=${this.formationFacing.toFixed(3)} ` +
        `orderFacing=${facing !== undefined ? facing.toFixed(3) : 'undef'}`);
    }

    if (guardWouldFire) {
      // Apply facing in place if it changed meaningfully — a hold order
      // that tracks a slowly-rotating formation axis should still update
      // the unit's facing, it just doesn't need to reset anything else.
      // A player-set facing is always applied, however small the change.
      const facingChanged = facing !== undefined &&
        (forceFacing || facingDiff >= NO_OP_FACING_RAD);
      if (facingChanged) {
        // Center-preserving anchor shift across the facing change.
        //
        // The anchor is the formation's BACK-row center (local z = 0);
        // the shape's actual center sits at local (0, (rows-1)*spacing/2)
        // and therefore rotates with the facing. Holding the anchor
        // fixed while the facing swings moves the shape's center through
        // a circle around the anchor — every soldier has to walk in step
        // with that swing even when the user only asked for a rotate-in-
        // place. Shifting the anchor by R(oldFacing)·c − R(newFacing)·c
        // cancels the swing, so the formation's world footprint stays
        // put and every soldier turns on his own axis.
        //
        // For a single-row formation the local center z is 0, the delta
        // is zero, and nothing moves — the anchor already sits at the
        // shape's center.
        //
        // The rotation formula (x·cosθ + z·sinθ, −x·sinθ + z·cosθ) is
        // the same one Unit._applyFormationAt uses, so the anchor shift
        // and the resulting slot positions agree by construction.
        const lc = this._shapeCenterLocalOffset();
        const oldFacing = this.formationFacing;
        const cosOld = Math.cos(oldFacing);
        const sinOld = Math.sin(oldFacing);
        const cosNew = Math.cos(facing);
        const sinNew = Math.sin(facing);
        const oldOffX = lc.x * cosOld + lc.z * sinOld;
        const oldOffZ = -lc.x * sinOld + lc.z * cosOld;
        const newOffX = lc.x * cosNew + lc.z * sinNew;
        const newOffZ = -lc.x * sinNew + lc.z * cosNew;
        this.formationMarchOrigin.x += oldOffX - newOffX;
        this.formationMarchOrigin.z += oldOffZ - newOffZ;
        this.formationFacing = facing;
      }
      // Cancel any stale march order so the unit actually stops where
      // it is, instead of continuing toward an earlier destination.
      if (this.hasActiveOrder) {
        this.hasActiveOrder = false;
        this.orderTarget = null;
        this._marchDestination = null;
      }

      // Do NOT unconditionally move the formation anchor to (x, z) here.
      // (x, z) is the unit's current center, which is computed from
      // soldier positions, which shift as soldiers walk toward their
      // slots, which moves the center next tick, which re-anchors the
      // origin, which re-computes slots, which makes the soldiers walk
      // again. That feedback loop was the source of the residual
      // "small step" jitter on units that are supposed to be holding
      // still.
      //
      // Only move the anchor if it has genuinely drifted.
      //
      // Threshold raised from 0.25 (0.5 units) to 9.0 (3 units). At 0.5
      // this test fired continuously for holding units whose soldiers
      // had not yet settled onto their slots: the unit's center lags
      // the anchor while soldiers are en route, so the drift check
      // always saw a gap, snapped the anchor to the center, moved the
      // slots, and made the soldiers walk again next tick — a self-
      // perpetuating loop that produced the visible tiny-step order
      // churn (the 'orders' small-step log entries).
      //
      // 3 units is large enough that only real displacement (collision
      // shove, casualty spread across the formation) triggers a snap.
      // The small residual mismatch between anchor and center while
      // soldiers are walking to their slots is now ignored, so slots
      // stay fixed and soldiers walk home to them exactly once.
      const anchorDx = x - this.formationMarchOrigin.x;
      const anchorDz = z - this.formationMarchOrigin.z;
      const anchorDistSq = anchorDx * anchorDx + anchorDz * anchorDz;

      if (anchorDistSq > 9.0) {
        AIDebugLog.log('orders', 0,
          `unit=${this.id} team=${this.teamId} hold-guard anchorSnap drift=${Math.sqrt(anchorDistSq).toFixed(3)} ` +
          `order=(${x.toFixed(2)},${z.toFixed(2)}) ` +
          `anchor=(${this.formationMarchOrigin.x.toFixed(2)},${this.formationMarchOrigin.z.toFixed(2)})`);
        this.formationOrigin = { x, z };
        this.formationMarchOrigin = { x, z };
      }
      // Always re-lay offsets so the current alive count is reflected —
      // casualties between calls otherwise leave stale offsets. This
      // does not move the anchor, so it does not feed the loop.
      this._applyExistingShape();
      // Crucially, do NOT call _clearEngagedState. That is the point.
      return;
    }

    this.orderTarget = { x, z };
    this.hasActiveOrder = true;
    this.focusTargetUnitId = null;
    this._marchDestination = { x, z };
    this._marchReleased = new Set();
    // Fresh measurement baseline for the falling-behind gate — a new order
    // re-anchored the block at the soldiers, so last order's distances are
    // meaningless for the gate.
    this._followerSlotDist = null;

    if (forceFacing) {
      // Player explicitly chose this facing (formation drag): honour it
      // for any move distance, including short repositions and in-place
      // rotations.
      this.formationFacing = facing;
    } else if (dist > 5) {
      const resolvedFacing = facing !== undefined ? facing : this._directionToward(x, z);
      this.formationFacing = resolvedFacing;
    }
    // else: formationFacing untouched — shape keeps its current orientation.

    this.formationOrigin = { x, z };

    // Re-anchor the live march origin at the unit's CURRENT center so the
    // formation slots reset back onto where the soldiers actually are,
    // not wherever the previous order's anchor was left. Without this, a
    // fresh order inherits a stale anchor (possibly already sitting at
    // the old destination) and every slot spawns far from its soldier,
    // who then has to chase it. Direct-march mode is exempt: it snaps
    // the anchor to the destination on purpose so soldiers beeline their
    // final slots.
    if (!directMarch) {
      this.formationMarchOrigin = { x: origin.x, z: origin.z };
    }

    // Direct-march (double-click) mode: snap the live anchor to the
    // destination immediately so update()'s _applyFormationAt() computes
    // every soldier's slot at its FINAL position on the very next tick.
    // Soldiers then walk straight to those slots instead of the formation
    // assembling around a slowly advancing anchor. Default behaviour is
    // untouched — the anchor keeps advancing over subsequent ticks.
    if (directMarch) {
      this.formationMarchOrigin = { x, z };
    }

    this._applyExistingShape();
    // Re-anchor at the best-fit position, NOT the unit centroid. The grid
    // offsets extend forward from the anchor, so anchoring at the centroid
    // shifts every slot forward by ~half the formation depth: each order
    // refresh made soldiers step INTO the enemy before following the anchor,
    // which defeated retreat orders. Computed after the shape/facing are
    // final so the slots land exactly under the soldiers.
    if (!directMarch) {
      this.formationMarchOrigin = this._bestFitAnchor();
    }
    this._clearEngagedState();
    // Slot positions are now driven each tick by update() from the live
    // formationMarchOrigin — no immediate _applyFormationAt(x, z, ...) here.
  }

  issueFormationOrder(x, z, facing, widthUnits, options = {}) {
    this._recomputeShapeForWidth(widthUnits);
    this.issueMoveOrder(x, z, facing, options);
  }

  // Right-click "attack that unit": focus the unit on a specific enemy
  // formation. The unit marches its formation block toward the enemy
  // unit's LIVE center (tracked every tick in update()) — soldiers stay in
  // their rotated shape until individually released per breakoffRange, at
  // which point TargetingSystem's existing per-soldier chase behavior
  // takes over. Cancels any active move order.
  //
  // Shape/facing rule: attack orders never resize the shape (no width is
  // ever given for an attack), but DO rotate the existing shape to face the
  // target immediately, one-time, at the moment the order is issued — same
  // "turn but don't flatten" behavior as a >5-unit move order.
  //
  // Does NOT call _clearEngagedState — engaged soldiers should stay in their
  // current melee rather than being force-detached.
// Right-click "attack that unit": focus the unit on a specific enemy
  // formation. The unit marches its formation block toward the enemy
  // unit's LIVE center (tracked every tick in update()) — soldiers stay in
  // their current shape until individually released per breakoffRange, at
  // which point TargetingSystem's existing per-soldier chase behavior
  // takes over. Cancels any active move order.
  //
  // Rotation-on-turn is disabled: formationFacing is left untouched here —
  // the block marches at the enemy's live position facing whatever
  // direction it already faced, it does not snap to face the target.
  //
  // Does NOT call _clearEngagedState — engaged soldiers should stay in their
  // current melee rather than being force-detached.
  issueAttackOrder(enemyUnit) {
    const newTargetId = enemyUnit ? enemyUnit.id : null;

    // Same-target short-circuit. Re-issuing an attack order on a target
    // that is already focused is redundant — the anchor is already
    // tracking that unit's live center each tick via update(), and
    // re-running the reset below would snap the march origin back to
    // the unit's current center and re-lay out slots, visibly stuttering
    // the formation while its soldiers are mid-turn. Skip entirely and
    // let the existing focus continue. A null target (clear the order)
    // falls through so the reset still happens.
    if (this.focusTargetUnitId === newTargetId && newTargetId !== null) {
      return;
    }

    this.focusTargetUnitId = newTargetId;
    this.hasActiveOrder = false;
    this.orderTarget = null;
    this._marchDestination = null;
    this._marchReleased = new Set();
    // Fresh measurement baseline for the falling-behind gate (see
    // issueMoveOrder).
    this._followerSlotDist = null;

    // Re-anchor the live march origin at the unit's current center (same
    // rationale as issueMoveOrder): the formation slots reset back onto
    // where the soldiers actually are, and the block starts marching at
    // the enemy from there — instead of inheriting a stale anchor from
    // the previous order and dragging slots across the map away from
    // their soldiers.
    const center = this.getCenter();
    this.formationMarchOrigin = { x: center.x, z: center.z };

    // formationFacing intentionally untouched — rotation-on-turn disabled.
    // formationMarchOrigin keeps advancing toward the (moving) enemy
    // center every tick via update() — no snap here.
  }

  // Deployment-time move: identical to issueMoveOrder (formation reset,
  // facing update, order cleared) but ALSO snaps every living soldier to its
  // newly-computed formationSlot this instant. Used by the deployment phase
  // so a player dragging a unit sees it teleport into its new formation
  // rather than walking there over the next few seconds.
  //
  // MovementSystem would normally interpolate toward formationSlot; during
  // deployment no systems run (see BattleSimulation.tick), so the snap is
  // what makes the order take effect at all. The march anchor is snapped
  // straight to the destination too, so a subsequent live battle tick
  // doesn't try to animate a "march" from the old deployment spot.
  issueInstantMoveOrder(x, z, facing) {
    this.issueMoveOrder(x, z, facing);
    this.formationMarchOrigin = { x, z };
    this._marchDestination = null;
    this.hasActiveOrder = false;
    this.orderTarget = null;

    const resolvedFacing = this.formationFacing;
    this._applyFormationAt(x, z, resolvedFacing);
    for (const s of this.getAliveSoldiers()) {
      s.pos.x = s.formationSlot.x;
      s.pos.z = s.formationSlot.z;
      s.facing = resolvedFacing;
      s.desiredFacing = resolvedFacing;
      s.moveFacing = resolvedFacing;
      s.currentSpeed = 0;
      s.movedThisTick = false;
    }
  }

  // Deployment-time version of issueFormationOrder: recomputes the formation
  // shape for the new width, then snaps soldiers into it. Used by the
  // deployment-phase formation drag, where the player is directly editing
  // the shape a unit will start the battle in.
  issueInstantFormationOrder(x, z, facing, widthUnits) {
    this._recomputeShapeForWidth(widthUnits);
    this.issueInstantMoveOrder(x, z, facing);
  }

previewFormationSlots(x, z, facing, widthUnits) {
    const spacing = this.getFormationSpacing();
    const alive = this.getAliveSoldiers();
    const count = alive.length;
    if (count === 0) return [];

    // Same discipline clamp the live reshape applies (see
    // _constrainFormationCols), so the drag ghost cannot show a shape
    // the unit will refuse to accept — the player sees the clamped
    // width while dragging, not an over-narrow preview that silently
    // widens on release.
    const desiredCols = Math.max(1, Math.round(widthUnits / spacing));
    const cols = this._constrainFormationCols(desiredCols);

    const cos = Math.cos(facing);
    const sin = Math.sin(facing);

    // Same wobble the live formation will apply. Uses the soldier's own
    // id when one sits at this slot index, so a preview of an unchanged
    // shape reproduces the live formation exactly; for a reshaped
    // preview the soldier-id hash still gives per-soldier noise rather
    // than a slot-index pattern. FormationReflow matches soldiers to
    // nearest slots on order issue, so the soldier at index i in `alive`
    // generally ends up near slot i — close enough that the ghost reads
    // as the same formation.
    const typeDef = this.soldiers[0]?.unitTypeDef;
    const discKey = typeDef?.discipline || 'normal';
    const discCfg = CombatConfig.discipline[discKey]
      || CombatConfig.discipline.normal;
    const amp = discCfg.formationJitterUnits || 0;

    const slots = FormationGrid.computeSlots(count, cols, spacing);
    return slots.map((s, i) => {
      let localX = s.x;
      let localZ = s.z;
      if (amp > 0) {
        const soldierId = alive[i] ? alive[i].id : (i + 1);
        const hx = hash32(soldierId);
        const hz = hash32((soldierId ^ 0x9E3779B9) >>> 0);
        const rx = (hx / 4294967295) * 2 - 1;
        const rz = (hz / 4294967295) * 2 - 1;
        localX += rx * amp;
        localZ += rz * amp;
      }
      return {
        x: x + localX * cos + localZ * sin,
        z: z + (-localX * sin + localZ * cos)
      };
    });
  }

  // Clears engaged/ranged/impetuous/staggered soldiers back to marching AND
  // grants a disengage grace period so TargetingSystem doesn't instantly
  // re-engage them with the adjacent enemy they were just pulled away from.
  //
  // 'ranged' MUST be in this list: an archer in fire-at-will mode was
  // previously left in place by a move order, because MovementSystem skips
  // ranged soldiers and TargetingSystem re-derived 'ranged' on the next tick.
  _clearEngagedState() {
    for (const s of this.getAliveSoldiers()) {
      if (s.state === 'engaged' || s.state === 'impetuous' || s.state === 'staggered') {
        s.state = 'marching';
        s.targetId = null;
        s.isImpetuous = false;
        s.disengageGraceTicksLeft = DISENGAGE_GRACE_TICKS;
      } else if (s.state === 'ranged') {
        // Ranged soldiers are not in melee, so the disengage grace —
        // whose job is to stop a soldier yanked out of a melee from
        // instantly re-engaging the adjacent enemy — has nothing to do
        // here. It was applied unconditionally though, and the cost was
        // severe: an archer ordered to reposition (a standoff
        // adjustment, a formation slot realignment, anything issuing a
        // move order) spent 12 of the next 15 ticks unable to acquire a
        // target, roughly cutting its effective fire rate to a fifth of
        // nominal. Clearing to 'marching' with no grace lets
        // TargetingSystem re-acquire the following tick.
        s.state = 'marching';
        s.targetId = null;
      }
    }
  }

  // Direction from the unit's CURRENT center to (x, z). Previously read
  // this.formationOrigin, which is the unit's PREVIOUS ordered destination
  // (set at the end of the last issueMoveOrder call) — so a second click's
  // facing was computed from the last destination rather than from where
  // the unit actually is, producing the "stupid direction on second click"
  // behaviour.
  _directionToward(x, z) {
    const center = this.getCenter();
    return Math.atan2(x - center.x, z - center.z);
  }

  // Anchor that makes the recomputed slots land on the soldiers' CURRENT
  // positions (least-squares over all living soldiers):
  //   slot_i = anchor + rotate(offset_i, facing)
  //   => anchor = pos_i - rotate(offset_i, facing), averaged.
  // Uses the current formationFacing and formationOffset values, so call it
  // after both are final for the order being issued.
  _bestFitAnchor() {
    const alive = this.getAliveSoldiers();
    if (alive.length === 0) {
      return { x: this.formationMarchOrigin.x, z: this.formationMarchOrigin.z };
    }
    const cos = Math.cos(this.formationFacing);
    const sin = Math.sin(this.formationFacing);
    let sumX = 0;
    let sumZ = 0;
    for (const s of alive) {
      const off = s.formationOffset;
      sumX += s.pos.x - (off.x * cos + off.z * sin);
      sumZ += s.pos.z - (-off.x * sin + off.z * cos);
    }
    return { x: sumX / alive.length, z: sumZ / alive.length };
  }

// Player-issued stop. Cancels any active move or attack order and reforms
  // the formation around the unit's CURRENT center — soldiers converge on
  // their slots at the frozen anchor rather than continuing toward an old
  // destination.
  //
  // Does NOT clear engaged/ranged/impetuous states. Stop is not a retreat:
  // a soldier already in melee keeps fighting. Only the march is cancelled.
  // TargetingSystem still re-acquires targets on the next tick for soldiers
  // who are free, so a stopped archer resumes fire-at-will (if fireAtWill
  // is on) as soon as TargetingSystem puts it back into 'ranged'.
  stopOrder() {
    // Clear every order field. After this, isMarchReleased() returns true
    // for every soldier (no active order, no focus target), and
    // MovementSystem falls through to the "walk to formationSlot" default.
    this.hasActiveOrder = false;
    this.orderTarget = null;
    this._marchDestination = null;
    this.focusTargetUnitId = null;
    this._marchReleased = new Set();

    // Reset the anchor to the best-fit position that reproduces the
    // soldiers' CURRENT positions when slots are recomputed from it.
    //
    //   slot_i   = anchor + rotate(offset_i, facing)
    //   => anchor = pos_i - rotate(offset_i, facing)
    //
    // Averaged over every living soldier, that expression is the
    // least-squares anchor: the position that, when slots are recomputed,
    // places each slot as close as possible to where its soldier actually
    // is. Two important properties:
    //
    //   1. A unit standing cleanly on its slots produces identical
    //      candidate anchors (one per soldier), and the mean is exactly
    //      the current anchor — zero drift, no visible step. This is what
    //      the previous "reset to unit center" version got wrong: the
    //      center of a grid formation sits BEHIND its anchor (rows stack
    //      backward, so the offset average has positive localZ), so
    //      centering the anchor shifted every slot backward and produced
    //      the one-step-twitch on an idle unit.
    //
    //   2. A unit with strays (collision push, a soldier mid-walk) lands
    //      the anchor in the middle of the formation. Slots end up near
    //      each soldier's current position; strays walk the short
    //      remainder. "Reform here" means around where the unit
    //      actually is, not around a stale pre-march anchor.
    const alive = this.getAliveSoldiers();
    if (alive.length === 0) return;

    const cos = Math.cos(this.formationFacing);
    const sin = Math.sin(this.formationFacing);

    let sumX = 0;
    let sumZ = 0;
    for (const s of alive) {
      const off = s.formationOffset;
      // rotate(offset, facing) — same formula as _applyFormationAt.
      const rotatedX = off.x * cos + off.z * sin;
      const rotatedZ = -off.x * sin + off.z * cos;
      sumX += s.pos.x - rotatedX;
      sumZ += s.pos.z - rotatedZ;
    }
    const anchorX = sumX / alive.length;
    const anchorZ = sumZ / alive.length;

    this.formationOrigin = { x: anchorX, z: anchorZ };
    this.formationMarchOrigin = { x: anchorX, z: anchorZ };

    // Recompute slots from the new anchor. Soldiers already on their slots
    // see their slot land back where they are (drift ≈ 0); anyone off-slot
    // walks the short remainder and then holds.
    this._applyFormationAt(anchorX, anchorZ, this.formationFacing);
  }

  clearOrderIfArrived(arrivalRadius) {
    if (!this.hasActiveOrder || !this.orderTarget) return;
    const center = this.getCenter();
    const dx = this.orderTarget.x - center.x;
    const dz = this.orderTarget.z - center.z;
    if (Math.sqrt(dx * dx + dz * dz) <= arrivalRadius) {
      this.hasActiveOrder = false;
      this.orderTarget = null;
      this._marchDestination = null;
    }
  }

}

// Imported lazily via module-level constant to avoid a circular import between
// Unit and CombatConfig at load time (Unit is foundational, config is data-only).
import { CombatConfig, WeaponMatchup } from '../config/CombatConfig.js';
import { isRanged, getRangedRange } from '../config/UnitClasses.js';
import { AIDebugLog } from '../ai/AIDebugLog.js';
import { hash32 } from './Soldier.js';
import { UnitPower } from './UnitPower.js';
import { FormationGrid } from './FormationGrid.js';
import { FormationReflow } from './FormationReflow.js';
const DISENGAGE_GRACE_TICKS = CombatConfig.disengage.graceTicks;

// Debug watch list. Add unit ids (e.g. 'red-archer-1') from the browser
// console to have Unit.update emit a 'unitmove' log line every tick that
// shows the formation anchor's movement, the destination, and the state
// histogram of the unit's living soldiers. Used to trace "unit is being
// issued move orders but isn't moving" cases.
//
//   import { Unit } from './src/sim/Unit.js';
//   Unit.DEBUG_WATCH_UNIT_IDS.add('red-archer-1');
Unit.DEBUG_WATCH_UNIT_IDS = new Set();