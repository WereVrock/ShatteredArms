// Owns the pre-battle state for the whole simulation.
//
// While active:
//   - BattleSimulation.tick() early-returns (no AI tick, no systems).
//   - Every team has been placed instantly — the player's teams via the
//     default template (player then repositions manually), and AI teams
//     via AIDeploymentDirector.decide().
//   - The player can reposition their own units instantly via playerMoveUnit
//     (single unit) or tryPlayerMoveBatch (atomic group move — used by the
//     formation drag in OrderDragController).
//   - startBattle() flips the active flag and fires the optional callback.
//
// Pure logic: no DOM, no rendering. The zone view and the Start Battle panel
// live elsewhere and are wired by main.js.
//
// Team ownership: playerTeamIds lists the team ids controlled by the human.
// Every other team is treated as AI-controlled and goes through
// AIDeploymentDirector. When playerTeamIds is empty, EVERY team is treated
// as AI — useful for AI-vs-AI observation scenarios; for the single-player
// game, main.js passes [scenario.playerTeamId].
import { DeploymentPlanner } from './DeploymentPlanner.js';
import { StandardDeployment } from './templates/StandardDeployment.js';
import { AIDeploymentDirector } from '../ai/AIDeploymentDirector.js';

export class DeploymentPhase {
  // opts:
  //   autoDeploy       — default true. When false, no team is auto-placed;
  //                      callers drive deployTeam() manually.
  //   templateIdByTeam — { [teamId]: templateId }, optional per-team override.
  //                      Applied to PLAYER teams only; AI teams go through
  //                      the director regardless of this map.
  //   playerTeamIds    — array of team ids controlled by the human. Every
  //                      other team is AI-controlled.
  //   aiDirector       — optional AIDeploymentDirector instance. Created
  //                      with defaults if not supplied.
  //   onBattleStart    — optional zero-arg callback fired once by startBattle().
  constructor(simulation, opts = {}) {
    this.simulation = simulation;
    this._active = true;

    this._planner = new DeploymentPlanner();
    this._planner.register(StandardDeployment);

    this._zones = new Map();          // teamId -> DeploymentZone
    this._templateIdByTeam = opts.templateIdByTeam || {};
    this._playerTeamIds = new Set(opts.playerTeamIds || []);
    this._aiDirector = opts.aiDirector || new AIDeploymentDirector();
    this._onBattleStart = opts.onBattleStart || null;

    if (opts.autoDeploy !== false) {
      this._autoDeployAllTeams();
    }
  }

  isActive() {
    return this._active;
  }

  getZone(teamId) {
    return this._zones.get(teamId) || null;
  }

  get zones() {
    return this._zones;
  }

  // Deploys one team and records its zone. Returns { zone, placements }.
  // Placements are applied immediately — this is an instant teleport, not a
  // move order (see Unit.issueInstantMoveOrder).
  deployTeam(teamId, teamUnits, enemyUnits, templateId) {
    const { zone, placements } = this._planner.plan(teamUnits, enemyUnits, templateId);
    if (zone) this._zones.set(teamId, zone);
    for (const p of placements) {
      p.unit.issueInstantMoveOrder(p.x, p.z, p.facing);
    }
    return { zone, placements };
  }

  // Player-initiated repositioning of a single unit. Rejects the move if
  // (a) deployment is no longer active, (b) the unit's team has no zone, or
  // (c) the destination is outside the zone. Facing is optional — the unit
  // keeps its current formationFacing if omitted.
  playerMoveUnit(unit, x, z, facing) {
    if (!this._active) return false;
    const zone = this._zones.get(unit.teamId);
    if (!zone) return false;
    if (!zone.contains(x, z)) return false;

    const f = facing !== undefined ? facing : unit.formationFacing;
    unit.issueInstantMoveOrder(x, z, f);
    return true;
  }

  // Atomic group move. Every entry in `moves` is validated FIRST; if any
  // destination falls outside its team's zone (or the team has no zone),
  // the whole batch is rejected and nothing moves. This is what makes a
  // formation drag predictable: you either get the full line in its new
  // position, or the drag silently does nothing — never a partial commit
  // where half the selection lands and half stays behind.
  //
  // Each entry: { unit, x, z, facing, widthUnits? }. widthUnits triggers
  // issueInstantFormationOrder (shape recompute + snap); omitted triggers
  // issueInstantMoveOrder (keep current shape, snap).
  tryPlayerMoveBatch(moves) {
    if (!this._active) return false;
    if (!moves || moves.length === 0) return false;

    for (const m of moves) {
      const zone = this._zones.get(m.unit.teamId);
      if (!zone) return false;
      if (!zone.contains(m.x, m.z)) return false;
    }

    for (const m of moves) {
      if (m.widthUnits) {
        m.unit.issueInstantFormationOrder(m.x, m.z, m.facing, m.widthUnits);
      } else {
        m.unit.issueInstantMoveOrder(m.x, m.z, m.facing);
      }
    }
    return true;
  }

  startBattle() {
    if (!this._active) return;
    this._active = false;
    if (this._onBattleStart) this._onBattleStart();
  }

  // Deploys every team in the simulation. Player teams use the per-team
  // template override (or fall through to the planner's default). AI teams
  // ask the director. Both paths end at deployTeam(), which applies
  // placements instantly.
  _autoDeployAllTeams() {
    const teamIds = new Set();
    for (const u of this.simulation.units) teamIds.add(u.teamId);

    for (const teamId of teamIds) {
      const teamUnits = this.simulation.units.filter(u => u.teamId === teamId);
      const enemyUnits = this.simulation.units.filter(u => u.teamId !== teamId);

      let templateId;
      if (this._playerTeamIds.has(teamId)) {
        templateId = this._templateIdByTeam[teamId];
      } else {
        const decision = this._aiDirector.decide(teamId, teamUnits, enemyUnits);
        templateId = decision.templateId;
      }

      this.deployTeam(teamId, teamUnits, enemyUnits, templateId);
    }
  }
}