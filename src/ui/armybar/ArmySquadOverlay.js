// DOM helper: draws a thick coloured frame around each squad's cards plus a
// solid tab above the first one. Lives on document.body as a fixed layer and
// reads card rectangles, so it never touches the bar's own layout (wrap mode
// and overlap mode both work). Squads that wrap onto several rows get one
// frame per row; the tab sits on the first.
//
// The tab holds: a grip (click selects the squad, drag moves it), a collapse
// toggle, a lock toggle, a "+N" count while collapsed, and a disband button
// that only exists while the squad is unlocked.
//
// render() is called by the view only when something changed.
//
// handlers: onSelect(squadId, additive), onToggle(squadId),
//           onToggleLock(squadId), onDisband(squadId),
//           attachDrag(chipEl, squadId)

const FRAME_PAD_PX = 3;
const CHIP_HEIGHT_PX = 16;

export class ArmySquadOverlay {
  constructor(rootElement, squads, handlers) {
    this.root = rootElement;
    this.squads = squads;
    this.handlers = handlers;

    this.el = document.createElement('div');
    this.el.className = 'army-squad-overlay';
    document.body.appendChild(this.el);
  }

  clear() {
    this.el.textContent = '';
  }

  // cards: [{ unitId, el, hidden }] in display order.
  render(cards) {
    this.el.textContent = '';

    const rootRect = this.root.getBoundingClientRect();
    if (rootRect.width === 0 || rootRect.height === 0) return;

    const visibleBySquad = new Map();
    const totalBySquad = new Map();
    for (const c of cards) {
      const squadId = this.squads.squadIdFor(c.unitId);
      if (squadId === undefined) continue;
      totalBySquad.set(squadId, (totalBySquad.get(squadId) || 0) + 1);
      if (c.hidden) continue;
      let list = visibleBySquad.get(squadId);
      if (!list) {
        list = [];
        visibleBySquad.set(squadId, list);
      }
      list.push(c.el);
    }

    for (const [squadId, els] of visibleBySquad) {
      this._drawSquad(squadId, els, totalBySquad.get(squadId) - els.length, rootRect);
    }
  }

  _drawSquad(squadId, els, hiddenCount, rootRect) {
    const squad = this.squads.get(squadId);
    if (!squad) return;

    // Split the squad's cards into runs, one per visual row.
    const runs = [];
    let run = null;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!run || Math.abs(r.top - run.top) > r.height * 0.5) {
        run = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        runs.push(run);
      } else {
        run.left = Math.min(run.left, r.left);
        run.top = Math.min(run.top, r.top);
        run.right = Math.max(run.right, r.right);
        run.bottom = Math.max(run.bottom, r.bottom);
      }
    }

    let chipPlaced = false;
    for (const r of runs) {
      // Row scrolled out of the bar's own scroll area.
      if (r.bottom < rootRect.top || r.top > rootRect.bottom) continue;
      this._addFrame(squad, r);
      if (!chipPlaced) {
        chipPlaced = true;
        this._addChip(squad, r, hiddenCount);
      }
    }
  }

  _addFrame(squad, run) {
    const frame = document.createElement('div');
    frame.className = 'army-squad-frame';
    frame.style.left = Math.round(run.left - FRAME_PAD_PX) + 'px';
    frame.style.top = Math.round(run.top - FRAME_PAD_PX) + 'px';
    frame.style.width = Math.round(run.right - run.left + FRAME_PAD_PX * 2) + 'px';
    frame.style.height = Math.round(run.bottom - run.top + FRAME_PAD_PX * 2) + 'px';
    frame.style.borderColor = squad.color;
    frame.style.boxShadow =
      `0 0 8px ${squad.color}, inset 0 0 8px ${squad.color}66`;
    this.el.appendChild(frame);
  }

  _addChip(squad, run, hiddenCount) {
    const chip = document.createElement('div');
    chip.className = 'army-squad-chip';
    chip.style.left = Math.round(run.left - FRAME_PAD_PX) + 'px';
    chip.style.top = Math.max(0, Math.round(run.top - FRAME_PAD_PX - CHIP_HEIGHT_PX)) + 'px';
    chip.style.background = squad.color;
    chip.title = 'Click: select squad · Shift: add to selection · Drag: move squad';
    chip.addEventListener('pointerdown', (e) => e.stopPropagation());
    // Buttons stop their own clicks, so this only fires on the grip / padding.
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handlers.onSelect(squad.id, e.shiftKey);
    });

    const grip = document.createElement('span');
    grip.className = 'army-squad-grip';
    grip.textContent = '≡';
    chip.appendChild(grip);

    chip.appendChild(this._button(
      squad.collapsed ? '▸' : '▾',
      squad.collapsed ? 'Expand squad' : 'Collapse squad to one card',
      () => this.handlers.onToggle(squad.id)
    ));

    chip.appendChild(this._button(
      squad.locked ? '🔒' : '🔓',
      squad.locked
        ? 'Locked: members stay together and move as one. Click to unlock'
        : 'Lock squad: keeps members together and protects it from accidental changes',
      () => this.handlers.onToggleLock(squad.id)
    ));

    if (hiddenCount > 0) {
      const count = document.createElement('span');
      count.className = 'army-squad-count';
      count.textContent = '+' + hiddenCount;
      chip.appendChild(count);
    }

    // A locked squad cannot be disbanded, so it gets no disband button.
    if (!squad.locked) {
      chip.appendChild(this._button(
        '×',
        'Disband squad',
        () => this.handlers.onDisband(squad.id)
      ));
    }

    this.el.appendChild(chip);
    this.handlers.attachDrag(chip, squad.id);
  }

  _button(text, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.title = title;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  dispose() {
    this.el.remove();
  }
}