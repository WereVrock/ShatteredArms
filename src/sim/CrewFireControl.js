// ===== src/sim/CrewFireControl.js =====
// Fire discipline of crew-served weapons (goblin megabowman). Decides, every
// tick, which crew pairs are firing and keeps them STILL while they do.
//
// SEQUENCE OF ONE PAIR
//   1. The shooter is in 'ranged' state with a live target in range (set by
//      TargetingSystem).
//   2. The CARRIER stops where it is, kneels (crewPlanted) and is forced into
//      'ranged' state, so its draw cooldown ticks (RangedCombatSystem) and the
//      view animates it.
//   3. The SHOOTER walks to the spot directly behind the carrier, measured
//      along the carrier -> target line (crewFireActive, crewFireSpotX/Z;
//      MovementSystem walks it there).
//   4. Once there, the shooter is ready (crewReady) and both stand still.
//      CrewPairing.canFire requires crewReady, so nothing fires while a
//      shooter is still walking, and nothing walks while the pair fires.
//   5. When the shooter has no target / the target leaves the range / a move
//      order arrives (shooter no longer 'ranged'), the pair is released and
//      goes back to following the formation.
//
// Fields written on soldiers:
//   carrier.crewPlanted            true while the carrier is deployed
//   shooter.crewFireActive         true while the shooter has a firing spot
//   shooter.crewFireSpotX / Z      the spot (world coordinates)
//   shooter.crewReady              shooter stands on its spot
//
// Runs from MovementSystem.update, after TargetingSystem has set the states.
// Module-level scratch only; update() is not re-entrant.
import { CombatConfig } from '../config/CombatConfig.js';
import { getRangedRange } from '../config/UnitClasses.js';

const SHOOTER = 'shooter';
const CARRIER = 'carrier';

// Distance (world units) at which a shooter counts as on its spot, and the
// larger distance at which a ready shooter loses that status (hysteresis, so
// a collision nudge does not restart the whole sequence).
const SPOT_ENTER = 0.15;
const SPOT_EXIT = 0.45;
// A shooter farther from its spot than this is not part of a working pair
// (carrier lagging behind in "don't wait" mode): the pair does not deploy.
const MAX_SETUP_DISTANCE = 8.0;

const NO_FIRE_STATES = new Set(['engaged', 'staggered', 'knockedDown', 'routing', 'shattered']);

const _touched = new Set();
const _spot = { x: 0, z: 0 };

function isUsable(s) {
  return s.isAlive() && !NO_FIRE_STATES.has(s.state) && !(s.airborneTicksLeft > 0);
}

function clearShooter(sh) {
  sh.crewFireActive = false;
  sh.crewReady = false;
}

// The shooter's live target when it may fire this tick, else null. Mirrors
// the gates in RangedCombatSystem.update (fire-at-will, range window).
function fireTarget(sh, byId, unitsById) {
  if (sh.state !== 'ranged') return null;

  const unit = unitsById.get(sh.unitId);
  if (unit && !unit.fireAtWill && !unit.focusTargetUnitId) return null;

  const target = sh.targetId ? byId.get(sh.targetId) : null;
  if (!target || !target.isAlive()) return null;

  const dx = target.pos.x - sh.pos.x;
  const dz = target.pos.z - sh.pos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < CombatConfig.rangedMinRange) return null;
  if (dist > getRangedRange(sh.unitTypeDef)) return null;
  return target;
}

// Spot behind the carrier on the carrier -> target line, into _spot.
function computeSpot(carrier, target) {
  let dx = target.pos.x - carrier.pos.x;
  let dz = target.pos.z - carrier.pos.z;
  let len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-3) {
    dx = Math.sin(carrier.facing);
    dz = Math.cos(carrier.facing);
    len = 1;
  }
  const gap = CombatConfig.crew?.pairGap ?? 0.7;
  _spot.x = carrier.pos.x - (dx / len) * gap;
  _spot.z = carrier.pos.z - (dz / len) * gap;
}

export const CrewFireControl = {
  update(allSoldiers, unitsById, byId) {
    _touched.clear();

    for (let i = 0; i < allSoldiers.length; i++) {
      const sh = allSoldiers[i];
      if (sh.crewRole !== SHOOTER || !sh.unitTypeDef.crew) continue;

      if (!isUsable(sh)) { clearShooter(sh); continue; }

      const carrier = (sh.crewPartnerId !== null && sh.crewPartnerId !== undefined)
        ? byId.get(sh.crewPartnerId)
        : null;
      if (!carrier || carrier.crewRole !== CARRIER || carrier.crewPartnerId !== sh.id ||
          !isUsable(carrier)) {
        clearShooter(sh);
        continue;
      }

      const target = fireTarget(sh, byId, unitsById);
      if (!target) { clearShooter(sh); continue; }

      computeSpot(carrier, target);
      const dx = _spot.x - sh.pos.x;
      const dz = _spot.z - sh.pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > MAX_SETUP_DISTANCE) { clearShooter(sh); continue; }

      sh.crewFireActive = true;
      sh.crewFireSpotX = _spot.x;
      sh.crewFireSpotZ = _spot.z;
      sh.crewReady = dist <= (sh.crewReady === true ? SPOT_EXIT : SPOT_ENTER);

      // Carrier mirrors the shooter: same target, 'ranged' state (so its
      // cooldown ticks and the view draws), planted.
      carrier.crewPlanted = true;
      carrier.state = 'ranged';
      carrier.targetId = sh.targetId;
      _touched.add(carrier.id);
    }

    // Carriers that no shooter claimed this tick are released.
    for (let i = 0; i < allSoldiers.length; i++) {
      const s = allSoldiers[i];
      if (s.crewPlanted === true && !_touched.has(s.id)) s.crewPlanted = false;
    }
  }
};