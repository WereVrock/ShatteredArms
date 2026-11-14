import { CombatConfig } from '../config/CombatConfig.js';

// Crew-served weapons (goblin megabowman). A unit of a type that declares a
// `crew` field is made of two roles: CARRIERS (front of their cell, hold the
// weapon) and SHOOTERS (directly behind, fire it). One carrier and one
// shooter form a pair that works one weapon. Roles live on the soldier
// (crewRole, crewPartnerId); the unit type is shared by the whole unit.
//
// This module owns pairing and the crew-related unit state queries
// (run / "don't wait for carriers" toggle state). It does not fire, move,
// lay out or score anything: RangedCombatSystem asks canFire, UnitPower / Unit
// ask pairCount, Gait / UnitMarch read unit.crewDontWaitActive (written here),
// CrewFormation lays the pairs out.
//
// For crew units the toggle IS the run switch: update() publishes
// unit.runEnabled = unit.crewDontWaitActive, so RunSystem runs the shooters
// whenever the toggle is on (or every carrier is dead).
//
// When update() forms a NEW pair (a survivor re-paired after a death) it sets
// unit._crewRelayout, and Unit.update lays the pairs out again so they stand
// together.
//
// No state beyond reusable scratch buffers. update() is not re-entrant.

const SHOOTER = 'shooter';
const CARRIER = 'carrier';

const _byId = new Map();
const _freeShooters = [];
const _freeCarriers = [];
const _counts = { shooters: 0, carriers: 0, usable: 0 };

function isUsable(s) {
  return s.isAlive() && s.state !== 'routing' && s.state !== 'shattered';
}

// Fills _counts with the usable shooter / carrier / total counts of a unit.
function countRoles(unit) {
  let shooters = 0;
  let carriers = 0;
  let usable = 0;
  const soldiers = unit.soldiers;
  for (let i = 0; i < soldiers.length; i++) {
    const s = soldiers[i];
    if (!isUsable(s)) continue;
    usable++;
    if (s.crewRole === SHOOTER) shooters++;
    else if (s.crewRole === CARRIER) carriers++;
  }
  _counts.shooters = shooters;
  _counts.carriers = carriers;
  _counts.usable = usable;
  return _counts;
}

