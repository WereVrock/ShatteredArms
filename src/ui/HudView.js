// ===== HudView.js =====
// Pure UI: reads simulation state and writes text. No sim/combat logic.
//
// Layout (top to bottom):
//   [COPY ALL]                      <- always present
//   <text block>                    <- debug / selection / roster text
//   [Change History]                <- only while a debug target is live
//
// Debug-inspect mode (optional): setDebugInfo({ unit, intentInfo }) shows
// a detailed block for a single unit. When a debug target OR a normal unit
// selection is active, the top-of-panel list of every unit is suppressed.
//
// Change History: while a debug target is live, a per-unit history of
// every value change to that unit is rendered below the text block.
// History logging is battle-wide and permanent once engaged — see
// UnitHistoryRegistry for the enable lifecycle. The registry keeps
// tracking every unit even after the debug HUD is toggled off, so
// reinspecting a unit shows its full log since logging began.
//
// Tracker updates run once per SIM TICK, not per render frame. main.js
// calls notifySimTick() from inside the tick block; update() consumes the
// notification and feeds the registry. This is important — running the
// per-soldier diff at render fps would multiply the cost by the ratio of
// render fps to sim fps, and with every unit tracked that is the
// difference between a diagnostic tool and a framerate problem.
//
// Control hints are NOT here. They live in HelpPanel, opened from the "?"
// button in the top bar.
import { UnitHistoryRegistry } from './UnitHistoryRegistry.js';
import { UnitHistoryView } from './UnitHistoryView.js';
import { copyToClipboard } from './clipboard.js';

export class HudView {
  constructor(hudElement) {
    this.el = hudElement;
    this.debugInfo = null;

    // Wipe whatever placeholder the HTML had, then build our structure.
    this.el.innerHTML = '';

    // COPY button. Always present. Reads the current text block's content
    // on click so it always copies exactly what's on screen.
    this._copyBtn = document.createElement('button');
    this._copyBtn.type = 'button';
    this._copyBtn.textContent = 'COPY ALL';
    this._copyBtn.style.cssText = [
      'display:block',
      'width:100%',
      'margin:0 0 6px 0',
      'padding:3px 6px',
      'background:rgba(255,255,255,0.08)',
      'color:#ddd',
      'border:1px solid #555',
      'border-radius:3px',
      'cursor:pointer',
      'font:11px monospace',
      'letter-spacing:0.5px',
      'pointer-events:auto',
      'position:relative',
      'z-index:100'
    ].join(';');
    this._copyBtn.addEventListener('click', () => {
      console.log('[HudView] COPY ALL clicked');
      this._copyAll();
    });
    this.el.appendChild(this._copyBtn);

    // Text block. pre-wrap renders the newline-joined text as separate
    // lines. Capped at 30vh with its own scroll: a debug target with a
    // long intent block must not grow the panel past the viewport.
    this._textEl = document.createElement('div');
    this._textEl.style.cssText = [
      'white-space:pre-wrap',
      'font:12px monospace',
      'color:#ddd',
      'max-height:30vh',
      'overflow-y:auto',
      'pointer-events:auto',
      'scrollbar-width:thin',
      'scrollbar-color:#3a4a5e rgba(0,0,0,0)'
    ].join(';');
    this.el.appendChild(this._textEl);

    // Change History section. The registry owns the trackers; the view
    // renders whichever tracker matches the current debug target.
    this._historyRegistry = new UnitHistoryRegistry();
    this._historyView = new UnitHistoryView();
    this.el.appendChild(this._historyView.el);

    // Pending sim tick. Populated by notifySimTick() when main.js's loop
    // runs a battle tick; consumed and cleared by update(). Null when no
    // tick has run since the last update() — in which case the registry
    // is not fed, and no per-soldier diff work happens this frame.
    this._pendingSimTick = null;
  }

  // Called by main.js from INSIDE the sim-tick block, immediately after
  // the tick's combat-event queues have been drained. Stores the events
  // and arms the "there is a fresh sim tick" flag. update() reads and
  // clears this. The arrays are shared read-only with the renderer; no
  // consumer mutates them.
  notifySimTick(meleeEvents, rangedEvents) {
    this._pendingSimTick = {
      meleeEvents: meleeEvents || [],
      rangedEvents: rangedEvents || []
    };
  }

  // Called by main.js the first time a debug target is set. Idempotent.
  // After this, all units are tracked for the rest of the battle,
  // regardless of whether debug remains on.
  enableHistory() {
    this._historyRegistry.enable();
  }

  // Called at battle teardown. Currently not wired from main.js (a fresh
  // HudView is constructed per battle, so the registry dies with it) —
  // kept as an explicit method so a future "battle end" cleanup hook has
  // a place to call it without needing to know about the registry.
  resetHistory() {
    this._historyRegistry.reset();
  }

  setDebugInfo(info) {
    this.debugInfo = info || null;
  }

