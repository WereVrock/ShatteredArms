// ===== MainMenu.js =====
// Top-level main menu. Four entries:
//   Campaign      — persistent roster across a series of battles
//   Scenarios     — single battle from the built-in scenarios
//   Custom Battle — set both sides' rosters yourself
//   Settings      — the shared SettingsPanel, opened via the onSettings callback
//
// Navigation to submenus is delegated via callbacks — this class holds no
// game state. Pure UI.
//
// Brand header (broken sword over a shattered shield) sits above the title
// and is drawn inline by BrandMark.js as a single SVG markup string. No
// image asset, no async load — nothing for the menu to await before it can
// paint.
//
// Card construction lives in MenuCard.js — shared with ScenarioMenu.
import { brandMarkSvg } from './BrandMark.js';
import { createMenuCard, createMenuButton } from './MenuCard.js';

export class MainMenu {
  constructor(rootElement, { onScenarios, onCampaign, onCustomBattle, onSettings }) {
    this.root = rootElement;
    this.onScenarios = onScenarios;
    this.onCampaign = onCampaign;
    this.onCustomBattle = onCustomBattle || null;
    this.onSettings = onSettings || null;
  }

  show() {
    this.root.innerHTML = '';
    this.root.classList.remove('hidden');

    const panel = document.createElement('div');
    panel.className = 'menu-panel main-menu-panel';

    // --- Brand header ---
    const brand = document.createElement('div');
    brand.className = 'menu-brand';
    brand.innerHTML = brandMarkSvg();
    panel.appendChild(brand);

    const title = document.createElement('h1');
    title.className = 'menu-title menu-brand-title';
    title.textContent = 'Shattered Arms';
    panel.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'menu-subtitle menu-brand-subtitle';
    sub.textContent = 'Command your line. Break theirs.';
    panel.appendChild(sub);

    const divider = document.createElement('div');
    divider.className = 'menu-divider';
    panel.appendChild(divider);

    // --- Mode cards ---
    const list = document.createElement('div');
    list.className = 'menu-list';
    list.appendChild(createMenuCard({
      name: 'Campaign',
      description: 'Fight a series of battles. Your army carries over between battles.',
      onClick: () => this.onCampaign()
    }));
    list.appendChild(createMenuCard({
      name: 'Scenarios',
      description: 'Play a single battle from the built-in scenarios.',
      onClick: () => this.onScenarios()
    }));
    if (this.onCustomBattle) {
      list.appendChild(createMenuCard({
        name: 'Custom Battle',
        description: 'Set up both sides\' units yourself, then fight.',
        onClick: () => this.onCustomBattle()
      }));
    }
    panel.appendChild(list);

    // Settings sits below the mode cards and uses the muted .menu-back style
    // so it reads as a utility entry, not a third game mode. Only rendered
    // when the caller wired a handler.
    if (this.onSettings) {
      panel.appendChild(createMenuButton({
        label: '⚙ Settings',
        className: 'menu-back',
        onClick: () => this.onSettings()
      }));
    }

    this.root.appendChild(panel);
  }

  hide() {
    this.root.classList.add('hidden');
  }
}