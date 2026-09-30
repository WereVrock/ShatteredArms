// Computes where the ENEMY line is weak, so our units can concentrate force
// there instead of every unit independently picking its own nearest target
// (which produces parallel 1:1 grinding along the whole front — nobody ever
// gets local numerical superiority anywhere).
//
// Deliberately cheap and coarse: buckets enemy units along the battle line's
// lateral (right) axis into slices, scores each slice by defender strength
// (alive count + avg HP fraction), and reports the weakest slice's world
// position. This runs once per decision interval (not per unit, not per
// tick) — it's a shared team-level read, not a per-unit computation.
export class EnemyLineAnalysis {
  // lineAxis: { right: {x,z}, forward: {x,z} } from BattleLineFormation's
  // own computation, so "weak point" is measured along the SAME axis the
  // formation itself uses — otherwise slice buckets and formation slots
  // would disagree about what "left" and "right" mean.
  constructor(enemyUnits, lineAxis, sliceWidth) {
    this.slices = [];
    this.weakestSlice = null;

    const alive = enemyUnits.filter(u => !u.isDefeated());
    if (alive.length === 0 || !lineAxis) return;

    const rightX = lineAxis.right.x;
    const rightZ = lineAxis.right.z;

    // Project each unit onto the right axis to get its lateral position,
    // then bucket into slices of sliceWidth.
    const projected = alive.map(u => {
      const c = u.getCenter();
      const lateral = c.x * rightX + c.z * rightZ;
      return { unit: u, lateral };
    });

    projected.sort((a, b) => a.lateral - b.lateral);

    const buckets = new Map();
    for (const p of projected) {
      const sliceIndex = Math.round(p.lateral / sliceWidth);
      let bucket = buckets.get(sliceIndex);
      if (!bucket) {
        bucket = { sliceIndex, units: [], strengthScore: 0, sumX: 0, sumZ: 0 };
        buckets.set(sliceIndex, bucket);
      }
      bucket.units.push(p.unit);
    }

    for (const bucket of buckets.values()) {
      let aliveCount = 0;
      let hpFracSum = 0;
      let sumX = 0, sumZ = 0;
      for (const u of bucket.units) {
        const soldiers = u.getAliveSoldiers();
        aliveCount += soldiers.length;
        for (const s of soldiers) hpFracSum += s.hp / s.maxHp;
        const c = u.getCenter();
        sumX += c.x;
        sumZ += c.z;
      }
      const avgHpFrac = aliveCount > 0 ? hpFracSum / aliveCount : 0;
      bucket.strengthScore = aliveCount * (0.5 + 0.5 * avgHpFrac);
      bucket.aliveCount = aliveCount;
      bucket.center = { x: sumX / bucket.units.length, z: sumZ / bucket.units.length };
      this.slices.push(bucket);
    }

    if (this.slices.length === 0) return;

    // Weakest = lowest strength score AMONG SLICES THAT ACTUALLY HAVE
    // DEFENDERS. An empty slice isn't "weak", it's just not part of the
    // enemy line (e.g. off past their flank) — targeting empty space isn't
    // useful, so slices with 0 alive are excluded.
    const defended = this.slices.filter(s => s.aliveCount > 0);
    if (defended.length === 0) return;

    defended.sort((a, b) => a.strengthScore - b.strengthScore);
    this.weakestSlice = defended[0];
  }

  // Returns the single unit within the weakest slice with the lowest
  // strength (fewest alive, then lowest HP) — the concrete concentration
  // target, not just the slice's abstract center.
  getWeakestUnit() {
    if (!this.weakestSlice || this.weakestSlice.units.length === 0) return null;

    let weakest = null;
    let weakestScore = Infinity;
    for (const u of this.weakestSlice.units) {
      if (u.isDefeated()) continue;
      const soldiers = u.getAliveSoldiers();
      if (soldiers.length === 0) continue;
      const hpFracSum = soldiers.reduce((sum, s) => sum + s.hp / s.maxHp, 0);
      const score = soldiers.length * (0.5 + 0.5 * (hpFracSum / soldiers.length));
      if (score < weakestScore) {
        weakestScore = score;
        weakest = u;
      }
    }
    return weakest;
  }
}