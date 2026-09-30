// A3: Cavalry flank leader/group coordination.
//
// Problem this replaces: FlankerBehavior._preferSiblingTarget compared each
// cavalry unit against every OTHER cavalry unit's current intent, pairwise,
// every decision cycle. With 2 units this converges; with 3+ it can
// ping-pong (A agrees with B, B agrees with C, C agrees with A) because
// there is no single source of truth for "what is this flank's target."
//
// Fix: group cavalry units by lateral position along the battle line's
// right-axis (same axis BattleLineFormation already uses for flank
// placement), so units that started on the same flank end up in the same
// group. Each group has exactly one deterministic leader — lowest unit id
// — so leader selection never thrashes tick to tick and a killed leader is
// trivially replaced (next-lowest id in the group) within one decision
// cycle with no election logic at all.
//
// Stateless: built fresh once per TeamAI decision cycle from current
// cavalry unit positions. No persistence needed — group membership only
// needs to be stable WITHIN a cycle (so leader and followers agree this
// cycle), not across cycles, since it's recomputed identically each time
// as long as relative positions haven't changed enough to matter.
import { AIConfig } from '../config/AIConfig.js';
import { isCavalry } from '../config/UnitClasses.js';
import { unitTypeOf } from './behaviorUtils.js';

export class CavalryGroup {
  constructor(leader, members) {
    this.leader = leader;
    // members includes the leader itself, for convenient iteration.
    this.members = members;
  }

  isLeader(unit) {
    return this.leader.id === unit.id;
  }

  followers() {
    return this.members.filter(u => u.id !== this.leader.id);
  }

  // Builds groups for one team's cavalry units, using the formation's line
  // axis to project each unit's lateral (right-axis) position. Units within
  // cavalryGroupLateralRadius of each other's running group centroid are
  // merged into the same group. Falls back to a single group containing
  // all cavalry if no axis is available (e.g. no enemies yet).
  //
  // Returns Map<unitId, CavalryGroup>.
  static build(cavalryUnits, axis) {
    const map = new Map();
    const alive = cavalryUnits.filter(u => !u.isDefeated());
    if (alive.length === 0) return map;

    // Deterministic base ordering by id so group formation (and therefore
    // leader choice) never depends on array iteration order elsewhere.
    const sorted = [...alive].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    if (!axis) {
      const group = new CavalryGroup(sorted[0], sorted);
      for (const u of sorted) map.set(u.id, group);
      return map;
    }

    const rightX = axis.rightX;
    const rightZ = axis.rightZ;

    const clusters = []; // { lateralSum, count, units[] }
    const radius = AIConfig.cavalryGroupLateralRadius;

    for (const u of sorted) {
      const c = u.getCenter();
      const lateral = c.x * rightX + c.z * rightZ;

      let best = null;
      let bestDist = Infinity;
      for (const cluster of clusters) {
        const clusterLateral = cluster.lateralSum / cluster.count;
        const dist = Math.abs(lateral - clusterLateral);
        if (dist < bestDist) {
          bestDist = dist;
          best = cluster;
        }
      }

      if (best && bestDist <= radius) {
        best.lateralSum += lateral;
        best.count += 1;
        best.units.push(u);
      } else {
        clusters.push({ lateralSum: lateral, count: 1, units: [u] });
      }
    }

    for (const cluster of clusters) {
      // Leader = lowest unit id within the cluster, deterministic and
      // stable regardless of which order units were merged in.
      const clusterSorted = [...cluster.units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const group = new CavalryGroup(clusterSorted[0], clusterSorted);
      for (const u of clusterSorted) map.set(u.id, group);
    }

    return map;
  }

  static cavalryUnitsOf(teamUnits) {
    return teamUnits.filter(u => {
      if (u.isDefeated()) return false;
      const type = unitTypeOf(u);
      return type && isCavalry(type);
    });
  }
}