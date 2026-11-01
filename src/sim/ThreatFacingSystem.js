// Detects an incoming charge and sets the threatened soldier's
// DESIRED facing toward it — this is the "will your men see the charge
// coming" reaction from Total War. It does NOT rotate `facing` directly;
// FacingSystem still owns the actual bounded-rate turn, so a soldier who
// notices a flank charge only gets the CHANCE to turn and brace in time,
// not a free instant snap.
//
// Runs BEFORE FacingSystem each tick (see BattleSimulation tick order) so
// FacingSystem always sees this tick's freshest desired facing before it
// moves `facing` toward it.
//
// Only affects soldiers who aren't already actively oriented by something
// more urgent: engaged/ranged soldiers already face their target (handled
// in FacingSystem, which takes priority regardless — see there), so this
// system only needs to act on idle/marching/impetuous/staggered-recovering
// soldiers who would otherwise hold formation facing with no idea a charge
// is coming.
//
// Cost control: instead of testing every soldier against every charging
// cavalryman, each UNIT gets a bounding box over its alive soldiers, and
// only chargers that could be within detectRadius of that box (and are on
// another team) become candidates for the unit's soldiers. Candidate order
// follows charger order and ties keep the first charger, so the result is
// identical to the all-pairs scan. Units with no candidate cost nothing
// per soldier.
import { CombatConfig } from '../config/CombatConfig.js';
import { toSimSpeed } from '../config/SpeedScale.js';
import { isCavalry } from '../config/UnitClasses.js';

// Slack on the bounding-box test so rounding at the radius edge can never
// drop a charger the exact distance test would have accepted.
const BOX_SLACK = 0.01;

export class ThreatFacingSystem {
  constructor() {
    this._chargers = [];
    // unitId -> { stamp, teamId, minX, maxX, minZ, maxZ, cands }
    this._infoByUnit = new Map();
    this._activeInfos = [];
    this._stamp = 0;
  }

  update(allSoldiers) {
    // This system is the single owner of _threatFacingSetThisTick: it resets
    // the flag to false for every soldier at the start of its own pass, then
    // sets it true only for soldiers it actually assigns a threat-facing to
    // this tick. FacingSystem only ever READS the flag, never writes it, so
    // there is exactly one place that decides "was a threat facing set this
    // tick" and no cross-system ordering to get wrong.
    for (let i = 0; i < allSoldiers.length; i++) {
      allSoldiers[i]._threatFacingSetThisTick = false;
    }

    const chargers = this._chargers;
    chargers.length = 0;
    const chargeSpeed = toSimSpeed(CombatConfig.threatFacing.detectSpeedThreshold);
    for (let i = 0; i < allSoldiers.length; i++) {
      const s = allSoldiers[i];
      if (!s.isAlive()) continue;
      if (!isCavalry(s.unitTypeDef)) continue;
      if (s.currentSpeed < chargeSpeed) continue;
      chargers.push(s);
    }
    if (chargers.length === 0) return;

    const detectRadius = CombatConfig.threatFacing.detectRadius;
    const detectRadiusSq = detectRadius * detectRadius;
    const reach = detectRadius + BOX_SLACK;

    // Pass 1: bounding box of every unit's alive soldiers. A unit's
    // soldiers are contiguous in allSoldiers, so the last-unit cache makes
    // the Map lookup almost free.
    const stamp = ++this._stamp;
    const active = this._activeInfos;
    active.length = 0;

    let lastUnitId;
    let lastInfo = null;
    for (let i = 0; i < allSoldiers.length; i++) {
      const s = allSoldiers[i];
      if (!s.isAlive()) continue;

      let info;
      if (lastInfo !== null && s.unitId === lastUnitId) {
        info = lastInfo;
      } else {
        info = this._infoFor(s.unitId, s.teamId, stamp, active);
        lastUnitId = s.unitId;
        lastInfo = info;
      }

      const x = s.pos.x;
      const z = s.pos.z;
      if (x < info.minX) info.minX = x;
      if (x > info.maxX) info.maxX = x;
      if (z < info.minZ) info.minZ = z;
      if (z > info.maxZ) info.maxZ = z;
    }

    // Pass 2: per unit, the chargers that could matter. Order preserved.
    for (let k = 0; k < active.length; k++) {
      const info = active[k];
      const cands = info.cands;
      cands.length = 0;

      const minX = info.minX - reach;
      const maxX = info.maxX + reach;
      const minZ = info.minZ - reach;
      const maxZ = info.maxZ + reach;

      for (let c = 0; c < chargers.length; c++) {
        const ch = chargers[c];
        if (ch.teamId === info.teamId) continue;
        const x = ch.pos.x;
        const z = ch.pos.z;
        if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
        cands.push(ch);
      }
    }

    // Pass 3: the actual per-soldier reaction.
    lastUnitId = undefined;
    lastInfo = null;
    for (let i = 0; i < allSoldiers.length; i++) {
      const soldier = allSoldiers[i];
      if (!soldier.isAlive()) continue;
      // Already actively facing something more immediate — engaged/ranged
      // combat facing (set in FacingSystem) takes priority and this system
      // must not override it with a threat that hasn't reached melee yet.
      if (soldier.state === 'engaged' || soldier.state === 'ranged') continue;
      // Airborne/knockedDown soldiers can't meaningfully react.
      if (soldier.state === 'knockedDown') continue;
      if (soldier.airborneTicksLeft > 0) continue;

      let info;
      if (lastInfo !== null && soldier.unitId === lastUnitId) {
        info = lastInfo;
      } else {
        info = this._infoByUnit.get(soldier.unitId);
        lastUnitId = soldier.unitId;
        lastInfo = info;
      }
      if (info === undefined) continue;

      const cands = info.cands;
      if (cands.length === 0) continue;

      let nearest = null;
      let nearestDistSq = Infinity;

      for (let c = 0; c < cands.length; c++) {
        const charger = cands[c];
        if (charger.teamId === soldier.teamId) continue;
        const dx = charger.pos.x - soldier.pos.x;
        const dz = charger.pos.z - soldier.pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq > detectRadiusSq) continue;
        if (dSq < nearestDistSq) {
          nearestDistSq = dSq;
          nearest = charger;
        }
      }

      if (!nearest) continue;

      soldier.desiredFacing = Math.atan2(
        nearest.pos.x - soldier.pos.x,
        nearest.pos.z - soldier.pos.z
      );
      soldier._threatFacingSetThisTick = true;
    }
  }

  // Returns the unit's info record, resetting its box the first time it is
  // touched in this pass and registering it as active.
  _infoFor(unitId, teamId, stamp, active) {
    let info = this._infoByUnit.get(unitId);
    if (info === undefined) {
      info = {
        stamp: -1, teamId, minX: 0, maxX: 0, minZ: 0, maxZ: 0, cands: []
      };
      this._infoByUnit.set(unitId, info);
    }
    if (info.stamp !== stamp) {
      info.stamp = stamp;
      info.teamId = teamId;
      info.minX = Infinity;
      info.maxX = -Infinity;
      info.minZ = Infinity;
      info.maxZ = -Infinity;
      active.push(info);
    }
    return info;
  }
}