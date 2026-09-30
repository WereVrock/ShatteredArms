// ===== ScenarioMenu.js =====
// Scenario submenu. Same card list as the pre-campaign main menu, plus a
// back button that returns to the top-level menu. Pure UI.
//
// Card construction lives in MenuCard.js — shared with MainMenu.
import { createMenuCard, createMenuButton } from './MenuCard.js';

export class ScenarioMenu {
  constructor(rootElement, { scenarios, onSelect, onBack }) {
    this.root = rootElement;
    this.scenarios = scenarios;
    this.onSelect = onSelect;
    this.onBack = onBack;
  }

  show() {
    this.root.innerHTML = '';
    this.root.classList.remove('hidden');

    const panel = document.createElement('div');
    panel.className = 'menu-panel';

    const title = document.createElement('h1');
    title.className = 'menu-title';
    title.textContent = 'Scenarios';
    panel.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'menu-subtitle';
    sub.textContent = 'Choose a scenario';
    panel.appendChild(sub);

    const list = document.createElement('div');
    list.className = 'menu-list';

    for (const scenario of this.scenarios) {
      list.appendChild(createMenuCard({
        name: scenario.name,
        description: scenario.description,
        onClick: () => this.onSelect(scenario)
      }));
    }

    panel.appendChild(list);

    panel.appendChild(createMenuButton({
      label: '← Back',
      className: 'menu-back',
      onClick: () => this.onBack()
    }));

    this.root.appendChild(panel);
  }

  hide() {
    this.root.classList.add('hidden');
  }
}