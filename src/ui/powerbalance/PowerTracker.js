// Non-UI data model for the power widgets. Reads simulation units and
// keeps, per team, the current power and the number of soldiers still
// fighting, plus an opening baseline captured the first tick there is
// anything to measure.
//
// Routing and shattered soldiers are excluded from both teams' sums --
// they have left the fight even though their bodies are still on the
// field, and counting them would misreport a collapsing line as full
// strength. Same rule as every other power read in the game. The soldier
// count follows the same rule: it counts fighters, not everyone alive.
import { buildPreviewUnit } from '../../campaign/UnitPreview.js';
import { LEFT_TEAM, RIGHT_TEAM } from './PowerWidgetTheme.js';

export class PowerTracker {
  constructor() {
    // { blue: { power, soldiers }, red: { power, soldiers } }
    this.current = {
      blue: { power: 0, soldiers: 0 },
      red:  { power: 0, soldiers: 0 }
    };
    // Same shape as `current`, or null until the baseline is captured.
    // Fixed for the rest of the battle -- readings are CURRENT vs.
    // STARTING, not current vs. current. reset() clears it.
    this.start = null;
  }

  update(units) {
    const blue = { power: 0, soldiers: 0 };
    const red  = { power: 0, soldiers: 0 };

    for (const unit of units) {
      const lead = unit.soldiers && unit.soldiers[0];
      const typeDef = lead && lead.unitTypeDef;
      if (!typeDef) continue;

      // Fighters only: alive and not routing/shattered.
      let fighters = 0;
      for (const s of unit.soldiers) {
        if (!s.isAlive()) continue;
        if (s.state === 'routing' || s.state === 'shattered') continue;
        fighters++;
      }

      let team = null;
      if (unit.teamId === LEFT_TEAM) team = blue;
      else if (unit.teamId === RIGHT_TEAM) team = red;
      if (!team) continue;

      // Power for the unit's current FIGHTER count, at full health. Built
      // as a preview so the number comes from UnitPower.compute — the
      // single formula the AI, Custom Battle, and campaign pricing all
      // read. Soldier state (fatigue, morale, HP damage) is deliberately
      // not folded in: this widget tracks losses, not degradation, and
      // the opening baseline captured below is also a losses-only read,
      // so current-vs-start stays apples-to-apples.
      const preview = buildPreviewUnit({
        id: `power-${unit.id}`,
        typeDef,
        isUndead: unit.isUndead,
        aliveCount: fighters,
        maxCount: fighters,
        teamId: unit.teamId
      });
      team.power += preview.getPower().total;
      team.soldiers += fighters;
    }

    this.current = { blue: blue, red: red };

    // Capture the baseline the first tick there is anything to measure.
    // A battle that has not yet deployed has total 0; we wait for the
    // first real read so the baseline is the OPENING state of the fight,
    // not the pre-deployment void.
    if (this.start === null && blue.power + red.power > 0) {
      this.start = {
        blue: { power: blue.power, soldiers: blue.soldiers },
        red:  { power: red.power,  soldiers: red.soldiers }
      };
    }
  }

  // Current power divided by starting power for one team. No baseline yet
  // (or a zero baseline) reads as 1.0 -- "no information yet" -- which
  // keeps every sword segment intact.
  startRatio(teamId) {
    if (this.start === null) return 1;
    const start = this.start[teamId].power;
    if (!(start > 0)) return 1;
    return this.current[teamId].power / start;
  }

  // Re-baseline. Call on battle restart so the next update captures a
  // fresh opening state.
  reset() {
    this.start = null;
  }
}