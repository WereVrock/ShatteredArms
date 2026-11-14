import { SpearWallConfig } from '../config/SpearWallConfig.js';

// Read-side API for spear wall integrity and spear raise state. Pure
// functions over the fields SpearWallSystem and FacingSystem write on a
// Soldier. No state, no side effects.
// Deliberately imports nothing from Soldier.js (Soldier imports this).
//
// Views of the same data:
//   integrity (0..1)  raw measurement of how well the line holds together.
//   strength  (0..1)  how much of the wall's COMBAT effect still applies:
//                     1 at fullStrengthAt or above, 0 when broken, linear
//                     between brokenBelow and fullStrengthAt.
//   ownStrength       the same curve on the soldier's OWN measurement only
//                     (not blended with his unit). Drives spear raising.

const ZERO = Object.freeze({ x: 0, z: 0 });
const _out = { x: 0, z: 0 };

function mix32(x) {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function curve(integrity) {
  const cfg = SpearWallConfig;
  if (!(integrity < cfg.fullStrengthAt)) return 1;
  const t = (integrity - cfg.brokenBelow) / (cfg.fullStrengthAt - cfg.brokenBelow);
  return t > 0 ? t : 0;
}

export const SpearWall = {
  // 0..1, 1 = intact. Always 1 for non-spearmen and on flat ground.
  integrityOf(soldier) {
    return soldier.spearWallIntegrity;
  },

  // True while the soldier's wall is broken (hysteresis applied).
  isBroken(soldier) {
    return soldier.spearWallBroken === true;
  },

  // 0..1 share of the wall's combat effect that still applies.
  strength(soldier) {
    if (soldier.spearWallBroken === true) return 0;
    return curve(soldier.spearWallIntegrity);
  },

  // Strength from the soldier's own footing only.
  ownStrength(soldier) {
    return curve(soldier.spearWallOwn);
  },

  // True when the soldier's footing is bad enough that he keeps his spear up.
  mustRaise(soldier) {
    return SpearWall.ownStrength(soldier) < SpearWallConfig.raiseBelowStrength;
  },

  // True while a SPEAR is held up (raising, raised or still lowering past
  // half). A raised spear cannot attack and does not brace. Lances are not
  // covered: cavalry keeps its old rules.
  isSpearRaised(soldier) {
    return soldier.unitTypeDef.weaponType === 'spear' &&
      soldier.spearRaiseAmount >= SpearWallConfig.raisedAmount;
  },

  // AI-side gate: can this individual soldier brace at all? Matches the
  // mechanic's own-spear condition exactly. The surrounding-men check
  // (50% unraised in front 2 ranks) is SpearBrace.assess's job at strike
  // time; here we only need "his own shaft is down", because a line whose
  // men have raised spears is by definition not a wall — the surround
  // condition is subsumed (each neighbour is itself not-raised).
  //
  // Reads isSpearRaised rather than strength: the old strength curve
  // came from the terrain-only integrity model, which no longer reflects
  // the mechanic (the plant override, in particular, made a soldier on
  // bad ground able to brace without the integrity ever recovering).
  // SpearWallConfig.braceMinStrength is unused here now — kept for
  // clarity in case a future weighting wants it back.
  canBrace(soldier) {
    if (!soldier) return false;
    if (soldier.unitTypeDef.weaponType !== 'spear') return false;
    if (!soldier.isAlive()) return false;
    return !SpearWall.isSpearRaised(soldier);
  },

  // True when the soldier is part of a functioning local wall:
  //   - his own spear is unraised;
  //   - a LEFT neighbour exists and is unraised;
  //   - a RIGHT neighbour exists and is unraised;
  //   - a BEHIND neighbour exists and is unraised.
  //
  // "Exists" = same unit, alive, spear, within localWall.radius, outside
  // the front cone. Missing any one, or raised, fails the wall.
  //
  // Wall orientation is the FORMATION facing, not the individual
  // soldier facing. Neighbour directions from that facing:
  //   front   dotF >  cos(frontArcRad)    -> enemy side, ignored
  //   behind  dotF < -cos(frontArcRad)    -> depth neighbour
  //   lateral |dotF| <= cos(frontArcRad)  -> left or right, by sign
  //                                          of cross(forward, delta)
  isWallLocal(soldier, unitsById) {
    if (!soldier) return false;
    if (soldier.unitTypeDef.weaponType !== 'spear') return false;
    if (!soldier.isAlive()) return false;
    if (soldier.state === 'routing' || soldier.state === 'shattered') return false;
    if (SpearWall.isSpearRaised(soldier)) return false;

    const unit = unitsById ? unitsById.get(soldier.unitId) : null;
    if (!unit) return false;

    const facing = unit.formationFacing;
    const fx = Math.sin(facing);
    const fz = Math.cos(facing);

    const cfg = SpearWallConfig.localWall;
    const radiusSq = cfg.radius * cfg.radius;
    const cosFront = Math.cos(cfg.frontArcRad);

    let hasLeft = false;
    let hasRight = false;
    let hasBehind = false;

    for (const s of unit.soldiers) {
      if (s === soldier) continue;
      if (!s.isAlive()) continue;
      if (s.unitTypeDef.weaponType !== 'spear') continue;

      const dx = s.pos.x - soldier.pos.x;
      const dz = s.pos.z - soldier.pos.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > radiusSq) continue;
      if (distSq < 1e-6) continue;

      const invDist = 1 / Math.sqrt(distSq);
      const dotF = (dx * fx + dz * fz) * invDist;

      // Front cone points at the enemy, not at allies. Ignore.
      if (dotF > cosFront) continue;

      // Any candidate neighbour that is raised breaks the wall at once.
      if (SpearWall.isSpearRaised(s)) return false;

      if (dotF < -cosFront) {
        hasBehind = true;
      } else {
        // Lateral. Sign of cross(forward, delta) tells left from right.
        // cross = fx * dz - fz * dx  (y-component in XZ plane)
        // Use -dx*fz + dz*fx to match forward = (fx, fz) convention:
        //   forward × delta (2D) = fx * dz - fz * dx
        const cross = fx * dz - fz * dx;
        if (cross > 0) hasLeft = true;
        else if (cross < 0) hasRight = true;
        // cross == 0 with dotF == 0 is degenerate (neighbour exactly on
        // the same point) — already excluded by distSq < 1e-6 above.
      }
    }

    return hasLeft && hasRight && hasBehind;
  },

  moveSpeedMult(soldier) {
    const i = soldier.spearWallIntegrity;
    if (!(i < 1)) return 1;
    const floor = SpearWallConfig.moveSpeedMultAtZero;
    return floor + (1 - floor) * (i > 0 ? i : 0);
  },

  // Local-space (x lateral, z depth) slot offset caused by a buckling
  // line. Returns a shared object: read it immediately, do not keep it.
  disorderOffset(soldier) {
    const cfg = SpearWallConfig.disorder;
    const i = soldier.spearWallIntegrity;
    if (!(i < cfg.startIntegrity)) return ZERO;

    let loss = (cfg.startIntegrity - i) / cfg.startIntegrity;
    if (loss > 1) loss = 1;

    if (soldier.spearWallDirX === 0 && soldier.spearWallDirZ === 0) {
      const angle = (mix32(soldier.id ^ 0x5bd1e995) / 4294967296) * Math.PI * 2;
      soldier.spearWallDirX = Math.cos(angle);
      soldier.spearWallDirZ = Math.sin(angle) * cfg.depthScale;
    }

    const mag = loss * cfg.maxUnits;
    _out.x = soldier.spearWallDirX * mag;
    _out.z = soldier.spearWallDirZ * mag;
    return _out;
  }
};