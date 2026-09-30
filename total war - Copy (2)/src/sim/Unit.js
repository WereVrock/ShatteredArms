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

// How fast the live marching anchor closes the distance to its destination,
// in world-units/second. Kept independent of any single soldier's move
// speed — the anchor is a formation-level abstraction, not a soldier — but
// set close to typical infantry walk speed so the block doesn't visibly
// outrun or lag far behind the soldiers actually converging on it. Tune
// here if formations look like they're being dragged too fast/slow toward
// their destination relative to how quickly soldiers close the gap to
// their slot.
const MARCH_ANCHOR_SPEED = 1.3;

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

    // Shared flee direction for this unit. Lazily computed the first time
    // any soldier of this unit enters 'routing' or 'shattered' state — from
    // the unit's center away from the nearest enemy soldier — and cached
    // for the rest of the battle. All routing / shattered soldiers of this
    // unit read the same vector, so a broken formation flees coherently
    // in one direction instead of each soldier fleeing away from its own
    // nearest enemy and fanning the unit apart. See
    // Unit.getOrComputeFleeDirection.
    this._fleeDirection = null;
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
    this.currentWidthUnits = cols * spacing;
    this.formationCols = cols;
    this._layoutGrid(cols, spacing);
  }

  _layoutGrid(cols, spacing) {
    const count = this.soldiers.length;
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const localX = (c - (cols - 1) / 2) * spacing;
      const localZ = r * spacing;
      this.soldiers[i].formationOffset = { x: localX, z: localZ };
    }
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
  // per-soldier output of every alive, non-routing soldier:
  //
  //   perSoldier = WeaponMatchup[weaponType].damage
  //              * (tickRateHz / rangedCooldownTicks)
  //
  // The cooldown-to-rate conversion (attacks per second) makes the figure
  // an actual DPS proxy rather than an arbitrary per-volley number, so a
  // slower-but-harder-hitting ranged unit added later (crossbow, slinger)
  // drops into the same comparison without rescaling.
  //
  // Routing and shattered soldiers are excluded — they don't fire (see
  // RangedCombatSystem's state filter), so counting them would inflate
  // the team's own ranged power and hide the exact situation the
  // archer-pressure flip check exists to detect. Same predicate as
  // TeamAI._effectiveCombatantCount, so the two reads agree.
  //
  // Deliberately a method, not a cached field: the formula can be
  // extended later (fatigue scaling, shield-broken penalty, per-unit-type
  // multipliers) without touching any call site.
  getRangedPower() {
    const typeDef = this.soldiers[0]?.unitTypeDef;
    if (!typeDef || !isRanged(typeDef)) return 0;
    const matchup = WeaponMatchup[typeDef.weaponType];
    if (!matchup) return 0;

    const attacksPerSecond = CombatConfig.tickRateHz / CombatConfig.rangedCooldownTicks;
    const perSoldier = matchup.damage * attacksPerSecond;

    let count = 0;
    for (const s of this.soldiers) {
      if (!s.isAlive()) continue;
      if (s.state === 'routing' || s.state === 'shattered') continue;
      count++;
    }
    return count * perSoldier;
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

    // Resolve this tick's ultimate target: fixed destination for a move
    // order, or the focus unit's LIVE center for an attack order (re-read
    // every tick since the enemy is moving too).
    let target = null;
    if (this.focusTargetUnitId && unitsById) {
      const focusUnit = unitsById.get(this.focusTargetUnitId);
      if (focusUnit && !focusUnit.isDefeated()) {
        target = focusUnit.getCenter();
      }
    } else if (this._marchDestination) {
      target = this._marchDestination;
    }

    const preAnchorX = this.formationMarchOrigin.x;
    const preAnchorZ = this.formationMarchOrigin.z;
    const preCenter = this.getCenter();

    if (target) {
      this._advanceMarchAnchor(target, deltaSeconds);
      this._releaseSoldiersInBreakoffRange(alive, target);
    }

    this._applyFormationAt(this.formationMarchOrigin.x, this.formationMarchOrigin.z, this.formationFacing);

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
  _advanceMarchAnchor(target, deltaSeconds) {
    const dx = target.x - this.formationMarchOrigin.x;
    const dz = target.z - this.formationMarchOrigin.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist <= 0.001) {
      this.formationMarchOrigin.x = target.x;
      this.formationMarchOrigin.z = target.z;
      return;
    }

    const step = Math.min(dist, MARCH_ANCHOR_SPEED * deltaSeconds);
    this.formationMarchOrigin.x += (dx / dist) * step;
    this.formationMarchOrigin.z += (dz / dist) * step;
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

_recomputeShapeForWidth(widthUnits) {
    const spacing = this.getFormationSpacing();
    const alive = this.getAliveSoldiers();
    const count = alive.length;
    if (count === 0) return;

    const desiredCols = Math.max(1, Math.round(widthUnits / spacing));
    const cols = Math.min(desiredCols, count);

    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const localX = (c - (cols - 1) / 2) * spacing;
      const localZ = r * spacing;
      alive[i].formationOffset = { x: localX, z: localZ };
    }

    this.currentWidthUnits = cols * spacing;
    this.formationCols = cols;
  }

  // Re-lays out every soldier's offset using the CURRENT formationCols —
  // same grid math as _recomputeShapeForWidth, but the column count is not
  // touched. Used by move/attack orders so a unit's shape (e.g. a 2x8 deep
  // spear column) survives being pointed in a new direction. Soldier count
  // can still change between calls (casualties), so this re-derives rows
  // from the alive count each time rather than caching row count too.
_applyExistingShape() {
    const spacing = this.getFormationSpacing();
    const alive = this.getAliveSoldiers();
    const count = alive.length;
    if (count === 0) return;

    const cols = Math.max(1, Math.min(this.formationCols, count));

    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const localX = (c - (cols - 1) / 2) * spacing;
      const localZ = r * spacing;
      alive[i].formationOffset = { x: localX, z: localZ };
    }

    this.currentWidthUnits = cols * spacing;
  }

  _applyFormationAt(originX, originZ, facing) {
    const cos = Math.cos(facing);
    const sin = Math.sin(facing);

    for (const s of this.getAliveSoldiers()) {
      const off = s.formationOffset;
      const rotatedX = off.x * cos + off.z * sin;
      const rotatedZ = -off.x * sin + off.z * cos;

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
      if (facing !== undefined && facingDiff >= NO_OP_FACING_RAD) {
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

    if (dist > 5) {
      const resolvedFacing = facing !== undefined ? facing : this._directionToward(x, z);
      this.formationFacing = resolvedFacing;
    }
    // else: formationFacing untouched — shape keeps its current orientation.

    this.formationOrigin = { x, z };

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
    this.focusTargetUnitId = enemyUnit ? enemyUnit.id : null;
    this.hasActiveOrder = false;
    this.orderTarget = null;
    this._marchDestination = null;
    this._marchReleased = new Set();

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

    const desiredCols = Math.max(1, Math.round(widthUnits / spacing));
    const cols = Math.min(desiredCols, count);

    const cos = Math.cos(facing);
    const sin = Math.sin(facing);
    const slots = [];

    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const localX = (c - (cols - 1) / 2) * spacing;
      const localZ = r * spacing;
      const rotatedX = localX * cos + localZ * sin;
      const rotatedZ = -localX * sin + localZ * cos;
      slots.push({ x: x + rotatedX, z: z + rotatedZ });
    }

    return slots;
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
import { isRanged } from '../config/UnitClasses.js';
import { AIDebugLog } from '../ai/AIDebugLog.js';
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