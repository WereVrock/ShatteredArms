// ===== UnitHistoryTracker.js =====
// Tracks ONE unit. Owned by a UnitHistoryRegistry, which holds one tracker
// per unit in the battle and feeds all of them every sim tick.
//
// Every event carries a `category` id (see CATEGORIES below) so the view
// can filter by kind. The category list is deliberately flat and small —
// each id corresponds to one visible filter chip in UnitHistoryView.
//
// Three event streams merged into one chronological log:
//
//   1. UNIT-LEVEL FIELD DIFFS (category 'unit'). Every tick, snapshots a
//      small set of unit-level fields and diffs against the previous
//      tick. Descriptors live in UnitHistoryFields.js.
//
//   2. PER-SOLDIER DIFFS. Every tick, each soldier is snapshotted and
//      diffed. Multiple soldiers changing the same kind of value in one
//      tick are merged into a single aggregated event with a per-soldier
//      list in the detail block.
//
//      Morale deltas carry a SOURCE BREAKDOWN when available, attached by
//      MoraleSystem while BattleSimulation.debugHistoryEnabled is true.
//
//   3. COMBAT-EVENT ENRICHMENT. Melee/ranged event arrays drained by the
//      sim are handed in each tick. They are not logged separately — the
//      tracker looks up matching events when attributing damage/death
//      and appends the cause.
//
// A ring buffer caps total events at MAX_EVENTS. When full, the oldest
// drops. The view caps rendered rows separately.

import { UNIT_FIELDS } from './UnitHistoryFields.js';

const MAX_EVENTS = 400;

const MORALE_EPSILON = 0.05;
const STAMINA_EPSILON = 0.5;

export class UnitHistoryTracker {
  constructor(unitId) {
    this._unitId = unitId;
    this._initialized = false;
    this._prev = null;
    this._soldierPrev = new Map();
    this._events = [];
    this._seq = 0;
  }

  update(frame, unit, meleeEvents, rangedEvents, allSoldiersById) {
    if (!unit || unit.id !== this._unitId) return;

    if (!this._initialized) {
      this._initialized = true;
      this._push(frame, {
        category: 'meta',
        label: 'Tracking started',
        change: unit.id,
        detail: 'History begins for this unit. Every change to its tracked '
          + 'unit-level fields AND every per-soldier event (damage, morale, '
          + 'stamina, kills, deaths, routing) is logged here, newest first. '
          + 'Logging continues even if the debug HUD is toggled off; it only '
          + 'stops at the end of the battle.'
      });
      this._prev = this._snapshotUnit(unit, unit.getAliveSoldiers());
      for (const s of unit.soldiers) {
        this._soldierPrev.set(s.id, this._snapshotSoldier(s));
      }
      return;
    }

    const alive = unit.getAliveSoldiers();

    // --- 1. Unit-level field diff (category 'unit') ---
    const cur = this._snapshotUnit(unit, alive);
    for (const field of UNIT_FIELDS) {
      const from = this._prev[field.key];
      const to = cur[field.key];
      const changed = field.changed ? field.changed(from, to) : from !== to;
      if (!changed) continue;
      this._push(frame, {
        category: 'unit',
        label: field.label,
        change: `${from} → ${to}`,
        detail: field.explain(from, to)
      });
    }
    this._prev = cur;

    // --- 2. Per-soldier diff ---
    this._diffSoldiers(frame, unit, meleeEvents || [], rangedEvents || [], allSoldiersById || null);
  }

  getEvents() {
    return this._events;
  }

  get unitId() {
    return this._unitId;
  }

  // --- unit-level helpers --------------------------------------------------

  _snapshotUnit(unit, alive) {
    const out = {};
    for (const field of UNIT_FIELDS) out[field.key] = field.snapshot(unit, alive);
    return out;
  }

  // --- per-soldier diff ----------------------------------------------------

  _snapshotSoldier(s) {
    return {
      alive: s.isAlive(),
      hp: s.hp,
      morale: s.morale,
      fatigue: s.fatigue,
      state: s.state,
      stateBeforeStagger: s.stateBeforeStagger,
      routing: s.isRouting,
      kills: s.killsThisBattle || 0,
      ffKills: s.friendlyFireKillsThisBattle || 0
    };
  }

