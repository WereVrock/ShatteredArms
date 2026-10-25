// ===== src/ai/ArcherSupportCoordinator.js =====
// ===== ArcherSupportCoordinator.js =====
// Pairs friendly cavalry to threatened archer clusters each decision
// cycle. One cav per cluster. Sticky across cycles so a cav that's
// already protecting an archer group keeps doing so until the threat
// resolves.
//
// The pairing is advisory: cav read their assignment and choose to act
// on it (see FlankerBehavior._decideEscort). The coordinator does not
// issue orders, it just writes intent fields both sides read.
//
// Runs before the unit loop in TeamAI._decide, so this cycle's escort
// assignments are visible to every cav when it evaluates its own
// behaviour. Archers read their hasEscort flag the same cycle.
//
// Stateless. The pairing state lives on the intents; a fresh resolve
// produces the same output given the same world state.

import { isCavalryForAI, isRanged } from '../config/UnitClasses.js';
import { AIConfig } from '../config/AIConfig.js';
import { unitTypeOf } from './behaviorUtils.js';
import { AIDebugLog } from './AIDebugLog.js';

export class ArcherSupportCoordinator {
  // teamUnits: the team's Unit list.
  // enemyUnits: living enemies.
  // intents: this team's UnitIntentRegistry.
  // assessment: the current BattleAssessment, or null. Read for the
  //             skirmishersWithoutCavalryCover flag — when the team
  //             is out-cav'd, no assignments are made and every archer
  //             hugs.
  static resolve(teamUnits, enemyUnits, intents, assessment) {
    // Collect enemy cavalry (extended predicate — includes anything
    // tagged countsAsCavalry, e.g. the mounted Goblin Warlord).
    const enemyCavUnits = [];
    for (const eu of enemyUnits) {
      if (eu.isDefeated()) continue;
      const t = unitTypeOf(eu);
      if (!t || !isCavalryForAI(t)) continue;
      const alive = eu.getAliveSoldiers();
      if (alive.length === 0) continue;
      enemyCavUnits.push({ unit: eu, center: eu.getCenter() });
    }

    // Collect our archers, with their current centre, for clustering
    // and threat lookup.
    const ourArchers = [];
    for (const u of teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t || !isRanged(t)) continue;
      const alive = u.getAliveSoldiers();
      if (alive.length === 0) continue;
      const intent = intents.get(u.id);
      if (!intent) continue;
      ourArchers.push({ unit: u, intent, center: u.getCenter() });
    }

    // DEBUG — remove once the champ visibility is confirmed.
    AIDebugLog.log('skirmish', 0,
      `coord archers=${ourArchers.length} enemyCavUnits=${enemyCavUnits.length} ` +
      `outCavved=${!!(assessment && assessment.skirmishersWithoutCavalryCover)} ` +
      `enemyCavIds=[${enemyCavUnits.map(e => e.unit.id + ':' + (unitTypeOf(e.unit)?.id || '?')).join(',')}]`);

    // No archers on our side. Clear any stale cav assignments and
    // return — nothing to coordinate.
    if (ourArchers.length === 0) {
      this._clearAllEscorts(teamUnits, intents);
      return;
    }

    // No enemy cavalry anywhere on the field. Every archer is free to
    // advance — set hasEscort true for all of them and clear any stale
    // cav assignments.
    if (enemyCavUnits.length === 0) {
      for (const a of ourArchers) a.intent.hasEscort = true;
      this._clearAllEscorts(teamUnits, intents);
      return;
    }

