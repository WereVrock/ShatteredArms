// ===== MainMenu.js =====
// Top-level main menu. Two blocks:
//
//   Brand block — top-center. Emblem, title, subtitle in a filled
//   thematic panel (bronze border, dark parchment). pointer-events: none
//   so clicks pass through to the battle background.
//
//   Buttons panel — right column, full viewport height, vertically
//   centered. `.main-menu-panel` class stays here because it is the DOM
//   signal used by ProfileBadge and MainMenuBattleView.
//
// All layout uses element.style.setProperty(prop, value, 'important')
// which is guaranteed to beat any stylesheet rule, including another
// !important rule (inline !important always wins over external
// !important regardless of specificity).
import './MedievalTheme.js';
import { brandMarkSvg } from './BrandMark.js';
import { createMenuCard, createMenuButton } from './MenuCard.js';
import { MusicManager } from '../audio/MusicManager.js';

export class MainMenu {
  constructor(rootElement, { onScenarios, onCampaign, onCustomBattle, onSettings, onMultiplayer, onHighScores }) {
    this.root = rootElement;
    this.onScenarios = onScenarios;
    this.onCampaign = onCampaign;
    this.onCustomBattle = onCustomBattle || null;
    this.onSettings = onSettings || null;
    this.onMultiplayer = onMultiplayer || null;
    this.onHighScores = onHighScores || null;
  }

  // Helper: set multiple inline styles with !important.
  _forceStyle(el, styles) {
    for (const k in styles) {
      if (Object.prototype.hasOwnProperty.call(styles, k)) {
        el.style.setProperty(k, styles[k], 'important');
      }
    }
  }

  show() {
    MusicManager.play('menu');
    this.root.innerHTML = '';
    this.root.classList.remove('hidden');

    // --- Brand block — top-center, filled thematic panel ---
    const brandPanel = document.createElement('div');
    brandPanel.className = 'menu-brand-panel';
    this._forceStyle(brandPanel, {
      'position': 'absolute',
      'top': '24px',
      'left': '50%',
      'transform': 'translateX(-50%)',
      'pointer-events': 'none',
      'z-index': '2',
      'text-align': 'center',
      'max-width': 'min(520px, 80vw)',
      'padding': '14px 32px 18px',
      'box-sizing': 'border-box',
      'background': 'linear-gradient(180deg, rgba(38,30,22,0.94) 0%, rgba(20,16,12,0.94) 100%)',
      'border': '2px solid #6a4a1e',
      'border-radius': '8px',
      'box-shadow': '0 0 0 1px #2a1a08, inset 0 0 0 1px #b08848, 0 8px 24px rgba(0,0,0,0.6)',
      'margin': '0'
    });

    const brand = document.createElement('div');
    brand.className = 'menu-brand';
    brand.innerHTML = brandMarkSvg();
    brandPanel.appendChild(brand);

    const title = document.createElement('h1');
    title.className = 'menu-title menu-brand-title';
    title.textContent = 'Shattered Arms';
    this._forceStyle(title, {
      'margin': '0',
      'text-shadow': '0 2px 4px rgba(0,0,0,0.8)'
    });
    brandPanel.appendChild(title);

    const sub = document.createElement('p');
    sub.className = 'menu-subtitle menu-brand-subtitle';
    sub.textContent = 'Command your line. Break theirs.';
    this._forceStyle(sub, {
      'margin': '4px 0 0',
      'opacity': '0.85',
      'text-shadow': '0 1px 2px rgba(0,0,0,0.8)'
    });
    brandPanel.appendChild(sub);

    this.root.appendChild(brandPanel);

    // --- Buttons panel — right column, full viewport height ---
    const panel = document.createElement('div');
    panel.className = 'menu-panel main-menu-panel';
    this._forceStyle(panel, {
      'position': 'absolute',
      'top': '0',
      'right': '0',
      'bottom': '0',
      'left': 'auto',
      'margin': '0',
      'width': 'min(360px, 34vw)',
      'display': 'flex',
      'flex-direction': 'column',
      'justify-content': 'center',
      'align-items': 'stretch',
      'padding': '24px',
      'box-sizing': 'border-box',
      'overflow-y': 'auto',
      'z-index': '2',
      'background': 'linear-gradient(90deg, rgba(20,24,32,0) 0%, rgba(20,24,32,0.55) 20%, rgba(20,24,32,0.72) 100%)',
      'border-left': '1px solid rgba(106,74,30,0.35)',
      // Defend against any grid/flow rule the stylesheet might have set.
      'grid-template-columns': 'none',
      'grid-template-rows': 'none',
      'grid-auto-flow': 'row',
      'flex-wrap': 'nowrap'
    });

    const list = document.createElement('div');
    list.className = 'menu-list';
    this._forceStyle(list, {
      'display': 'flex',
      'flex-direction': 'column',
      'flex-wrap': 'nowrap',
      'gap': '10px',
      'width': '100%',
      'min-width': '0',
      'margin': '0',
      'padding': '0',
      'grid-template-columns': 'none',
      'grid-auto-flow': 'row'
    });

    const pushCard = (def) => {
      const card = createMenuCard(def);
      this._forceStyle(card, {
        'width': '100%',
        'min-width': '0',
        'max-width': '100%',
        'flex': '0 0 auto',
        'box-sizing': 'border-box',
        'display': 'block'
      });
      list.appendChild(card);
    };

    pushCard({
      name: 'Campaign',
      description: 'Fight a series of battles. Your army carries over between battles.',
      onClick: () => this.onCampaign()
    });
    pushCard({
      name: 'Scenarios',
      description: 'Play a single battle from the built-in scenarios.',
      onClick: () => this.onScenarios()
    });
    if (this.onCustomBattle) {
      pushCard({
        name: 'Custom Battle',
        description: 'Set up both sides\' units yourself, then fight.',
        onClick: () => this.onCustomBattle()
      });
    }
    if (this.onMultiplayer) {
      pushCard({
        name: 'Multiplayer',
        description: 'Host or join a battle over the network. Host runs the simulation; guest mirrors it.',
        onClick: () => this.onMultiplayer()
      });
    }
    if (this.onHighScores) {
      pushCard({
        name: 'High Scores',
        description: 'Top campaign scores for the current balance version.',
        onClick: () => this.onHighScores()
      });
    }
    panel.appendChild(list);

    if (this.onSettings) {
      const settingsBtn = createMenuButton({
        label: '⚙ Settings',
        className: 'menu-back',
        onClick: () => this.onSettings()
      });
      this._forceStyle(settingsBtn, {
        'width': '100%',
        'box-sizing': 'border-box',
        'flex': '0 0 auto'
      });
      panel.appendChild(settingsBtn);
    }

    this.root.appendChild(panel);
  }

  hide() {
    this.root.classList.add('hidden');
  }
}