  _diffSoldiers(frame, unit, meleeEvents, rangedEvents, allSoldiersById) {
    const acc = {
      deaths: [], extracted: [], damaged: [],
      moraleLost: [], moraleGained: [],
      staminaLost: [], staminaGained: [],
      routed: [], rallied: [],
      becameEngaged: [], leftMelee: [],
      kills: [], ffKills: []
    };

    for (const soldier of unit.soldiers) {
      const prev = this._soldierPrev.get(soldier.id);
      const isAlive = soldier.isAlive();
      const isExtracted = soldier.state === 'extracted';
      const typeName = (soldier.unitTypeDef && soldier.unitTypeDef.displayName) || '?';

      if (!prev) {
        this._soldierPrev.set(soldier.id, this._snapshotSoldier(soldier));
        continue;
      }

      if (!isAlive && prev.alive) {
        if (isExtracted) {
          acc.extracted.push({ id: soldier.id, type: typeName });
        } else {
          acc.deaths.push({
            id: soldier.id,
            type: typeName,
            cause: this._causeOfDeath(soldier.id, meleeEvents, rangedEvents, allSoldiersById)
          });
        }
        this._soldierPrev.set(soldier.id, this._snapshotSoldier(soldier));
        continue;
      }

      if (!isAlive) continue;

      if (soldier.hp < prev.hp) {
        acc.damaged.push({
          id: soldier.id,
          type: typeName,
          delta: prev.hp - soldier.hp,
          hpBefore: prev.hp,
          hpAfter: soldier.hp,
          cause: this._causeOfDamage(soldier.id, meleeEvents, rangedEvents, allSoldiersById)
        });
      }

      const moraleDelta = soldier.morale - prev.morale;
      if (moraleDelta < -MORALE_EPSILON) {
        acc.moraleLost.push({
          id: soldier.id,
          delta: moraleDelta,
          before: prev.morale,
          after: soldier.morale,
          breakdown: soldier.lastMoraleBreakdown || null
        });
      } else if (moraleDelta > MORALE_EPSILON) {
        acc.moraleGained.push({
          id: soldier.id,
          delta: moraleDelta,
          before: prev.morale,
          after: soldier.morale
        });
      }

      const fatigueDelta = soldier.fatigue - prev.fatigue;
      if (fatigueDelta < -STAMINA_EPSILON) {
        acc.staminaLost.push({ id: soldier.id, delta: fatigueDelta });
      } else if (fatigueDelta > STAMINA_EPSILON) {
        acc.staminaGained.push({ id: soldier.id, delta: fatigueDelta });
      }

      if (soldier.isRouting && !prev.routing) {
        acc.routed.push({ id: soldier.id, shattered: soldier.state === 'shattered' });
      } else if (!soldier.isRouting && prev.routing) {
        acc.rallied.push({ id: soldier.id });
      }

      const wasInMelee = prev.state === 'engaged'
        || (prev.state === 'staggered' && prev.stateBeforeStagger === 'engaged');
      const isInMelee = soldier.isInMelee();
      if (!wasInMelee && isInMelee) acc.becameEngaged.push({ id: soldier.id });
      else if (wasInMelee && !isInMelee) acc.leftMelee.push({ id: soldier.id });

      const kDelta = (soldier.killsThisBattle || 0) - (prev.kills || 0);
      if (kDelta > 0) acc.kills.push({ id: soldier.id, delta: kDelta });

      const ffDelta = (soldier.friendlyFireKillsThisBattle || 0) - (prev.ffKills || 0);
      if (ffDelta > 0) acc.ffKills.push({ id: soldier.id, delta: ffDelta });

      this._soldierPrev.set(soldier.id, this._snapshotSoldier(soldier));
    }

    this._emitStamina(frame, acc);
    this._emitMorale(frame, acc);
    this._emitMeleeTransitions(frame, acc);
    this._emitKills(frame, acc);
    this._emitDamage(frame, acc);
    this._emitRouts(frame, acc);
    this._emitCasualties(frame, acc);
    this._emitExtracted(frame, acc);
  }