    // Compute each archer's nearest enemy cavalry and distance.
    for (const a of ourArchers) {
      let best = null;
      let bestDistSq = Infinity;
      for (const ec of enemyCavUnits) {
        const dx = ec.center.x - a.center.x;
        const dz = ec.center.z - a.center.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          best = ec.unit;
        }
      }
      a.nearestCavUnit = best;
      a.nearestCavDistSq = bestDistSq;
    }

    // Cav-vs-cav check. When our team is out-matched in cavalry, no
    // escort coordination runs at all — the archers cannot be protected
    // by an inferior screen, so every archer hugs the melee line and
    // lets the infantry fight in front of them. There is no "nearby
    // threat" exemption: the whole point of this gate is that the
    // enemy's cavalry is stronger than ours, so no archer is safe to
    // advance regardless of current distance.
    //
    // `skirmishersWithoutCavalryCover` is computed by BattleAssessment
    // from alive cavalry soldier counts on both sides, using the same
    // extended isCavalryForAI predicate this coordinator uses.
    if (assessment && assessment.skirmishersWithoutCavalryCover) {
      for (const a of ourArchers) a.intent.hasEscort = false;
      this._clearAllEscorts(teamUnits, intents);
      return;
    }

    // Clear escorts on any cav that has committed to a target other than
    // its escort threat. When the cav leaves to fight an opportunity, the
    // archers it was covering are no longer protected — the flag must
    // drop so they stop advancing and start hugging. Without this, an
    // archer keeps seeing hasEscort=true while its protector fights
    // something else on the far side of the map.
    for (const u of teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t || !isCavalryForAI(t)) continue;
      const intent = intents.get(u.id);
      if (!intent) continue;
      if (!intent.escortArcherUnitIds) continue;
      const committedElsewhere =
        (intent.phase === 'committed' || intent.phase === 'regrouping') &&
        intent.targetUnitId !== intent.escortThreatUnitId;
      if (committedElsewhere) {
        intent.escortArcherUnitIds = null;
        intent.escortThreatUnitId = null;
      }
    }

    // Not out-cav'd. The enemy has cavalry on the field, so every archer
    // needs an assigned protector to advance — regardless of how far
    // the enemy cav currently is. A mounted unit at 60 units is two
    // seconds of gallop away, not a non-threat.
    //
    // Cluster every archer. Cluster COUNT is driven by how many cav are
    // available this cycle — one cluster per cav — so every cluster
    // gets a protector and no archer is left behind. The soft limit of
    // 3 archers per cluster is aspirational: when cav are plentiful,
    // clusters stay small; when cav are scarce, clusters grow rather
    // than orphaning archers. Spacing decides only WHICH cluster each
    // archer joins (nearest seed), not whether they join one at all.
    //
    // Available cav = cav currently in seeking (assignable) plus cav
    // currently on escort (sticky; their cluster stays theirs).
    // Committed/regrouping cav with no escort are busy and don't count.
    let availableCavCount = 0;
    for (const u of teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t || !isCavalryForAI(t)) continue;
      const intent = intents.get(u.id);
      if (!intent) continue;
      if (intent.escortArcherUnitIds) { availableCavCount++; continue; }
      if (intent.phase === 'seeking') availableCavCount++;
    }
    const clusters = this._clusterArchers(ourArchers, availableCavCount);

    // Collect candidate cavalry for assignment. Two categories:
    //   1. Cav already escorting one of these clusters (kept sticky,
    //      unless the assignment is invalid).
    //   2. Cav currently in the 'seeking' phase (available for fresh
    //      assignment).
    //
    // A cav that is committed or regrouping is busy; it isn't
    // reassigned and its existing assignment is left untouched so the
    // pair survives until it returns to seeking.
    const freeCav = [];
    const busyEscortingCavIds = new Set();
    for (const u of teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t || !isCavalryForAI(t)) continue;
      const intent = intents.get(u.id);
      if (!intent) continue;
      if (intent.escortArcherUnitIds && intent.phase !== 'seeking') {
        // Busy but still assigned — track so this cluster's sticky
        // claim survives.
        busyEscortingCavIds.add(u.id);
        continue;
      }
      if (intent.phase === 'seeking') {
        freeCav.push({ unit: u, intent, center: u.getCenter() });
      }
    }

    // Clear stale escort fields on cav whose cluster is no longer in
    // the threatened set.
    const liveClusterArcherIds = new Set();
    for (const cluster of clusters) {
      for (const a of cluster.archers) liveClusterArcherIds.add(a.unit.id);
    }
    for (const u of teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t || !isCavalryForAI(t)) continue;
      const intent = intents.get(u.id);
      if (!intent) continue;
      if (!intent.escortArcherUnitIds) continue;
      // A cav's assignment is valid only if at least one of its
      // assigned archers is still in a live cluster. Otherwise it's
      // stale and cleared.
      const stillValid = intent.escortArcherUnitIds.some(id => liveClusterArcherIds.has(id));
      if (!stillValid) {
        intent.escortArcherUnitIds = null;
        intent.escortThreatUnitId = null;
      }
    }

    // For each cluster, find a cav.
    //
    // Sticky first: if a cav is already assigned to any archer in this
    // cluster, keep it. Otherwise pick the nearest unclaimed free cav.
    // Tether gate. Computed once per cycle so every cluster's "has it
    // sallied?" test reads the same reference. A cluster inside the
    // tether is protected by the line itself — no escort assignment,
    // and any stale assignment on a cav that was previously escorting
    // this cluster is cleared so the cav falls through to its flank
    // station next cycle. The archers' hasEscort flag stays true:
    // they're still allowed to advance on their own, and the escort
    // picks them up once they cross the tether.
    const tetherInfo = this._computeLineTether(teamUnits, enemyUnits);
    const tetherDist = AIConfig.archerLineTetherDist ?? 8.0;

    const claimedCavIds = new Set();
    for (const cluster of clusters) {
      if (tetherInfo &&
          !this._clusterPastTether(cluster, tetherInfo.anchor, tetherInfo.forward, tetherDist)) {
        for (const a of cluster.archers) a.intent.hasEscort = true;
        for (const u of teamUnits) {
          if (u.isDefeated()) continue;
          const t = unitTypeOf(u);
          if (!t || !isCavalryForAI(t)) continue;
          const intent = u ? intents.get(u.id) : null;
          if (!intent || !intent.escortArcherUnitIds) continue;
          const overlaps = cluster.archers.some(
            a => intent.escortArcherUnitIds.includes(a.unit.id)
          );
          if (overlaps) {
            intent.escortArcherUnitIds = null;
            intent.escortThreatUnitId = null;
          }
        }
        continue;
      }

      // Determine the cluster's primary threat — the enemy cavalry
      // that is closest to any archer in the cluster.
      let threatUnit = null;
      let threatDistSq = Infinity;
      for (const a of cluster.archers) {
        if (a.nearestCavDistSq < threatDistSq) {
          threatDistSq = a.nearestCavDistSq;
          threatUnit = a.nearestCavUnit;
        }
      }
      if (!threatUnit) continue;

      // Sticky check: is a cav already escorting one of these archers?
      let assignedCav = null;
      for (const u of teamUnits) {
        if (claimedCavIds.has(u.id)) continue;
        const t = unitTypeOf(u);
        if (!t || !isCavalryForAI(t)) continue;
        const intent = intents.get(u.id);
        if (!intent || !intent.escortArcherUnitIds) continue;
        const overlaps = cluster.archers.some(
          a => intent.escortArcherUnitIds.includes(a.unit.id)
        );
        if (overlaps) { assignedCav = { unit: u, intent }; break; }
      }

      // Fresh assignment if sticky failed.
      if (!assignedCav) {
        let bestCav = null;
        let bestDistSq = Infinity;
        const clusterCenter = this._clusterCenter(cluster);
        for (const c of freeCav) {
          if (claimedCavIds.has(c.unit.id)) continue;
          const dx = c.center.x - clusterCenter.x;
          const dz = c.center.z - clusterCenter.z;
          const dSq = dx * dx + dz * dz;
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestCav = c;
          }
        }
        if (bestCav) assignedCav = { unit: bestCav.unit, intent: bestCav.intent };
      }

      if (!assignedCav) {
        // No cav available. Every archer in this cluster hugs.
        for (const a of cluster.archers) a.intent.hasEscort = false;
        continue;
      }

      // Write the assignment.
      const archerIds = cluster.archers.map(a => a.unit.id);
      assignedCav.intent.escortArcherUnitIds = archerIds;
      assignedCav.intent.escortThreatUnitId = threatUnit.id;
      claimedCavIds.add(assignedCav.unit.id);
      for (const a of cluster.archers) a.intent.hasEscort = true;
    }
  }

  // Cluster archers into `cavCount` spatially-coherent groups. The
  // previous implementation used a fixed radius, which produced
  // singleton clusters whenever archers were spread wider than the
  // radius — with one cav and five spread archers, four archers got no
  // cover and hugged. Cluster count is now driven by cav count, and
  // every archer is always in SOME cluster (no archer is left behind).
  //
  // cavCount may be 0 (no cav available at all) — the function still
  // returns one cluster with every archer, so the caller's "no cav for
  // this cluster" branch handles them together instead of as a stack
  // of singletons.
  //
  // Seeds: sort archers spatially along the x-axis (with z as a
  // tiebreak), then pick `k` evenly-spaced seeds across that sorted
  // list. Deterministic, stable, and guarantees at least one archer
  // per seed when k <= n. Each archer then joins its nearest seed.
  // The soft limit of 3 per cluster emerges naturally from the seed
  // count when cav are plentiful; when cav are scarce, clusters grow
  // past 3 rather than dropping members.
  static _clusterArchers(threatenedArchers, cavCount) {
    const n = threatenedArchers.length;
    if (n === 0) return [];

    // k = number of clusters. Capped by archer count so we don't try
    // to seed more clusters than we have members. Floored at 1 so the
    // no-cav case still returns a single cluster containing everyone.
    const k = Math.max(1, Math.min(cavCount || 1, n));

    // Degenerate: one cluster per archer (cav outnumber archers).
    if (k === n) {
      return threatenedArchers.map(a => ({ archers: [a] }));
    }

    // Spatial sort. X is the primary axis because the archer line
    // spreads laterally along it; z is the tiebreak.
    const sorted = [...threatenedArchers].sort((a, b) => {
      const ax = a.center.x, bx = b.center.x;
      if (Math.abs(ax - bx) > 0.5) return ax - bx;
      return a.center.z - b.center.z;
    });

    // Evenly-spaced seeds across the sorted list. Because k <= n,
    // every seed index is a distinct archer, so no seed lands on an
    // empty position.
    const seeds = [];
    for (let i = 0; i < k; i++) {
      const idx = Math.floor((i * n) / k);
      seeds.push({ x: sorted[idx].center.x, z: sorted[idx].center.z });
    }

    // Nearest-seed assignment. Every archer joins exactly one cluster;
    // no archer is dropped. Empty clusters cannot occur given the seed
    // selection above, but the filter keeps the invariant clean.
    const clusters = seeds.map(() => ({ archers: [] }));
    for (const a of threatenedArchers) {
      let bestIdx = 0;
      let bestDistSq = Infinity;
      for (let i = 0; i < seeds.length; i++) {
        const dx = a.center.x - seeds[i].x;
        const dz = a.center.z - seeds[i].z;
        const dSq = dx * dx + dz * dz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestIdx = i;
        }
      }
      clusters[bestIdx].archers.push(a);
    }

    return clusters.filter(c => c.archers.length > 0);
  }

  static _clusterCenter(cluster) {
    let sx = 0, sz = 0;
    for (const a of cluster.archers) { sx += a.center.x; sz += a.center.z; }
    return { x: sx / cluster.archers.length, z: sz / cluster.archers.length };
  }

  // Melee line's mean position and forward axis (toward enemy mean). Same
  // convention TeamAI._computeInfantryLineData and _computeRangedOverextended
  // use, recomputed here rather than plumbed through so the coordinator
  // stays a pure function of its inputs. Returns null when no line units
  // survive or no enemies are alive — the caller then skips the tether
  // gate and preserves the previous behaviour.
  static _computeLineTether(teamUnits, enemyUnits) {
    let sx = 0, sz = 0, count = 0;
    for (const u of teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t) continue;
      if (isCavalryForAI(t) || isRanged(t)) continue;
      const c = u.getCenter();
      sx += c.x; sz += c.z; count++;
    }
    if (count === 0) return null;
    const anchor = { x: sx / count, z: sz / count };

    if (!Array.isArray(enemyUnits) || enemyUnits.length === 0) return null;
    let ex = 0, ez = 0, ecount = 0;
    for (const eu of enemyUnits) {
      if (eu.isDefeated()) continue;
      const c = eu.getCenter();
      ex += c.x; ez += c.z; ecount++;
    }
    if (ecount === 0) return null;
    ex /= ecount; ez /= ecount;

    const dx = ex - anchor.x;
    const dz = ez - anchor.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 0.001) return null;
    return { anchor, forward: { x: dx / dist, z: dz / dist } };
  }

  // True when a cluster's mean position is past the tether distance in
  // front of the line anchor — i.e. the cluster has actually sallied.
  // A cluster inside the tether is the line's responsibility; a cluster
  // past it is exposed and needs its own cover.
  static _clusterPastTether(cluster, anchor, forward, tetherDist) {
    let sx = 0, sz = 0;
    for (const a of cluster.archers) { sx += a.center.x; sz += a.center.z; }
    const cx = sx / cluster.archers.length;
    const cz = sz / cluster.archers.length;
    const dx = cx - anchor.x;
    const dz = cz - anchor.z;
    return (dx * forward.x + dz * forward.z) > tetherDist;
  }

  static _clearAllEscorts(teamUnits, intents) {
    for (const u of teamUnits) {
      if (u.isDefeated()) continue;
      const t = unitTypeOf(u);
      if (!t || !isCavalryForAI(t)) continue;
      const intent = intents.get(u.id);
      if (!intent) continue;
      if (intent.escortArcherUnitIds) {
        intent.escortArcherUnitIds = null;
        intent.escortThreatUnitId = null;
      }
    }
  }
}