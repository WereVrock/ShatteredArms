// Top-level AI director. Owns one TeamAI per AI-controlled team and ticks
// them all once per BattleSimulation tick. Teams not listed here are left
// untouched (i.e. player-controlled).
//
// Unchanged in interface from before — BattleLineFormation is still used
// as-is (not modified in this pass); all the new intent/assessment/threat
// logic lives inside TeamAI and the behaviors it drives.
import { TeamAI } from './TeamAI.js';
import { BattleLineFormation } from './BattleLineFormation.js';

export class BattleAI {
  // options.valiantDefenceTeamIds: optional array of team ids that should
  // never adopt wholesale 'retreat' posture (see BattleAssessment /
  // TeamAI docs) — e.g. an intentionally outnumbered defender scenario
  // that should fight it out rather than immediately withdrawing.
  constructor(units, controlledTeamIds, options) {
    const opts = options || {};
    const useFormation = opts.useFormation !== false;
    // Difficulty tier. Two named presets only — see AITierConfig.js.
    // Defaults to 'best_possible' when unspecified.
    const tierName = opts.tierName || undefined;
    // Valiant defence defaults ON for every AI-controlled team: an
    // outnumbered AI fights it out rather than attempting a wholesale
    // withdrawal from tick 0, which is a bad experience to play against
    // and rarely produces interesting battles. The retreat POSTURE is
    // still computed and stored (rawPosture) — only the externally-read
    // posture is clamped — so debug logs and strengthRatio-based
    // decisions stay honest about the team's actual situation.
    //
    // Scenarios that specifically want to exercise retreat / rout /
    // pursuit should opt out by passing an explicit array (including an
    // empty one), e.g. `valiantDefenceTeamIds: []`. See BattleAssessment
    // and TeamAI docs for the unit-level semantics.
    const valiantDefenceTeamIds = new Set(
      opts.valiantDefenceTeamIds !== undefined
        ? opts.valiantDefenceTeamIds
        : controlledTeamIds
    );

    this.tierName = tierName;
    this.teamAIs = controlledTeamIds.map(teamId => {
      const teamUnits = units.filter(u => u.teamId === teamId);
      const formation = useFormation ? new BattleLineFormation() : null;
      const valiantDefence = valiantDefenceTeamIds.has(teamId);
      return new TeamAI(teamId, teamUnits, units, formation, tierName, valiantDefence);
    });
  }

  tick() {
    for (const ai of this.teamAIs) {
      ai.tick();
    }
  }
}