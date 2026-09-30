// ===== HudView.js =====
// Pure UI: reads simulation state and writes text. No sim/combat logic.
//
// Layout (top to bottom):
//   [COPY ALL button]
//   <text block>
//
// The text block is one <div> with white-space: pre-wrap — every line of
// HUD text goes into it. The button sits above it and persists across
// updates; update() only rewrites the text div's content, so the button
// keeps its event listener for the lifetime of the panel.
//
// Debug-inspect mode (optional): setDebugInfo({ unit, intentInfo }) shows
// a detailed block for a single unit. When a debug target OR a normal unit
// selection is active, the top-of-panel list of every unit is suppressed —
// the panel becomes "about that one unit", not a scoreboard.
export class HudView {
  constructor(hudElement) {
    this.el = hudElement;
    this.debugInfo = null;

    // Wipe whatever placeholder the HTML had, then build our structure.
    this.el.innerHTML = '';

    // COPY button. Reads the current text block's content on click so it
    // always copies exactly what's on screen. Brief "COPIED" feedback
    // without changing the button's identity (listener survives).
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
      // #hud in style.css typically has pointer-events: none so the HUD
      // doesn't block canvas clicks. Force the button back on so its click
      // handler actually fires. z-index keeps it above any HUD siblings.
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
    // lines, matching how the previous single-element version behaved.
    this._textEl = document.createElement('div');
    this._textEl.style.cssText = 'white-space:pre-wrap;font:12px monospace;color:#ddd;';
    this.el.appendChild(this._textEl);
  }

  // Set (or clear, with null) the debug-inspect target. Safe to call every
  // frame; no side effects on the sim.
  setDebugInfo(info) {
    this.debugInfo = info || null;
  }

  update(units, allSoldiersById, selectedUnits) {
    const hasFocus =
      (selectedUnits && selectedUnits.size > 0) ||
      (this.debugInfo && this.debugInfo.unit && !this.debugInfo.unit.isDefeated());

    const lines = [];

    // Per-unit list is suppressed whenever the panel has a single-unit
    // focus (selection or debug target). Keeps the panel readable instead
    // of forcing the user to scroll past the roster to reach the details.
    if (!hasFocus) {
      for (const u of units) {
        const alive = u.getAliveSoldiers().length;
        const sel = u.selected ? ' [SELECTED]' : '';
        lines.push(`${u.id} (${u.teamId}): ${alive}/${u.soldiers.length}${sel}`);
      }
    }

    // Lead-soldier breakdown for the first selected unit. Unchanged from
    // the original HUD — this is player-facing order info, not AI state.
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
        lines.push(`  morale:   ${lead.morale.toFixed(0)}/100${lead.isRouting ? ' [ROUTING]' : ''}`);

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

    if (this.debugInfo && this.debugInfo.unit && !this.debugInfo.unit.isDefeated()) {
      this._appendDebugTarget(lines);
    }

    lines.push('');
    lines.push('Space: pause / unpause. Orders can still be issued while paused.');
    lines.push('Left-click: select. Left-drag: box-select. Shift+drag: add to selection.');
    lines.push('Right-click/hold on ground: move + set facing (preview shown), release to march.');
    lines.push('Right-click enemy unit: attack that unit. MMB-drag: orbit. LMB+RMB drag: pan. WASD: pan (camera-relative). Scroll: zoom.');

    this._textEl.textContent = lines.join('\n');
  }

  _appendDebugTarget(lines) {
    const u = this.debugInfo.unit;
    const intentInfo = this.debugInfo.intentInfo;
    const alive = u.getAliveSoldiers();
    const center = u.getCenter();

    let engagedCount = 0;
    let routingCount = 0;
    let moraleSum = 0;
    let maxFatigue = 0;
    for (const s of alive) {
      if (s.state === 'engaged' || s.state === 'staggered') engagedCount++;
      if (s.isRouting) routingCount++;
      moraleSum += s.morale;
      if (s.fatigue > maxFatigue) maxFatigue = s.fatigue;
    }
    const avgMorale = alive.length > 0 ? moraleSum / alive.length : 0;
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
    lines.push(`  avgMorale:       ${avgMorale.toFixed(0)}/100`);
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
    lines.push(`  phase:           ${intent.phase}`);
    lines.push(`  target:          ${intent.targetUnitId ?? 'none'}`);
    if (intent.lastFailedTargetUnitId) {
      lines.push(`  lastFailedTarget: ${intent.lastFailedTargetUnitId}`);
    }
    const attemptsOnTarget = intent.targetUnitId
      ? (intent.repeatAttemptsByTargetId.get(intent.targetUnitId) || 0)
      : 0;
    lines.push(`  attempts(target): ${attemptsOnTarget}`);
    if (tick != null) {
      lines.push(`  timeInPhase:     ${tick - intent.formedAtTick} ticks (formed@${intent.formedAtTick})`);
      if (intent.enteredMeleeAtTick != null) {
        lines.push(`  timeInMelee:     ${tick - intent.enteredMeleeAtTick} ticks`);
      } else {
        lines.push('  timeInMelee:     not in melee');
      }
    }
    lines.push(`  committedBraced: ${intent.committedBracedCount}`);
    if (intent.threatUnitId) {
      lines.push(`  threatUnitId:    ${intent.threatUnitId}`);
    }
    if (intent.repeatAttemptsByTargetId.size > 0) {
      const entries = [];
      for (const [id, count] of intent.repeatAttemptsByTargetId) {
        entries.push(`${id}:${count}`);
      }
      lines.push(`  attempts log:    ${entries.join(' ')}`);
    }
  }

  async _copyAll() {
    const text = this._textEl.textContent || '';
    const original = this._copyBtn.textContent;
    let ok = false;

    // Modern clipboard API requires a secure context (https:// or
    // localhost). file:// and plain http:// throw or silently no-op.
    // Fall back to the legacy execCommand('copy') path in that case.
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        ok = this._fallbackCopy(text);
      }
    } catch {
      ok = this._fallbackCopy(text);
    }

    console.log('[HudView] copy result:', ok ? 'COPIED' : 'FAILED',
      'secureContext=', window.isSecureContext,
      'clipboardApi=', !!(navigator.clipboard && navigator.clipboard.writeText));
    this._copyBtn.textContent = ok ? 'COPIED' : 'FAILED';
    setTimeout(() => { this._copyBtn.textContent = original; }, 900);
  }

  // Legacy copy path via a hidden textarea + execCommand. Works in
  // non-secure contexts where navigator.clipboard is unavailable.
  _fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Keep it off-screen and out of tab order so the copy doesn't cause
    // a visible flash or steal focus.
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}