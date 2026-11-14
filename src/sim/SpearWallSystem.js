import { SpearWallConfig } from '../config/SpearWallConfig.js';
import { isSpearmen } from '../config/UnitClasses.js';
import { obstacleSignedDistance } from './TerrainGeometry.js';

// Measures how well each spearman's wall holds together on the terrain he
// stands on, and writes the result on the soldier:
//   spearWallTarget    latest raw measurement of his own ground
//   spearWallOwn       target eased in (fast down, slow up)
//   spearWallIntegrity own blended with the unit average (what others read)
//   spearWallBroken    hysteresis flag
// Consumers read through SpearWall.js. This system is the only writer.
//
// Needs terrain; the caller skips it on flat ground, where integrity
// stays at its constructor default of 1.

export class SpearWallSystem {
  constructor() {
    this._spearmen = [];
    this._accs = [];
    this._unitAcc = new Map();   // unitId -> { stamp, sum, count }
    this._stamp = 0;
    this._obstacleBuf = [];
    this._sample = { h: 0, gx: 0, gz: 0 };
  }

  update(allSoldiers, terrain, tick, deltaSeconds) {
    const cfg = SpearWallConfig;
    const spearmen = this._spearmen;
    const accs = this._accs;
    spearmen.length = 0;
    accs.length = 0;

    const stamp = ++this._stamp;
    const breakStep = deltaSeconds / cfg.breakSeconds;
    const recoverStep = deltaSeconds / cfg.recoverSeconds;

    // Pass 1: refresh each spearman's own integrity, accumulate per unit.
    let lastUnitId;
    let lastAcc = null;
    for (let i = 0; i < allSoldiers.length; i++) {
      const s = allSoldiers[i];
      if (!s.isAlive()) continue;
      if (s.state === 'routing' || s.state === 'shattered') continue;
      if (!isSpearmen(s.unitTypeDef)) continue;

      if (((tick + s.id) % cfg.recheckTicks) === 0) {
        s.spearWallTarget = this._measure(s, terrain);
      }

      if (s.spearWallTarget < s.spearWallOwn) {
        s.spearWallOwn = Math.max(s.spearWallTarget, s.spearWallOwn - breakStep);
      } else if (s.spearWallTarget > s.spearWallOwn) {
        s.spearWallOwn = Math.min(s.spearWallTarget, s.spearWallOwn + recoverStep);
      }

      let acc;
      if (lastAcc !== null && s.unitId === lastUnitId) {
        acc = lastAcc;
      } else {
        acc = this._unitAcc.get(s.unitId);
        if (acc === undefined) {
          acc = { stamp: -1, sum: 0, count: 0 };
          this._unitAcc.set(s.unitId, acc);
        }
        if (acc.stamp !== stamp) {
          acc.stamp = stamp;
          acc.sum = 0;
          acc.count = 0;
        }
        lastUnitId = s.unitId;
        lastAcc = acc;
      }
      acc.sum += s.spearWallOwn;
      acc.count++;

      spearmen.push(s);
      accs.push(acc);
    }

    // Pass 2: blend with the unit average, apply hysteresis.
    const w = cfg.ownWeight;
    for (let i = 0; i < spearmen.length; i++) {
      const s = spearmen[i];
      const acc = accs[i];
      const finalIntegrity = s.spearWallOwn * w + (acc.sum / acc.count) * (1 - w);
      s.spearWallIntegrity = finalIntegrity;

      if (s.spearWallBroken) {
        if (finalIntegrity > cfg.restoredAbove) s.spearWallBroken = false;
      } else if (finalIntegrity < cfg.brokenBelow) {
        s.spearWallBroken = true;
      }
    }
  }

// Ground integrity (0..1) at a world point, for AI terrain scouting. The same
  // measurement the system applies to a spearman standing there.
  integrityAt(x, z, terrain) {
    return this._measure({ pos: { x, z } }, terrain);
  }

// Integrity of the ground under one soldier, 0..1. Product of independent
  // factors: ground type, slope, nearby obstacles.
  _measure(s, terrain) {
    const cfg = SpearWallConfig;
    const x = s.pos.x;
    const z = s.pos.z;

    let integrity = 1 - (cfg.groundDisruption[terrain.typeAt(x, z)] ?? 0);

    if (terrain.hasElevation) {
      const sm = terrain.height.sample(x, z, this._sample);
      const grade = Math.sqrt(sm.gx * sm.gx + sm.gz * sm.gz);
      const sl = cfg.slope;
      let t = (grade - sl.start) / (sl.full - sl.start);
      if (t > 0) {
        if (t > 1) t = 1;
        integrity *= 1 - t * sl.weight;
      }
    }

    if (terrain.obstacles.length > 0) {
      const reach = cfg.obstacleReach;
      const buf = this._obstacleBuf;
      terrain.queryObstacles(x, z, reach, buf);
      let penalty = 0;
      for (let k = 0; k < buf.length; k++) {
        const o = buf[k];
        const base = cfg.obstaclePenalty[o.kind];
        if (!base) continue;
        const d = obstacleSignedDistance(o, x, z);
        if (d >= reach) continue;
        penalty += base * (1 - (d > 0 ? d : 0) / reach);
      }
      if (penalty > cfg.obstacleCap) penalty = cfg.obstacleCap;
      integrity *= 1 - penalty;
    }

    return integrity < 0 ? 0 : integrity;
  }
}