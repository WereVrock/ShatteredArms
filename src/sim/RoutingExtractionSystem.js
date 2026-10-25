// ===== src/sim/RoutingExtractionSystem.js =====
// Removes routing soldiers that have fled past the map edge and records
// them for the campaign layer.
//
// Runs LAST in the BattleSimulation tick order, after MoraleSystem has had
// a chance to set a soldier's state to 'routing'. When a routing soldier's
// position exits the configured mapBounds, their state becomes 'extracted'
// — treated as non-alive by Soldier.isAlive() and therefore excluded from
// targeting, movement, and combat resolution identically to 'dead'. The
// difference is only that extracted soldiers are RECORDED, so a campaign
// can later roll for their return in a subsequent battle.
//
// Standalone scenarios don't read the record; extracted soldiers are simply
// lost, which is the intended feel for a one-off battle.
//
// Grouped by unitId so the campaign layer can reason per-unit: "did
// Blue Spearman #3 have survivors who escaped, and how many?" rather than
// working from a flat soldier list.

export class RoutingExtractionSystem {
  constructor(bounds) {
    this.bounds = bounds;
    // Map<unitId, { unitId, teamId, typeId, isUndead, escapedCount }>.
    // Populated lazily per unit the first time one of its soldiers
    // extracts.
    this._record = new Map();
  }

  update(allSoldiers, unitsById) {
    const b = this.bounds;
    for (const soldier of allSoldiers) {
      // Routing and shattered soldiers can both be extracted. From the
      // campaign layer's perspective they are indistinguishable — an
      // escapee is an escapee. The record does not track which state
      // the soldier was in when they crossed the boundary.
      if (soldier.state !== 'routing' && soldier.state !== 'shattered') continue;

      const { x, z } = soldier.pos;
      if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) continue;

      this._extract(soldier, unitsById);
    }
  }

  _extract(soldier, unitsById) {
    // Terminal state. Soldier.isAlive() returns false for 'extracted',
    // which is what removes them from every system that filters on
    // isAlive() — targeting, movement, combat, morale, collision.
    soldier.state = 'extracted';
    soldier.targetId = null;
    soldier.isRouting = false;

    let entry = this._record.get(soldier.unitId);
    if (!entry) {
      const unit = unitsById ? unitsById.get(soldier.unitId) : null;
      const typeDef = unit && unit.soldiers.length > 0
        ? unit.soldiers[0].unitTypeDef
        : soldier.unitTypeDef;
      entry = {
        unitId: soldier.unitId,
        teamId: soldier.teamId,
        typeId: typeDef ? typeDef.id : null,
        isUndead: !!soldier.isUndead,
        escapedCount: 0
      };
      this._record.set(soldier.unitId, entry);
    }
    entry.escapedCount++;
  }

  // Force-extract every soldier currently in 'routing' or 'shattered' state,
  // regardless of position. Called by BattleSimulation when the battle has
  // ended and runners remaining on the field are treated as having escaped.
  // This is how a shattered soldier who never physically reached the map
  // boundary still ends up in the extraction record.
  extractAllRoutingAndShattered(allSoldiers, unitsById) {
    for (const soldier of allSoldiers) {
      if (soldier.state === 'routing' || soldier.state === 'shattered') {
        this._extract(soldier, unitsById);
      }
    }
  }

  // Plain array of extracted-unit records, JSON-serializable. Each entry:
  // { unitId, teamId, typeId, isUndead, escapedCount }. Empty array if
  // nothing extracted this battle.
  getExtractions() {
    return [...this._record.values()];
  }

  // Total extracted soldier count across all units — debug / test helper.
  getExtractedSoldierCount() {
    let n = 0;
    for (const entry of this._record.values()) n += entry.escapedCount;
    return n;
  }
}