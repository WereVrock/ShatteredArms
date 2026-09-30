// ===== BattleSimulation.js =====
import { SpatialGrid } from './SpatialGrid.js';
import { TargetingSystem } from './TargetingSystem.js';
import { MovementSystem } from './MovementSystem.js';
import { ThreatFacingSystem } from './ThreatFacingSystem.js';
import { FacingSystem } from './FacingSystem.js';
import { CombatResolutionSystem } from './CombatResolutionSystem.js';
import { RangedCombatSystem } from './RangedCombatSystem.js';
import { ProjectileSystem } from './ProjectileSystem.js';
import { MoraleSystem } from './MoraleSystem.js';
import { CollisionSystem } from './CollisionSystem.js';
import { BoundsSystem } from './BoundsSystem.js';
import { RoutingExtractionSystem } from './RoutingExtractionSystem.js';
import { CombatConfig } from '../config/CombatConfig.js';

const ORDER_ARRIVAL_RADIUS = 0.75;

// Owns sim state and drives one fixed tick of all systems in order.
export class BattleSimulation {
  constructor(units, options = {}) {
    this.units = units;
    this.unitsById = new Map(units.map(u => [u.id, u]));

    // Which team is the player. Used by MoraleSystem for the shatter
    // strength threshold (10% player vs 20% enemy). Default 'blue' matches
    // the convention used by scenario definitions; campaigns pass the
    // actual value from the scenario object.
    this.playerTeamId = options.playerTeamId || 'blue';

    this.spatialGrid = new SpatialGrid(2.0);
    this.targetingSystem = new TargetingSystem(this.spatialGrid);
    this.movementSystem = new MovementSystem(this.spatialGrid);
    this.deltaSeconds = 1 / CombatConfig.tickRateHz;
    this.threatFacingSystem = new ThreatFacingSystem();
    this.facingSystem = new FacingSystem(this.deltaSeconds, this.spatialGrid);
    this.combatResolutionSystem = new CombatResolutionSystem();
    // Arrows are sim-authoritative: ProjectileSystem advances each
    // in-flight arrow and resolves collisions (including cross-unit
    // friendly fire) against every living soldier in range.
    // RangedCombatSystem spawns into it and no longer resolves damage.
    this.projectileSystem = new ProjectileSystem(this.spatialGrid);
    this.rangedCombatSystem = new RangedCombatSystem(this.projectileSystem);
    this.moraleSystem = new MoraleSystem(this.spatialGrid, this.playerTeamId);
    this.collisionSystem = new CollisionSystem(this.spatialGrid);
    this.boundsSystem = new BoundsSystem();
    this.extractionSystem = new RoutingExtractionSystem(CombatConfig.mapBounds);

    // Optional AI director. Assigned externally (e.g. main.js) so teams
    // that should remain player-controlled are simply not attached.
    this.battleAI = null;

    // Optional deployment phase. When set and active, tick() is a no-op —
    // no AI, no systems, no movement. Assigned externally after
    // construction. See src/deployment/DeploymentPhase.js.
    this.deploymentPhase = null;
  }

  getAllSoldiers() {
    const all = [];
    for (const unit of this.units) {
      all.push(...unit.soldiers);
    }
    return all;
  }

tick() {
    // Deployment phase: no sim systems run. AI and soldier behaviour are
    // frozen; the player can still reposition units instantly through
    // DeploymentPhase.playerMoveUnit (which teleports soldiers directly,
    // bypassing MovementSystem).
    if (this.deploymentPhase && this.deploymentPhase.isActive()) {
      return;
    }

    const allSoldiers = this.getAllSoldiers();

    // AI runs before the systems so any orders it issues are honoured by
    // movement/targeting within the same tick.
    if (this.battleAI) this.battleAI.tick();

    // Advance each unit's marching formation anchor BEFORE targeting/
    // movement read soldier state this tick — this is what makes a moving
    // formation (a 2x8 block marching, or chasing an attack-order target)
    // visibly travel together: every soldier's formationSlot is recomputed
    // from the anchor's current position before anyone paths toward it.
    for (const unit of this.units) {
      unit.update(this.deltaSeconds, this.unitsById);
    }

    this.spatialGrid.rebuild(allSoldiers);
    this.targetingSystem.update(allSoldiers, this.unitsById);
    this.movementSystem.update(allSoldiers, this.unitsById, this.deltaSeconds);
    this.collisionSystem.update(allSoldiers);
    this.threatFacingSystem.update(allSoldiers);
    this.facingSystem.update(allSoldiers, this.unitsById);
    this.combatResolutionSystem.update(allSoldiers, this.unitsById);
    this.rangedCombatSystem.update(allSoldiers, this.unitsById);
    this.projectileSystem.update(allSoldiers, this.unitsById, this.deltaSeconds);
    this.moraleSystem.update(allSoldiers, this.unitsById);
    this.boundsSystem.update(allSoldiers);
    this.extractionSystem.update(allSoldiers, this.unitsById);

    for (const unit of this.units) {
      unit.clearOrderIfArrived(ORDER_ARRIVAL_RADIUS);
    }
  }

  // Battle is over when a team has no soldier that is alive and not
  // shattered. Routing soldiers count as still fighting — they may rally
  // back. Shattered soldiers do not count — their defeat is permanent, and
  // the battle can end while they are still running toward the boundary.
  isBattleOver() {
    const teamIds = new Set(this.units.map(u => u.teamId));
    for (const teamId of teamIds) {
      const teamUnits = this.units.filter(u => u.teamId === teamId);
      const teamHasFighters = teamUnits.some(u =>
        u.getAliveSoldiers().some(s => s.state !== 'shattered')
      );
      if (!teamHasFighters) return true;
    }
    return false;
  }

  // Force-extract every routing or shattered soldier still on the field.
  // Called when the battle has definitively ended: any runner remaining is
  // treated as having escaped the field. This makes the extraction record
  // complete before the campaign layer reads it.
  forceExtractRunners() {
    const allSoldiers = this.getAllSoldiers();
    this.extractionSystem.extractAllRoutingAndShattered(allSoldiers, this.unitsById);
  }

  // Does the given team currently have any soldier in 'routing' or
  // 'shattered' state still on the field? Used by the pursuit prompt:
  // when the winning team is the player and the losing team still has
  // runners, the player is asked whether to pursue or let them flee.
  hasRunnersOnTeam(teamId) {
    return this.units
      .filter(u => u.teamId === teamId)
      .some(u => u.getAliveSoldiers().some(s =>
        s.state === 'routing' || s.state === 'shattered'
      ));
  }
}