  update(units, allSoldiersById, selectedUnits) {
    const hasFocus =
      (selectedUnits && selectedUnits.size > 0) ||
      (this.debugInfo && this.debugInfo.unit && !this.debugInfo.unit.isDefeated());

    const debugUnit = (this.debugInfo
      && this.debugInfo.unit
      && !this.debugInfo.unit.isDefeated())
      ? this.debugInfo.unit
      : null;

    // Feed the history registry only when a sim tick has actually run.
    // The registry no-ops internally if it has not been enabled.
    if (this._pendingSimTick) {
      this._historyRegistry.update(
        units,
        this._pendingSimTick.meleeEvents,
        this._pendingSimTick.rangedEvents,
        allSoldiersById
      );
      this._pendingSimTick = null;
    }

    const lines = [];

    if (!hasFocus) {
      for (const u of units) {
        const alive = u.getAliveSoldiers().length;
        const sel = u.selected ? ' [SELECTED]' : '';
        lines.push(`${u.id} (${u.teamId}): ${alive}/${u.soldiers.length}${sel}`);
      }
    }

    if (selectedUnits && selectedUnits.size > 0) {
      const first = Array.from(selectedUnits)[0];
      const lead = first.getAliveSoldiers()[0];
      if (lead) {
        lines.push('');
        lines.push(`SELECTED ${first.id} lead soldier (${selectedUnits.size} unit(s)):`);
        lines.push(`  pos:      (${lead.pos.x.toFixed(2)}, ${lead.pos.z.toFixed(2)})`);
        lines.push(`  slot:     (${lead.formationSlot.x.toFixed(2)}, ${lead.formationSlot.z.toFixed(2)})`);
        lines.push(`  state:    ${lead.state}`);
        lines.push(`  hasOrder: ${first.hasActiveOrder}`);
        const leadMaxMorale = lead.maxMorale ?? 100;
        lines.push(`  morale:   ${lead.morale.toFixed(0)}/${leadMaxMorale}${lead.isRouting ? ' [ROUTING]' : ''}`);

        if (lead.unitTypeDef.isRanged) {
          const target = lead.targetId ? allSoldiersById.get(lead.targetId) : null;
          const dist = target
            ? Math.sqrt((target.pos.x - lead.pos.x) ** 2 + (target.pos.z - lead.pos.z) ** 2).toFixed(2)
            : 'n/a';
          lines.push(`  ARCHER targetId: ${lead.targetId ?? 'none'}`);
          lines.push(`  ARCHER distToTarget: ${dist}`);
          lines.push(`  ARCHER cooldown: ${lead.attackCooldownTicks}`);
        }
      }
    }

    if (debugUnit) this._appendDebugTarget(lines);

    this._textEl.textContent = lines.join('\n');

    // Render the history for whichever unit is currently inspected.
    // If no unit is inspected, the view hides — but the registry keeps
    // tracking every unit behind the scenes.
    const tracker = this._historyRegistry.get(debugUnit ? debugUnit.id : null);
    this._historyView.render(tracker, !!debugUnit);
  }

