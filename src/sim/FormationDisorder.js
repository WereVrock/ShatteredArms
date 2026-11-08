// Soldier-count based formation disorder. Pure logic, no state.
//
// A discipline tier (CombatConfig.discipline) gives every soldier a fixed
// per-soldier jitter off its grid slot. That wobble is the same size at 25
// soldiers and at 200, so a big block still reads as a tidy rectangle. This
// module adds disorder that GROWS with the unit's soldier count:
//
//   - jitter grows with each doubling of the count above disorderRefCount,
//     up to disorderMaxJitterUnits;
//   - ROW SWAY: every row shifts sideways by a shared random amount;
//   - COLUMN SWAY: every column shifts forward/back by a shared random amount.
//
// Row and column sway are what make a large block's edges ragged. Sway is
// keyed on the soldier's grid row / column and a per-unit seed, so the whole
// row or column moves together. Everything is deterministic: the same unit
// always has the same silhouette.
//
// At or below disorderRefCount, and for any tier without the disorder*
// fields (normal, high), the result equals the plain per-soldier jitter.
//
// All offsets are in the formation's LOCAL space (x = lateral, z = forward).
// Unit._applyFormationAt (live slots) and Unit.previewFormationSlots (drag
// ghost) both call this, so the ghost shows exactly what the unit will do.

import { CombatConfig } from '../config/CombatConfig.js';
import { hash32 } from './Soldier.js';

const ZERO = Object.freeze({ x: 0, z: 0 });
const MAX_U32 = 4294967295;
const ROW_SALT = 0x1b873593;
const COL_SALT = 0x2545f491;

function unitNoise(seed, key, salt) {
  const h = hash32(
    (Math.imul(seed | 0, 73856093) ^ Math.imul(key | 0, 19349663) ^ salt) >>> 0
  );
  return (h / MAX_U32) * 2 - 1;
}

export class FormationDisorder {
  // Per-unit-layout context. Build once per layout pass, then call
  // forSoldier / offsetFor for every soldier with it.
  static contextFor({ typeDef, count, spacing, seed }) {
    const key = (typeDef && typeDef.discipline) || 'normal';
    const cfg = CombatConfig.discipline[key] || CombatConfig.discipline.normal;

    const n = Math.max(1, count | 0);
    const baseAmp = cfg.formationJitterUnits || 0;
    const ref = cfg.disorderRefCount || 0;
    const doublings = ref > 0 && n > ref ? Math.log2(n / ref) : 0;

    let jitterAmp = baseAmp;
    if (baseAmp > 0 && doublings > 0) {
      const grown = baseAmp * (1 + (cfg.disorderJitterGrowthPerDoubling || 0) * doublings);
      const cap = cfg.disorderMaxJitterUnits ?? grown;
      jitterAmp = Math.max(baseAmp, Math.min(cap, grown));
    }

    const swayCap = cfg.disorderMaxSwayUnits ?? Infinity;
    const rowSway = Math.min(swayCap, (cfg.disorderRowSwayPerDoubling || 0) * doublings);
    const colSway = Math.min(swayCap, (cfg.disorderColSwayPerDoubling || 0) * doublings);

    return {
      active: jitterAmp > 0 || rowSway > 0 || colSway > 0,
      jitterAmp,
      rowSway,
      colSway,
      spacing: spacing > 0 ? spacing : 1,
      seed: seed | 0,
      count: n
    };
  }

  // Disorder offset for one slot. `offX` / `offZ` are the slot's grid
  // offsets (before any disorder). Returns a fresh { x, z } (or a shared
  // frozen zero when the context is inactive); do not mutate the result.
  static offsetFor(ctx, soldierId, offX, offZ) {
    if (!ctx.active) return ZERO;

    let x = 0;
    let z = 0;

    if (ctx.jitterAmp > 0) {
      // Same two hashes the plain per-soldier jitter uses, so counts at or
      // below the reference size reproduce the existing look exactly.
      const hx = hash32(soldierId);
      const hz = hash32((soldierId ^ 0x9E3779B9) >>> 0);
      x += ((hx / MAX_U32) * 2 - 1) * ctx.jitterAmp;
      z += ((hz / MAX_U32) * 2 - 1) * ctx.jitterAmp;
    }

    if (ctx.rowSway > 0) {
      const rowKey = Math.round(offZ / ctx.spacing);
      x += unitNoise(ctx.seed, rowKey, ROW_SALT) * ctx.rowSway;
    }

    if (ctx.colSway > 0) {
      const colKey = Math.round(offX / ctx.spacing);
      z += unitNoise(ctx.seed, colKey, COL_SALT) * ctx.colSway;
    }

    return { x, z };
  }

  // Live-soldier version of offsetFor. The result depends only on the
  // soldier's grid offset and the layout context, and slots are recomputed
  // every tick, so it is cached on the soldier and recomputed only when
  // the offset or the context changes (a reflow, a reshape, a new count).
  // The returned object is the cache itself: read it, do not keep or mutate
  // it.
  static forSoldier(soldier, ctx) {
    if (!ctx.active) return ZERO;

    const off = soldier.formationOffset;
    let c = soldier._disorderCache;
    if (c
        && c.count === ctx.count
        && c.spacing === ctx.spacing
        && c.seed === ctx.seed
        && c.ox === off.x
        && c.oz === off.z) {
      return c;
    }

    const o = FormationDisorder.offsetFor(ctx, soldier.id, off.x, off.z);
    if (!c) c = soldier._disorderCache = {};
    c.count = ctx.count;
    c.spacing = ctx.spacing;
    c.seed = ctx.seed;
    c.ox = off.x;
    c.oz = off.z;
    c.x = o.x;
    c.z = o.z;
    return c;
  }
}