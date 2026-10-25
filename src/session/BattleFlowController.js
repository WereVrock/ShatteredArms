// ===== BattleFlowController.js =====
// Owns the four-state battle lifecycle for a single running battle:
//
//   'fighting'        — normal ticks. The sim runs until isBattleOver().
//   'awaiting-choice' — battle resolved with the player as winner AND
//                       enemy runners still on the field. The pursuit
//                       prompt is showing; the sim is frozen.
//   'pursuing'        — player chose PURSUE. The sim keeps ticking past
//                       the normal battle-over point until every fleeing
//                       enemy is dead or extracted.
//   'ended'           — resolved. onResolved has fired. Sim is stopped.
//
// The caller (main.js's RAF loop) still owns interval timing and the
// isPaused gate. It asks this controller, once per tick interval, "should
// we tick this frame, and if so, what fires as a side effect?" step()
// returns true when the sim ticked (so the caller drains combat and
// projectile events), false otherwise.
//
// All end-of-battle DOM (pursuit prompt, end-battle button) is delegated
// to PursuitUI. The final resolution — hand off to a campaign callback,
// or show a standalone result screen — is delegated to onResolved. This
// controller knows nothing about the campaign, the result screen, or
// persistence.

import { showPursuitPrompt, showEndBattleButton } from '../ui/PursuitUI.js';

export class BattleFlowController {
  // @param options.simulation      BattleSimulation instance.
  // @param options.playerTeamId    Team id the human controls.
  // @param options.onResolved      Optional. Called once, as
  //                                onResolved(outcome, simulation) where
  //                                outcome is 'won' or 'lost'.
  constructor({ simulation, playerTeamId, onResolved }) {
    this.simulation = simulation;
    this.playerTeamId = playerTeamId;
    this.onResolved = onResolved || null;

    this.state = 'fighting';
    // Handle returned by showEndBattleButton. Non-null only while
    // pursuing. Removed in _finish().
    this.endBattleHandle = null;
  }

  // Drives one tick-interval's worth of decision. Returns true if the sim
  // was ticked; the caller should then drain combat / projectile events.
  // Returns false for every non-ticking transition (ended, awaiting
  // choice, or a terminal state reached this frame).
  step() {
    if (this.state === 'ended' || this.state === 'awaiting-choice') {
      return false;
    }

    const battleOver = this.simulation.isBattleOver();
    const enemyRunners = this._enemyHasRunners();

    if (!battleOver) {
      // 'fighting' or 'pursuing' with runners still on the field.
      this.simulation.tick();
      return true;
    }

    if (this.state === 'pursuing') {
      if (enemyRunners) {
        // Chase continues — some runners are still on the field. Chasing
        // soldiers may catch and finish them before they reach the
        // boundary; runners who reach it are extracted and counted as
        // escaped for the campaign.
        this.simulation.tick();
        return true;
      }
      // No runners left — the chase is over.
      this._finish('won');
      return false;
    }

    // state === 'fighting' and battleOver is true — first moment the
    // battle resolved.
    const playerWon = this._playerHasFighters();
    if (playerWon && enemyRunners) {
      // Defer resolution: ask the player before deciding.
      this.state = 'awaiting-choice';
      showPursuitPrompt(
        () => this._startPursuit(),
        () => this._finish('won')
      );
    } else {
      // No prompt — either the player lost, or there are no runners to
      // pursue. Extract whatever runners exist and end.
      this._finish(playerWon ? 'won' : 'lost');
    }
    return false;
  }

  _startPursuit() {
    this.state = 'pursuing';
    // The "End Battle" button lets the player abandon the chase at any
    // moment. Any remaining runners are force-extracted when clicked,
    // exactly as if LET THEM FLEE had been chosen at the original prompt.
    this.endBattleHandle = showEndBattleButton(() => this._finish('won'));
  }

  // Terminal cleanup. Called exactly once per battle lifecycle.
  _finish(outcome) {
    if (this.endBattleHandle) {
      this.endBattleHandle.remove();
      this.endBattleHandle = null;
    }
    this.simulation.forceExtractRunners();
    this.state = 'ended';
    if (this.onResolved) this.onResolved(outcome, this.simulation);
  }

  // True if the player's team still has at least one alive soldier who is
  // not shattered. Used to distinguish "player won" (player has fighters)
  // from "player lost" (only enemies do).
  _playerHasFighters() {
    return this.simulation.units
      .filter(u => u.teamId === this.playerTeamId)
      .some(u => u.getAliveSoldiers().some(s => s.state !== 'shattered'));
  }

  // True if any non-player team currently has a routing or shattered
  // soldier still on the field.
  _enemyHasRunners() {
    const enemyTeamIds = new Set(
      this.simulation.units
        .map(u => u.teamId)
        .filter(id => id !== this.playerTeamId)
    );
    for (const tid of enemyTeamIds) {
      if (this.simulation.hasRunnersOnTeam(tid)) return true;
    }
    return false;
  }
}