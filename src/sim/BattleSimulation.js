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
import { ContactAttackSystem } from './ContactAttackSystem.js';
import { RoutingExtractionSystem } from './RoutingExtractionSystem.js';
import { BloodThrallSystem } from './BloodThrallSystem.js';
import { OrphanedMountSystem } from './OrphanedMountSystem.js';
import { CombatConfig } from '../config/CombatConfig.js';
import { AIDebugLog } from '../ai/AIDebugLog.js';

const ORDER_ARRIVAL_RADIUS = 0.75;

// The per-soldier power cache only feeds champion XP accrual, so a value a
// few ticks old is indistinguishable from a fresh one. Refreshing it every
// Nth tick removes a full per-soldier pass from most ticks.
const POWER_CACHE_INTERVAL_TICKS = 4;

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

    // Volley-fired hook: forwards to the AI director so it can apply a
    // queued repositioning order on the exact tick a volley releases.
    // The AI director is assigned externally after construction, so the
    // handler reads it lazily through `this` at call time. `teamId`
    // identifies which TeamAI to notify without a scan.
    this.rangedCombatSystem.onVolleyFired = (unitId, teamId) => {
      if (!this.battleAI || teamId == null) return;
      this.battleAI.onVolleyFired(unitId, teamId);
    };
    this.moraleSystem = new MoraleSystem(this.spatialGrid, this.playerTeamId);
    this.collisionSystem = new CollisionSystem(this.spatialGrid);
    this.boundsSystem = new BoundsSystem();
    // Passing-attack detection. Runs after CollisionSystem so all
    // position changes for the tick are final before contacts are
    // read, and before CombatResolutionSystem which consumes the
    // contact set. See ContactAttackSystem.
    this.contactAttackSystem = new ContactAttackSystem(this.spatialGrid);
    this.extractionSystem = new RoutingExtractionSystem(CombatConfig.mapBounds);
    // Blood Thrall lifecycle. Spawns, ages, and retires the animated dead
    // raised by the Blood Thrall champion skill. See BloodThrallSystem.js.
    this.bloodThrallSystem = new BloodThrallSystem();
    // Orphaned Mount lifecycle. Appends a riderless beast to the dying
    // blood guard's own unit when the champion's Orphaned Mount skill
    // rolls true. See OrphanedMountSystem.js.
    this.orphanedMountSystem = new OrphanedMountSystem();

    // Own tick counter. Used as the timestamp on debug-log events
    // (champion revive, and any future per-tick event source). Starts at
    // 0 and increments after each full tick block.
    this._tick = 0;

    // Optional AI director. Assigned externally (e.g. main.js) so teams
    // that should remain player-controlled are simply not attached.
    this.battleAI = null;

    // Debug history flag. Flips true the first time debug mode is
    // engaged in a battle (see main.js's debug-selection handler) and
    // stays true for the rest of the battle even if debug is toggled
    // off. When true, MoraleSystem attaches a per-tick morale breakdown
    // to EVERY soldier so the history log can name the specific sources
    // that drove each morale delta. False in normal play — zero
    // allocation, zero per-soldier debug state.
    this.debugHistoryEnabled = false;

    // Optional deployment phase. When set and active, tick() is a no-op —
    // no AI, no systems, no movement. Assigned externally after
    // construction. See src/deployment/DeploymentPhase.js.
    this.deploymentPhase = null;

    // Multiplayer mirror flag. When false, tick() early-returns before
    // running ANY system — the BattleSimulation is being used as a
    // passive mirror of a remote host's state, and the network layer
    // (GuestController) overwrites every mutable field from snapshots.
    // Default true so single-player is untouched.
    this.tickEnabled = true;

    // Optional per-section timing (see TickProfiler.js). Null in normal
    // play; the render diagnostic in main.js attaches one while profiling.
    this.tickProfile = null;
  }

  getAllSoldiers() {
    const all = [];
    for (const unit of this.units) {
      all.push(...unit.soldiers);
    }
    return all;
  }

  tick() {
    // Multiplayer mirror: no systems run at all. The network layer
    // overwrites every mutable field from snapshots; running systems on
    // top would fight the incoming state and produce drift.
    if (!this.tickEnabled) return;

    // Deployment phase: no sim systems run. AI and soldier behaviour are
    // frozen; the player can still reposition units instantly through
    // DeploymentPhase.playerMoveUnit (which teleports soldiers directly,
    // bypassing MovementSystem).
    if (this.deploymentPhase && this.deploymentPhase.isActive()) {
      return;
    }

    const prof = this.tickProfile;
    if (prof) prof.begin();

    const allSoldiers = this.getAllSoldiers();
    if (prof) prof.mark('getAll');

    // AI runs before the systems so any orders it issues are honoured by
    // movement/targeting within the same tick.
    if (this.battleAI) this.battleAI.tick();
    if (prof) prof.mark('ai');

    // Advance each unit's marching formation anchor BEFORE targeting/
    // movement read soldier state this tick — this is what makes a moving
    // formation (a 2x8 block marching, or chasing an attack-order target)
    // visibly travel together: every soldier's formationSlot is recomputed
    // from the anchor's current position before anyone paths toward it.
    for (const unit of this.units) {
      unit.reflowIfCasualties();
      unit.update(this.deltaSeconds, this.unitsById);
    }
    if (prof) prof.mark('unitUpdate');

    this.spatialGrid.rebuild(allSoldiers);
    if (prof) prof.mark('grid');
    this.targetingSystem.update(allSoldiers, this.unitsById);
    if (prof) prof.mark('targeting');
    this.movementSystem.update(allSoldiers, this.unitsById, this.deltaSeconds);
    if (prof) prof.mark('movement');
    this.collisionSystem.update(allSoldiers);
    if (prof) prof.mark('collision');
    this.contactAttackSystem.update(allSoldiers);
    if (prof) prof.mark('contact');
    this.threatFacingSystem.update(allSoldiers);
    if (prof) prof.mark('threatFacing');
    this.facingSystem.update(allSoldiers, this.unitsById);
    if (prof) prof.mark('facing');
    if ((this._tick % POWER_CACHE_INTERVAL_TICKS) === 0) {
      this._updateSoldierPowerCache();
    }
    if (prof) prof.mark('powerCache');
    this.combatResolutionSystem.update(allSoldiers, this.unitsById);
    if (prof) prof.mark('melee');
    this.rangedCombatSystem.update(allSoldiers, this.unitsById);
    if (prof) prof.mark('ranged');
    this.projectileSystem.update(allSoldiers, this.unitsById, this.deltaSeconds);
    if (prof) prof.mark('projectile');

    // Champion death check runs BEFORE morale so a Blood Pact revive
    // restores the champion before morale ticks — otherwise a freshly
    // revived champion would enter the tick with 0 morale and instantly
    // rout. See _checkChampionDeath.
    this._checkChampionDeath();

    // Blood Thralls: spawn any queued this tick, expire old ones, retarget.
    const pendingThralls = this.combatResolutionSystem.drainPendingThralls();
    const pendingMounts = this.combatResolutionSystem.drainPendingMounts();
    this.bloodThrallSystem.update(pendingThralls, this);
    this.orphanedMountSystem.update(pendingMounts, this);
    if (prof) prof.mark('champion');

    this.moraleSystem.update(allSoldiers, this.unitsById, this.debugHistoryEnabled);
    if (prof) prof.mark('morale');
    this.boundsSystem.update(allSoldiers);
    if (prof) prof.mark('bounds');
    this.extractionSystem.update(allSoldiers, this.unitsById);
    if (prof) prof.mark('extraction');

    for (const unit of this.units) {
      unit.clearOrderIfArrived(ORDER_ARRIVAL_RADIUS);
    }

    this._tick++;
    if (prof) {
      prof.mark('clearOrders');
      prof.end();
    }
  }

  // Blood Pact. When a champion soldier enters 'dead' state, check whether
  // that champion has the skill unlocked and has at least one living blood
  // guard in the same unit. If both hold: sacrifice every living guard,
  // revive the champion at its death position with hpPerGuard × guards HP.
  // The revive is instant, in-place, and consumes the guards (they cannot
  // be revived again this battle). Blood Pact can only fire once per
  // battle per champion because after it fires there are no guards left
  // to sacrifice.
  //
  // Runs every tick; is a cheap no-op unless a champion is dead. Multiple
  // champions are supported but not used today — the loop just walks every
  // unit and checks the championSoldier reference.
  _checkChampionDeath() {
    for (const unit of this.units) {
      const champ = unit.championSoldier;
      if (!champ) continue;
      if (champ.state !== 'dead') continue;

      const mods = champ.combatMods;
      const hpPerGuard = mods && mods.bloodPactHpPerGuard;
      if (!(hpPerGuard > 0)) continue;

      // Collect living guards in the champion's unit.
      const guards = [];
      for (const s of unit.soldiers) {
        if (s === champ) continue;
        if (!s.isBodyguard) continue;
        if (!s.isAlive()) continue;
        guards.push(s);
      }
      if (guards.length === 0) continue;

      // Sacrifice every guard. Silent deaths — they are spent, not killed.
      for (const g of guards) {
        g.hp = 0;
        g.state = 'dead';
        g.targetId = null;
      }

      // Revive the champion at the death position (champ.pos is where they
      // fell — the corpse has not moved since death).
      const revivedHp = hpPerGuard * guards.length;
      champ.hp = Math.min(champ.maxHp, revivedHp);
      champ.state = 'idle';
      champ.targetId = null;
      champ.isRouting = false;
      champ.morale = champ.maxMorale;

      // Log for debug history. Uses the morale channel so the timeline of
      // a battle shows the revive alongside other dramatic events.
      AIDebugLog.log('morale', this._tick,
        `BLOOD-PACT champion=${champ.id} guardsSacrificed=${guards.length} ` +
        `reviveHp=${champ.hp}/${champ.maxHp}`);
    }
  }

  // Refresh each soldier's cached soldierPowerCache. The cache is unit
  // power divided by the unit's non-routing alive count: "how much combat
  // value does one fighting soldier of this unit carry right now".
  // Consumed by CombatResolutionSystem when accruing champion combat XP
  // (one attack against an elite unit is worth more than one attack
  // against chaff).
  //
  // Cost: one UnitPower.compute per unit per refresh. Called every
  // POWER_CACHE_INTERVAL_TICKS ticks, not every tick — see the constant.
  _updateSoldierPowerCache() {
    for (const unit of this.units) {
      const fighters = unit.getNonRoutingAliveCount();
      if (fighters === 0) {
        for (const s of unit.soldiers) s.soldierPowerCache = 0;
        continue;
      }
      const total = unit.getPower().total;
      const perSoldier = total / fighters;
      for (const s of unit.soldiers) s.soldierPowerCache = perSoldier;
    }
  }

  // Battle is over when a team has no soldier that is alive and not
  // shattered. Routing soldiers count as still fighting — they may rally
  // back. Shattered soldiers do not count — their defeat is permanent, and
  // the battle can end while they are still running toward the boundary.
  //
  // Champion override: the moment a champion soldier is DEAD (not merely
  // extracted — an extracted champion routed off the field and survives,
  // the campaign continues), the battle ends immediately regardless of
  // either team's fighting strength. The campaign layer reads the same
  // champion-dead condition in handleBattleEnded and converts it into a
  // campaign-game-over. Ordering matters: this runs FIRST so a champion
  // death on the same tick as a wipe still reports the death.
  isBattleOver() {
    for (const unit of this.units) {
      const champ = unit.championSoldier;
      if (champ && champ.state === 'dead') return true;
    }

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