export const CrewPairing = {
  SHOOTER,
  CARRIER,

  isCrewUnit(unit) {
    const lead = unit.soldiers[0];
    return !!(lead && lead.unitTypeDef.crew);
  },

  // Pairs soldiers by index: soldiers[2p] is the carrier and soldiers[2p+1]
  // its shooter. With an odd count the last soldier is a lone shooter. This
  // is the cell order CrewFormation lays out for a fresh unit.
  assignByIndex(soldiers) {
    const n = soldiers.length;
    for (let i = 0; i < n; i++) soldiers[i].crewPartnerId = null;
    for (let i = 0; i + 1 < n; i += 2) {
      const carrier = soldiers[i];
      const shooter = soldiers[i + 1];
      carrier.setCrewRole(CARRIER);
      shooter.setCrewRole(SHOOTER);
      carrier.crewPartnerId = shooter.id;
      shooter.crewPartnerId = carrier.id;
    }
    if (n % 2 === 1) soldiers[n - 1].setCrewRole(SHOOTER);
  },

  // Called once when a unit is built, after its first layout (which already
  // assigns the roles). Only fills in roles that are still missing.
  assignInitialRoles(unit) {
    if (!CrewPairing.isCrewUnit(unit)) return;
    const soldiers = unit.soldiers;
    for (let i = 0; i < soldiers.length; i++) {
      if (soldiers[i].crewRole === null || soldiers[i].crewRole === undefined) {
        CrewPairing.assignByIndex(soldiers);
        break;
      }
    }
    CrewPairing.update(unit);
  },

  // Per-tick pair repair, called from Unit.update. Drops pairs whose
  // partner died or broke, then pairs free survivors of opposite roles by
  // nearest distance. Leftovers stay unpaired and just follow the
  // formation. Also publishes unit.crewDontWaitActive and the matching
  // unit.runEnabled.
  update(unit) {
    if (!CrewPairing.isCrewUnit(unit)) return;
    const soldiers = unit.soldiers;

    _byId.clear();
    for (let i = 0; i < soldiers.length; i++) _byId.set(soldiers[i].id, soldiers[i]);
    _freeShooters.length = 0;
    _freeCarriers.length = 0;

    for (let i = 0; i < soldiers.length; i++) {
      const s = soldiers[i];
      if (s.crewRole === null) continue;
      if (!isUsable(s)) {
        s.crewPartnerId = null;
        continue;
      }
      if (s.crewPartnerId !== null) {
        const p = _byId.get(s.crewPartnerId);
        if (p && isUsable(p) && p.crewRole !== null && p.crewRole !== s.crewRole &&
            p.crewPartnerId === s.id) {
          continue;
        }
        s.crewPartnerId = null;
      }
      if (s.crewRole === SHOOTER) _freeShooters.push(s);
      else _freeCarriers.push(s);
    }

    for (let i = 0; i < _freeShooters.length; i++) {
      const shooter = _freeShooters[i];
      let best = -1;
      let bestD = Infinity;
      for (let j = 0; j < _freeCarriers.length; j++) {
        const carrier = _freeCarriers[j];
        if (carrier === null) continue;
        const dx = carrier.pos.x - shooter.pos.x;
        const dz = carrier.pos.z - shooter.pos.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = j; }
      }
      if (best >= 0) {
        const carrier = _freeCarriers[best];
        shooter.crewPartnerId = carrier.id;
        carrier.crewPartnerId = shooter.id;
        _freeCarriers[best] = null;
        // A new pair: the formation lays it out as one cell.
        unit._crewRelayout = true;
      }
    }

    const active = CrewPairing.dontWaitState(unit).active;
    unit.crewDontWaitActive = active;
    // For a crew unit the toggle is the run switch (see header).
    unit.runEnabled = active;
  },

  // True when `shooter` may fire this tick: it is a shooter, its partner is
  // a living carrier, and the carrier is close enough to hold the weapon.
  canFire(shooter, byId) {
    if (shooter.crewRole !== SHOOTER) return false;
    if (shooter.crewPartnerId === null) return false;
    // Set by CrewFireControl once the shooter stands behind its kneeling
    // carrier. A shooter that is still walking never fires.
    if (shooter.crewReady !== true) return false;
    const p = byId.get(shooter.crewPartnerId);
    if (!p || !isUsable(p) || p.crewRole !== CARRIER) return false;
    const maxD = CombatConfig.crew?.maxPairDistance ?? 3.0;
    const dx = p.pos.x - shooter.pos.x;
    const dz = p.pos.z - shooter.pos.z;
    return dx * dx + dz * dz <= maxD * maxD;
  },

  // State of the run ("don't wait for carriers") toggle for one crew unit.
  //   enabled: the player may click it (both roles still alive).
  //   active:  shooters are released from their carriers and run.
  // No shooters left: disabled, inactive. No carriers left: disabled,
  // active (shooters are free by force).
  dontWaitState(unit) {
    const c = countRoles(unit);
    if (c.shooters === 0) return { enabled: false, active: false };
    if (c.carriers === 0) return { enabled: false, active: true };
    return { enabled: true, active: !!unit.crewDontWait };
  },

  // Number of working weapons a unit can field: min(shooters, carriers)
  // among living, non-routing soldiers. A unit whose soldiers carry no
  // roles (campaign preview units) counts half its soldiers as pairs.
  pairCount(unit) {
    const c = countRoles(unit);
    if (c.shooters + c.carriers === 0) return Math.floor(c.usable / 2);
    return Math.min(c.shooters, c.carriers);
  }
};