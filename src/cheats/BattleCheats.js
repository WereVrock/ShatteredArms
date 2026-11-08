// ===== BattleCheats.js =====
// Debug cheats that act on a live BattleSimulation. Pure logic, no DOM.
// Each cheat is { id, label, description, run(sim, playerTeamId) } and
// returns a short status message for the panel.
//
// Kills use the same direct write BattleSimulation's Blood Pact path uses
// for silent deaths (hp 0, state 'dead'), so isBattleOver() and the
// campaign result see them like any other death.

import { CombatConfig } from '../config/CombatConfig.js';

function isEnemy(teamId, playerTeamId) {
  return teamId !== playerTeamId;
}

function isMine(teamId, playerTeamId) {
  return teamId === playerTeamId;
}

// Snapshot of living soldiers whose team passes `teamFilter`. Collected
// into an array first so a cheat never mutates while iterating live lists.
function livingSoldiers(sim, teamFilter) {
  const out = [];
  for (const unit of sim.units) {
    if (!teamFilter(unit.teamId)) continue;
    for (const s of unit.soldiers) {
      if (s.isAlive()) out.push(s);
    }
  }
  return out;
}

function killSoldier(s) {
  s.hp = 0;
  s.state = 'dead';
  s.targetId = null;
  s.contactTargetId = null;
  s.isRouting = false;
  s.isImpetuous = false;
}

export const BATTLE_CHEATS = [
  {
    id: 'battle-kill-enemies',
    label: 'Kill all enemies instantly',
    description: 'Every living enemy soldier dies. Close the panel to resume and end the battle.',
    run(sim, playerTeamId) {
      const targets = livingSoldiers(sim, t => isEnemy(t, playerTeamId));
      for (const s of targets) killSoldier(s);
      return `Killed ${targets.length} enemy soldiers.`;
    }
  },
  {
    id: 'battle-kill-mine',
    label: 'Kill all my units',
    description: 'Every living soldier of yours dies. Tests the defeat path (and champion death).',
    run(sim, playerTeamId) {
      const targets = livingSoldiers(sim, t => isMine(t, playerTeamId));
      for (const s of targets) killSoldier(s);
      return `Killed ${targets.length} of your soldiers.`;
    }
  },
  {
    id: 'battle-heal-mine',
    label: 'Heal my soldiers',
    description: 'Restores HP and shield HP of every living soldier of yours.',
    run(sim, playerTeamId) {
      const targets = livingSoldiers(sim, t => isMine(t, playerTeamId));
      for (const s of targets) {
        s.hp = s.maxHp;
        if (s.hasShield) s.shieldHp = CombatConfig.shieldMaxHp;
      }
      return `Healed ${targets.length} soldiers.`;
    }
  },
  {
    id: 'battle-refill-mine',
    label: 'Refill my morale and stamina',
    description: 'Sets morale to its current ceiling and stamina to 100 for your soldiers.',
    run(sim, playerTeamId) {
      const targets = livingSoldiers(sim, t => isMine(t, playerTeamId));
      for (const s of targets) {
        s.morale = s.maxMorale;
        s.fatigue = 100;
      }
      return `Refilled ${targets.length} soldiers.`;
    }
  },
  {
    id: 'battle-rally-mine',
    label: 'Rally my routing soldiers',
    description: 'Routing soldiers of yours return to the fight at full morale. Shattered ones stay shattered.',
    run(sim, playerTeamId) {
      const routers = livingSoldiers(sim, t => isMine(t, playerTeamId))
        .filter(s => s.state === 'routing');
      for (const s of routers) {
        s.isRouting = false;
        s.state = 'idle';
        s.targetId = null;
        s.morale = s.maxMorale;
      }
      return `Rallied ${routers.length} soldiers.`;
    }
  },
  {
    id: 'battle-crush-enemy-morale',
    label: 'Crush enemy morale',
    description: 'Sets enemy morale to 0 and lets the morale system rout them.',
    run(sim, playerTeamId) {
      const targets = livingSoldiers(sim, t => isEnemy(t, playerTeamId));
      for (const s of targets) s.morale = 0;
      return `Crushed morale of ${targets.length} enemy soldiers.`;
    }
  },
  {
    id: 'battle-freeze-ai',
    label: 'Freeze / resume enemy AI (toggle)',
    description: 'Detaches the BattleAI so no new orders are issued. Run again to restore it.',
    run(sim) {
      if (sim.battleAI) {
        sim._cheatSavedAI = sim.battleAI;
        sim.battleAI = null;
        return 'Enemy AI frozen.';
      }
      if (sim._cheatSavedAI) {
        sim.battleAI = sim._cheatSavedAI;
        sim._cheatSavedAI = null;
        return 'Enemy AI resumed.';
      }
      return 'This battle has no AI.';
    }
  },
  {
    id: 'battle-advance',
    label: 'Advance the sim by 1 second',
    description: 'Runs one second of ticks while the game is paused, for step-by-step debugging.',
    run(sim) {
      if (sim.deploymentPhase && sim.deploymentPhase.isActive()) {
        return 'Deployment is still active. Start the battle first.';
      }
      const ticks = Math.round(CombatConfig.tickRateHz);
      for (let i = 0; i < ticks; i++) sim.tick();
      return `Advanced ${ticks} ticks.`;
    }
  }
];