  // --- emission helpers ----------------------------------------------------

  _emitStamina(frame, acc) {
    if (acc.staminaLost.length) {
      const total = acc.staminaLost.reduce((n, e) => n + e.delta, 0);
      this._push(frame, {
        category: 'stamina',
        label: 'Stamina drain',
        change: `${acc.staminaLost.length} soldier(s) · ${total.toFixed(1)} total`,
        detail: acc.staminaLost.map(e =>
          `Soldier #${e.id}: ${e.delta.toFixed(1)}`
        ).join('\n') + '\n\nWalking, attacking, blocking, and loosing arrows all '
          + 'drain stamina. Low stamina reduces block chance and attack accuracy.'
      });
    }
    if (acc.staminaGained.length) {
      const total = acc.staminaGained.reduce((n, e) => n + e.delta, 0);
      this._push(frame, {
        category: 'stamina',
        label: 'Stamina regen',
        change: `${acc.staminaGained.length} soldier(s) · +${total.toFixed(1)} total`,
        detail: acc.staminaGained.map(e =>
          `Soldier #${e.id}: +${e.delta.toFixed(1)}`
        ).join('\n') + '\n\nStamina regenerates only while a soldier is in '
          + "'idle' state AND did not move this tick."
      });
    }
  }

  _emitMorale(frame, acc) {
    if (acc.moraleLost.length) {
      const total = acc.moraleLost.reduce((n, e) => n + e.delta, 0);
      const lines = acc.moraleLost.map(e => {
        const head = `Soldier #${e.id}: ${e.delta.toFixed(1)} `
          + `(${e.before.toFixed(1)} → ${e.after.toFixed(1)})`;
        const bd = e.breakdown ? this._formatBreakdown(e.breakdown) : '';
        return bd ? `${head}\n  · sources: ${bd}` : head;
      });
      this._push(frame, {
        category: 'morale',
        label: 'Morale loss',
        change: `${acc.moraleLost.length} soldier(s) · ${total.toFixed(1)} total`,
        detail: lines.join('\n\n') + '\n\nMorale reaches 0 → the soldier breaks '
          + 'and starts routing. Sources come from MoraleSystem\'s per-tick '
          + 'breakdown and name exactly what drove the drop: regen (scaled '
          + 'linearly by the unit\'s casualty fraction, and frozen entirely '
          + 'for 5s after any soldier of the unit dies), hp (low-HP penalty), '
          + 'casualtyLoss (one-shot shock on a soldier dying this tick), '
          + 'outnumbered (local enemy:ally strength ratio), flanked (enemy '
          + 'in the flank arc), allyRout (nearby ally routing), enemyRout '
          + '(+bonus), kill (+bonus), adjacentWiped (friendly unit destroyed '
          + 'nearby). The unit\'s EFFECTIVE MAX MORALE also shrinks with '
          + 'cumulative losses — a battered unit cannot climb back to its '
          + 'pre-battle ceiling.'
      });
    }
    if (acc.moraleGained.length) {
      const total = acc.moraleGained.reduce((n, e) => n + e.delta, 0);
      this._push(frame, {
        category: 'morale',
        label: 'Morale recovery',
        change: `${acc.moraleGained.length} soldier(s) · +${total.toFixed(1)} total`,
        detail: acc.moraleGained.map(e =>
          `Soldier #${e.id}: +${e.delta.toFixed(1)} (${e.before.toFixed(1)} → ${e.after.toFixed(1)})`
        ).join('\n') + '\n\nMorale recovers out of combat (not engaged, not '
          + 'shooting), and from nearby enemy routs or kills credited to '
          + 'this soldier.'
      });
    }
  }