  _appendDebugTarget(lines) {
    const u = this.debugInfo.unit;
    const intentInfo = this.debugInfo.intentInfo;
    const alive = u.getAliveSoldiers();
    const center = u.getCenter();

    let engagedCount = 0;
    let routingCount = 0;
    let moraleSum = 0;
    let maxMoraleSum = 0;
    let maxFatigue = 0;
    for (const s of alive) {
      if (s.state === 'engaged' || s.state === 'staggered') engagedCount++;
      if (s.isRouting) routingCount++;
      moraleSum += s.morale;
      maxMoraleSum += (s.maxMorale ?? 100);
      if (s.fatigue > maxFatigue) maxFatigue = s.fatigue;
    }
    const avgMorale = alive.length > 0 ? moraleSum / alive.length : 0;
    const avgMaxMorale = alive.length > 0 ? maxMoraleSum / alive.length : 100;
    const engagedFrac = alive.length > 0 ? engagedCount / alive.length : 0;

    const type = (alive[0] && alive[0].unitTypeDef && alive[0].unitTypeDef.displayName) || '?';

    lines.push('');
    lines.push(`DEBUG TARGET ${u.id} (${u.teamId}):`);
    lines.push(`  type:            ${u.isUndead ? 'Skeleton ' : ''}${type}`);
    lines.push(`  alive:           ${alive.length} / ${u.soldiers.length}`);
    lines.push(`  center:          (${center.x.toFixed(2)}, ${center.z.toFixed(2)})`);
    lines.push(`  formationOrigin: (${u.formationOrigin.x.toFixed(2)}, ${u.formationOrigin.z.toFixed(2)})`);
    lines.push(`  hasActiveOrder:  ${u.hasActiveOrder}`);
    lines.push(`  orderTarget:     ${u.orderTarget ? `(${u.orderTarget.x.toFixed(2)}, ${u.orderTarget.z.toFixed(2)})` : 'none'}`);
    lines.push(`  focusTargetId:   ${u.focusTargetUnitId ?? 'none'}`);
    lines.push(`  engaged:         ${engagedCount} (${(engagedFrac * 100).toFixed(0)}%)`);
    lines.push(`  routing:         ${routingCount}`);
    lines.push(`  avgMorale:       ${avgMorale.toFixed(0)}/${avgMaxMorale.toFixed(0)}`);
    lines.push(`  maxFatigue:      ${maxFatigue.toFixed(0)}/100`);

    if (!intentInfo) {
      lines.push('  (no AI intent — player team or BattleAI shape not recognized)');
      return;
    }

    const tick = intentInfo.currentTick;
    lines.push(`  --- AI TEAM ${intentInfo.teamId} ---`);
    if (intentInfo.posture) {
      const strength = intentInfo.strengthRatio != null ? intentInfo.strengthRatio.toFixed(2) : '?';
      const morale = intentInfo.moraleAdvantage != null ? intentInfo.moraleAdvantage.toFixed(1) : '?';
      lines.push(`  posture:         ${intentInfo.posture} (strength=${strength}, moraleAdv=${morale})`);
    }
    if (intentInfo.planTactic) {
      lines.push(`  plan:            ${intentInfo.planTactic} — phase ${intentInfo.planPhase}`);
    } else {
      lines.push('  plan:            none');
    }
    if (intentInfo.objectiveUnitId) {
      lines.push(`  team objective:  ${intentInfo.objectiveUnitId}`);
    }

    const intent = intentInfo.intent;
    if (!intent) {
      lines.push('  intent:          none');
      return;
    }

    lines.push('  --- INTENT ---');
    // phase: only cavalry transitions through this state machine
    // (seeking → committed → regrouping). Line and archer behaviours
    // never call commitTo/beginRegroup, so they sit in 'seeking'
    // permanently — it is the resting state, not a decision in progress.
    const typeDefForPhase = alive[0] && alive[0].unitTypeDef;
    const isCavPhase = !!(typeDefForPhase && (typeDefForPhase.isCavalry || typeDefForPhase.countsAsCavalry));
    lines.push(`  phase:           ${intent.phase}${isCavPhase ? '' : ' (resting; non-cav)'}`);
    lines.push(`  target:          ${intent.targetUnitId ?? 'none'}`);
    if (intent.lastFailedTargetUnitId) {
      lines.push(`  lastFailedTarget: ${intent.lastFailedTargetUnitId}`);
    }
    if (tick != null) {
      lines.push(`  timeInPhase:     ${tick - intent.formedAtTick} ticks (formed@${intent.formedAtTick})`);
      if (intent.enteredMeleeAtTick != null) {
        lines.push(`  timeInMelee:     ${tick - intent.enteredMeleeAtTick} ticks`);
      } else {
        lines.push('  timeInMelee:     not in melee');
      }
    }
    lines.push(`  committedBraced: ${intent.committedBracedCount}`);
    // hasEscort: cavalry-cover status. Only meaningful for ranged units
    // (set by ArcherSupportCoordinator each cycle), but harmless to show
    // on any unit type — line/cav units leave it at its initial false.
    // `true`  → archer advances to standoff.
    // `false` → archer hugs the melee line (unless tether-released).
    if (typeof intent.hasEscort === 'boolean') {
      lines.push(`  hasEscort:       ${intent.hasEscort}`);
    }
    // lastIntentKey: the last ranged-decision intent that was actually
    // ISSUED (e.g. 'move:hug', 'move:standoff', 'focus:...'). Tells you
    // which positioning branch the archer is on, and whether it is
    // currently moving (fresh key) or holding (key unchanged). Distinct
    // from lastIssuedX/Z which record the destination.
    if (intent.lastIntentKey) {
      lines.push(`  lastIntentKey:   ${intent.lastIntentKey}`);
    }
    if (intent.threatUnitId) {
      lines.push(`  threatUnitId:    ${intent.threatUnitId}`);
    }
    if (intent.blockedTargetUntil && intent.blockedTargetUntil.size > 0) {
      const entries = [];
      for (const [id, until] of intent.blockedTargetUntil) {
        const remaining = (tick != null) ? Math.max(0, until - tick) : '?';
        entries.push(`${id}(+${remaining}t)`);
      }
      lines.push(`  blocked targets: ${entries.join(' ')}`);
    }
  }

  async _copyAll() {
    const text = this._textEl.textContent || '';
    const original = this._copyBtn.textContent;
    const ok = await copyToClipboard(text);
    console.log('[HudView] copy result:', ok ? 'COPIED' : 'FAILED');
    this._copyBtn.textContent = ok ? 'COPIED' : 'FAILED';
    setTimeout(() => { this._copyBtn.textContent = original; }, 900);
  }
}