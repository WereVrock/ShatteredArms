// Top-left profile chip. Shows "Select Profile" when none is active, or
// the profile name when one is. Click opens the profile picker.
//
// The badge belongs to the MAIN MENU only. It is mounted on
// document.body (so it sits above every menu panel), but its
// visibility follows whether MainMenu's own panel is currently the
// content of #mainMenu. That is the only reliable signal in this app:
// sub-views (HighScoresView, ScenarioMenu, campaign pickers) render
// into the same #mainMenu root, so "the menu element is visible" is
// not the same as "we are on the main menu". MainMenu's panel carries
// the unique class .main-menu-panel (see the scoped rules in
// style.css — no other view uses it), so presence of that child under
// #mainMenu is the marker we follow.
//
// Watched via MutationObserver so we do not depend on MainMenu
// dispatching any lifecycle events, nor on sub-views remembering to
// hide us. Whoever changes #mainMenu's class or children, we re-sync.

const STYLE_ID = 'profile-badge-styles';

const STYLE_TEXT = `
  #profileBadge {
    position: fixed;
    top: 8px;
    left: 8px;
    z-index: 2000;
    pointer-events: auto;
    user-select: none;
  }
  #profileBadge .pb-pill {
    padding: 4px 10px;
    background: rgba(20, 30, 45, 0.78);
    border: 1px solid #3a4a5e;
    border-radius: 4px;
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
    font-size: 12px;
    letter-spacing: 0.4px;
    color: #eef2f8;
    cursor: pointer;
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #profileBadge .pb-pill:hover {
    border-color: #6a8ac0;
    background: rgba(30, 42, 60, 0.9);
  }
  #profileBadge .pb-pill.guest {
    color: #a0b0c4;
    font-style: italic;
  }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = STYLE_TEXT;
  document.head.appendChild(st);
}

export class ProfileBadge {
  constructor({ onClick } = {}) {
    ensureStyles();
    this._onClick = onClick || null;
    this.el = null;
    this._pill = null;
    this._menuEl = null;
    this._menuObserver = null;
    // True only when the caller has explicitly asked for the badge to
    // be visible (or when we have never been told otherwise). Defaults
    // to true so a bare mount() does not vanish the badge before the
    // first sync — the sync runs immediately after mount and corrects
    // this if the main menu is not actually up.
    this._visible = true;
  }

  mount(parent = document.body) {
    if (this.el) return this;
    const el = document.createElement('div');
    el.id = 'profileBadge';
    const pill = document.createElement('div');
    pill.className = 'pb-pill guest';
    pill.textContent = 'Select Profile';
    pill.addEventListener('click', () => {
      if (this._onClick) this._onClick();
    });
    el.appendChild(pill);
    parent.appendChild(el);
    this.el = el;
    this._pill = pill;

    this._attachMenuObserver();
    // Apply the initial result immediately — a mount() that happens
    // after MainMenu already rendered must not sit invisible until
    // the next mutation.
    this._syncMainMenuVisibility();

    return this;
  }

  // Watch #mainMenu for two kinds of change:
  //   - the `class` attribute flipping between "" and "hidden"
  //     (covers MainMenu.show() / MainMenu.hide() being called, if
  //     the app ever uses them);
  //   - direct children of #mainMenu being replaced (covers sub-views
  //     that overwrite innerHTML without toggling the class).
  // subtree:false because we only care about the immediate children of
  // #mainMenu itself, not deep mutations inside the current panel.
  _attachMenuObserver() {
    const menuEl = document.getElementById('mainMenu');
    if (!menuEl) return;
    this._menuEl = menuEl;
    this._menuObserver = new MutationObserver(() => {
      this._syncMainMenuVisibility();
    });
    this._menuObserver.observe(menuEl, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: false
    });
  }

  _syncMainMenuVisibility() {
    const menuEl = this._menuEl || document.getElementById('mainMenu');
    if (!menuEl) {
      this.setVisible(false);
      return;
    }
    const onMainMenu =
      !menuEl.classList.contains('hidden') &&
      !!menuEl.querySelector(':scope > .main-menu-panel');
    this.setVisible(onMainMenu);
  }

  // profile: { name } | null
  setProfile(profile) {
    if (!this._pill) return;
    if (profile && profile.name) {
      this._pill.classList.remove('guest');
      this._pill.textContent = profile.name;
      this._pill.title = 'Switch or leave profile';
    } else {
      this._pill.classList.add('guest');
      this._pill.textContent = 'Select Profile';
      this._pill.title = 'Select a local profile';
    }
  }

  setVisible(visible) {
    if (!this.el) return;
    this._visible = !!visible;
    this.el.style.display = this._visible ? '' : 'none';
  }

  // Optional: stop watching (if the badge is ever torn down). Not
  // called anywhere today, exposed so it does not become a leak if
  // ProfileBadge gains a destroy() path.
  destroy() {
    if (this._menuObserver) {
      this._menuObserver.disconnect();
      this._menuObserver = null;
    }
    this._menuEl = null;
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
    this._pill = null;
  }
}