  _emitMeleeTransitions(frame, acc) {
    if (acc.becameEngaged.length) {
      this._push(frame, {
        category: 'melee',
        label: 'Entered melee',
        change: `${acc.becameEngaged.length} soldier(s)`,
        detail: acc.becameEngaged.map(e => `Soldier #${e.id}`).join('\n')
          + '\n\nSoldiers acquired an enemy within engagement range and '
          + 'transitioned to \'engaged\' state.'
      });
    }
    if (acc.leftMelee.length) {
      this._push(frame, {
        category: 'melee',
        label: 'Left melee',
        change: `${acc.leftMelee.length} soldier(s)`,
        detail: acc.leftMelee.map(e => `Soldier #${e.id}`).join('\n')
          + '\n\nEither the target died, the soldier was pulled away by an '
          + 'order, or the unit was issued a Stop.'
      });
    }
  }

  _emitKills(frame, acc) {
    if (acc.kills.length) {
      const total = acc.kills.reduce((n, e) => n + e.delta, 0);
      this._push(frame, {
        category: 'kills',
        label: 'Kills credited',
        change: `${total} enemy kill(s)`,
        detail: acc.kills.map(e => `Soldier #${e.id}: +${e.delta}`).join('\n')
          + '\n\nA kill is credited to the soldier whose attack landed the '
          + 'killing blow (melee or arrow).'
      });
    }
    if (acc.ffKills.length) {
      const total = acc.ffKills.reduce((n, e) => n + e.delta, 0);
      this._push(frame, {
        category: 'kills',
        label: 'Friendly-fire kills',
        change: `${total} friendly kill(s)`,
        detail: acc.ffKills.map(e => `Soldier #${e.id}: +${e.delta}`).join('\n')
          + '\n\nAn arrow that landed on a same-team soldier in a different '
          + 'unit. Same-unit friendly fire is impossible — ProjectileSystem '
          + 'skips the shooter\'s own unit entirely.'
      });
    }
  }

  _emitDamage(frame, acc) {
    if (!acc.damaged.length) return;
    const total = acc.damaged.reduce((n, e) => n + e.delta, 0);
    const lines = acc.damaged.map(e => {
      const cause = e.cause ? ` · ${e.cause}` : '';
      return `Soldier #${e.id} (${e.type}): -${e.delta.toFixed(0)} hp `
        + `(${e.hpBefore.toFixed(0)} → ${e.hpAfter.toFixed(0)})${cause}`;
    });
    this._push(frame, {
      category: 'damage',
      label: 'Damage taken',
      change: `${acc.damaged.length} soldier(s) · ${total.toFixed(0)} hp total`,
      detail: lines.join('\n') + '\n\nMelee hits, arrows that landed, and '
        + 'brace counters all reduce HP. Arrows blocked by a shield drain '
        + 'shield HP instead and do not appear here unless the shield '
        + 'broke through; melee blocks similarly drain shield HP.'
    });
  }

  _emitRouts(frame, acc) {
    if (!acc.routed.length) return;
    const shattered = acc.routed.filter(e => e.shattered).length;
    const routing = acc.routed.length - shattered;
    const parts = [];
    if (routing) parts.push(`${routing} routing`);
    if (shattered) parts.push(`${shattered} shattered`);
    this._push(frame, {
      category: 'rout',
      label: 'Broke',
      change: parts.join(' · '),
      detail: acc.routed.map(e =>
        `Soldier #${e.id}: ${e.shattered ? 'SHATTERED' : 'routing'}`
      ).join('\n') + '\n\nMorale hit 0. Routing soldiers flee and can rally '
        + 'if morale recovers above the rally threshold. Shattered soldiers '
        + 'are terminal — they will not rally and run for the map edge to '
        + 'extract.'
    });
  }

  _emitCasualties(frame, acc) {
    if (!acc.deaths.length) return;
    this._push(frame, {
      category: 'casualties',
      label: 'Casualties',
      change: `${acc.deaths.length} soldier(s) died`,
      detail: acc.deaths.map(e =>
        `Soldier #${e.id} (${e.type})${e.cause ? ' — ' + e.cause : ''}`
      ).join('\n')
    });
  }

