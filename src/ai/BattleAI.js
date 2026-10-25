// Top-level AI director. Owns one TeamAI per AI-controlled team and ticks
// them all once per BattleSimulation tick. Teams not listed here are left
// untouched (i.e. player-controlled).
//
// Unchanged in interface from before — BattleLineFormation is still used
// as-is (not modified in this pass); all the new intent/assessment/threat
// logic lives inside TeamAI and the behaviors it drives.
import { TeamAI } from './TeamAI.js';
import { BattleLineFormation } from './BattleLineFormation.js';
import { AITierPreference } from '../config/AITierPreference.js';

export class BattleAI {
  // options.valiantDefenceTeamIds: optional array of team ids that should
  // never adopt wholesale 'retreat' posture (see BattleAssessment /
  // TeamAI docs) — e.g. an intentionally outnumbered defender scenario
  // that should fight it out rather than immediately withdrawing.
  constructor(units, controlledTeamIds, options) {
    const opts = options || {};
    const useFormation = opts.useFormation !== false;
    // Difficulty tier resolution, in priority order:
    //
    //   1. opts.tierNameByTeamId[teamId] — a per-team override, used by
    //      Custom Battle so each AI side can run at a different tier.
    //      Missing / unrecognised entries fall through to (2).
    //   2. opts.tierName — a single-tier override for scripted scenarios
    //      and tests. Unchanged from before this patch.
    //   3. AITierPreference.get() — the persisted global preference,
    //      written by the AITierPicker on the scenario menu. Always
    //      returns a valid tier name (default 'best_possible').
    //
    // Scenarios that don't supply a per-team map (PlayableScenarios,
    // campaign battles, MP) fall through to (2) / (3) unchanged.
    const defaultTierName = opts.tierName || AITierPreference.get();
    const tierNameByTeamId = opts.tierNameByTeamId || null;
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

    // Exposed as the "default" tier for any consumer that wants a single
    // value; the per-team resolution below is authoritative for the
    // teams themselves.
    this.tierName = defaultTierName;
    this.teamAIs = controlledTeamIds.map(teamId => {
      const teamUnits = units.filter(u => u.teamId === teamId);
      const formation = useFormation ? new BattleLineFormation() : null;
      const valiantDefence = valiantDefenceTeamIds.has(teamId);
      const teamTierName =
        (tierNameByTeamId && tierNameByTeamId[teamId]) || defaultTierName;
      return new TeamAI(teamId, teamUnits, units, formation, teamTierName, valiantDefence);
    });
  }

  tick() {
    for (const ai of this.teamAIs) {
      ai.tick();
    }
  }

  // Forwarded from BattleSimulation the instant a volley releases for a
  // unit. Dispatches to whichever TeamAI owns that unit — the team that
  // owns a unit is the one that may have queued a reposition for it.
  // teamId identifies the owner without a scan; if it does not match any
  // controlled team, nothing happens (the volley was for a player team,
  // which does not use the queue).
  onVolleyFired(unitId, teamId) {
    for (const ai of this.teamAIs) {
      if (ai.teamId === teamId) {
        ai.onVolleyFired(unitId);
        return;
      }
    }
  }
}