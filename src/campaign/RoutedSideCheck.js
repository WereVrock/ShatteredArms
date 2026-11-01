// Early-end check for headless battles. A team is "broken" when it has no
// living soldier that is still fighting: every living soldier is routing
// or shattered (a team with no living soldiers at all counts too).
//
// The live game's BattleSimulation.isBattleOver deliberately counts
// routing soldiers as still fighting, since they can rally. The headless
// runner calls this separately and requires the condition to hold for a
// number of consecutive ticks before ending the battle.

function isRunner(soldier) {
  return soldier.isRouting
    || soldier.state === 'routing'
    || soldier.state === 'shattered';
}

export function isTeamBroken(units, teamId) {
  for (const unit of units) {
    if (unit.teamId !== teamId) continue;
    for (const s of unit.getAliveSoldiers()) {
      if (!isRunner(s)) return false;
    }
  }
  return true;
}

export function isEitherSideBroken(units) {
  return isTeamBroken(units, 'blue') || isTeamBroken(units, 'red');
}