  _emitExtracted(frame, acc) {
    if (!acc.extracted.length) return;
    this._push(frame, {
      category: 'casualties',
      label: 'Extracted',
      change: `${acc.extracted.length} soldier(s) fled the map`,
      detail: acc.extracted.map(e =>
        `Soldier #${e.id} (${e.type})`
      ).join('\n') + '\n\nRouting or shattered soldiers that crossed the map '
        + 'boundary are removed from the field and recorded for the campaign '
        + 'layer. They are non-alive for all sim purposes but distinguishable '
        + 'from dead.'
    });
  }

  // --- combat-event enrichment ---------------------------------------------

  _causeOfDamage(soldierId, meleeEvents, rangedEvents, allSoldiersById) {
    for (const e of meleeEvents) {
      if (e.defenderId === soldierId && (e.type === 'hit' || e.type === 'braceCounter')) {
        const attacker = allSoldiersById ? allSoldiersById.get(e.attackerId) : null;
        const name = attacker && attacker.unitTypeDef
          ? attacker.unitTypeDef.displayName : 'unknown';
        return `from melee (attacker: ${name})`;
      }
    }
    for (const e of rangedEvents) {
      if (e.defenderId === soldierId && e.type === 'hit') {
        const attacker = allSoldiersById ? allSoldiersById.get(e.attackerId) : null;
        const name = attacker && attacker.unitTypeDef
          ? attacker.unitTypeDef.displayName : 'unknown';
        return `from arrow (shooter: ${name})`;
      }
    }
    return '';
  }

  _causeOfDeath(soldierId, meleeEvents, rangedEvents, allSoldiersById) {
    for (const e of meleeEvents) {
      if (e.defenderId === soldierId && e.type === 'death') {
        const attacker = allSoldiersById ? allSoldiersById.get(e.attackerId) : null;
        const name = attacker && attacker.unitTypeDef
          ? attacker.unitTypeDef.displayName : 'unknown';
        return `killed in melee by ${name}`;
      }
    }
    for (const e of rangedEvents) {
      if (e.defenderId === soldierId && e.type === 'death') {
        const attacker = allSoldiersById ? allSoldiersById.get(e.attackerId) : null;
        const name = attacker && attacker.unitTypeDef
          ? attacker.unitTypeDef.displayName : 'unknown';
        return `killed by arrow from ${name}`;
      }
    }
    return '';
  }

  _formatBreakdown(b) {
    const parts = [];
    const push = (name, v) => {
      if (Math.abs(v) < 0.01) return;
      parts.push(`${name} ${v > 0 ? '+' : ''}${v.toFixed(1)}`);
    };

    // Regen carries two annotations:
    //   - FROZEN when the unit lost a soldier recently and the freeze
    //     window is still active. Regen is zero in that case, so the
    //     value would be suppressed by the epsilon check anyway; the
    //     explicit FROZEN marker makes the absence visible rather than
    //     silent.
    //   - (×N) when the linear casualty multiplier has pushed the regen
    //     rate meaningfully below base. Threshold at 0.99 to suppress
    //     the annotation on rounding noise.
    const regenMult = b.casualtyRegenMult;
    if (b.frozen) {
      parts.push('regen FROZEN');
    } else if (Math.abs(b.regen) >= 0.01) {
      const suffix = (typeof regenMult === 'number' && regenMult < 0.99)
        ? ` (×${regenMult.toFixed(2)})`
        : '';
      parts.push(`regen ${b.regen > 0 ? '+' : ''}${b.regen.toFixed(1)}${suffix}`);
    }

    push('hp', b.hp);
    push('casualtyLoss', b.casualtyLoss);
    push('outnumbered', b.outnumbered);
    push('flanked', b.flanked);
    push('allyRout', b.allyRout);
    push('enemyRout', b.enemyRout);
    push('kill', b.kill);
    push('adjacentWiped', b.adjacentWiped);
    return parts.join(', ');
  }

  // --- ring buffer ---------------------------------------------------------

  _push(frame, event) {
    event.frame = frame;
    event.seq = this._seq++;
    this._events.push(event);
    if (this._events.length > MAX_EVENTS) {
      const overflow = this._events.length - MAX_EVENTS;
      this._events = this._events.slice(overflow);
    }
  }
}