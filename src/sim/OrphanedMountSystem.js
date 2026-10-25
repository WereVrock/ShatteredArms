// ===== src/sim/OrphanedMountSystem.js =====
// Handles the Orphaned Mount champion skill: when a mounted blood guard
// dies with the skill unlocked and the roll succeeds, its beast survives
// as a riderless mount.
//
// Runs in BattleSimulation's post-combat pass, immediately after
// BloodThrallSystem has spawned any thralls raised this tick. The queue
// is produced by CombatResolutionSystem._applyDamageToSoldier — see the
// pendingMounts push there.
//
// Design:
//   - The beast is appended to the dying guard's OWN unit (the warlord's
//     retinue). It does not get a unit of its own and does not join any
//     thrall unit.
//   - Not a bodyguard. isBodyguard is cleared, so the beast does not
//     count for Interpose, Shoulder to Shoulder, or Blood Debt.
//   - Keeps championRef so its kills still count as retinue kills for
//     the Blood Thrall skill (see
//     CombatResolutionSystem._maybeRaiseThrallFromKiller), AND so its
//     combat XP still shares half to the champion at the same rate a
//     living blood guard's does. The XP share is admitted explicitly
//     in CombatResolutionSystem._accrueChampionXp — isBodyguard alone
//     would exclude the mount.
//   - Renders alone (no rider body, shield, or weapon) via the
//     'riderlessBeast' body variant — see SoldierModelComposer.
//   - Excluded from the campaign roster's alive count in
//     CampaignFlow.handleBattleEnded, so it does not persist between
//     battles.
//
// This is a SEPARATE system from BloodThrallSystem on purpose: a
// riderless mount is not a thrall, uses none of the thrall lifecycle
// machinery (no HP drain, no auto-target, no merge), and shares nothing
// with it except the fact that both spawn during the post-combat pass.

import { Soldier } from './Soldier.js';

export class OrphanedMountSystem {
  // Called once per sim tick from BattleSimulation, right after
  // BloodThrallSystem.update().
  //
  // `pendingMounts` — raise descriptors from CombatResolutionSystem.
  // `simulation`    — the live BattleSimulation; used for the
  //                    unitsById lookup that resolves the parent unit.
  update(pendingMounts, simulation) {
    if (!pendingMounts || !simulation) return;

    for (const spec of pendingMounts) {
      this._spawn(spec, simulation);
    }
  }

  // Appends a riderless mount to the dying guard's unit. See the file
  // header for the design contract.
  _spawn(spec, simulation) {
    if (!spec || !spec.sourceTypeDef || !spec.unitId) return;

    const unit = simulation.unitsById.get(spec.unitId);
    if (!unit) return;

    const soldier = new Soldier({
      unitId: unit.id,
      teamId: spec.teamId,
      unitTypeDef: spec.sourceTypeDef,
      x: spec.pos.x,
      z: spec.pos.z,
      facing: spec.facing || 0,
      isUndead: false,
    });

    // Flip the body variant — the composer will skip the rider body,
    // shield, and weapon from now on. See Soldier.setRiderlessMount.
    soldier.setRiderlessMount(true);

    // A riderless beast carries no shield.
    soldier.hasShield = false;
    soldier.shieldHp = 0;

    // Not a bodyguard. The only thing it inherits from the retinue is
    // the championRef back-reference, which is what lets its kills
    // raise blood thralls.
    soldier.isBodyguard = false;
    soldier.championRef = spec.championRef || null;

    unit.addSoldier(soldier);
    // Re-lay-out the formation so the new soldier gets a slot. The
    // beast walks from its spawn position to that slot like any other
    // soldier.
    unit._layoutGrid(unit.formationCols, unit.getFormationSpacing());
  }
}