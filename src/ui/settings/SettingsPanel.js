// ===== SettingsPanel.js =====
// The settings dialog. Three pages, swapped in place inside one modal shell:
//   root      — a list of category entries (Graphics / Gameplay / UI)
//   graphics  — Scene / Quality / Soldiers sections (see _showGraphics)
//   gameplay  — the double-click direct-march toggle
//   ui        — the power-balance-scale toggle
//
// Pure DOM overlay — knows only about SettingsStore, not about the game,
// the renderer, or the scene. One instance per page, opened from both the
// main menu and the in-game pause menu.
//
// Every toggle reads and writes SettingsStore directly. Applying the change
// to the running scene is not this class's job — SceneSetup is subscribed
// to SettingsStore by main.js and reacts on its own. Adding a new toggle
// therefore needs no change here beyond one _buildToggleRow call.
//
// Styled with inline styles so the panel works regardless of any external
// stylesheet. Palette matches the pause menu (dark slate with a light
// accent) so the two panels read as one family.
import { SettingsStore } from './SettingsStore.js';
import { UiFontScale } from './UiFontScale.js';

export class SettingsPanel {
  constructor() {
    this._panel = null;

    // Toggle-row references. Non-null only while the graphics page is
    // mounted; nulled when returning to the root page so _syncFromStore
    // does not touch detached DOM nodes.
    //
    // _shadowRow bundles the two shadow selects (quality + range) that
    // sit side-by-side in the Quality section. The row owns the two
    // <select> elements as `_qualitySelect` and `_rangeSelect`.
    this._shadowRow = null;
    this._renderScaleSelect = null;
    this._groundToggle = null;
    this._grassToggle = null;
    this._fieldEdgeToggle = null;
    this._fogToggle = null;
    this._doubleClickToggle = null;
    this._presetSelect = null;
    this._fpsToggle = null;
    this._lodToggle = null;
    this._modelDetailSelect = null;
    this._minModelDetailSelect = null;
    this._minModelDetailRow = null;
    this._disableAnimationsToggle = null;
    this._powerScaleToggle = null;
    this._powerSwordsToggle = null;
    this._bannerSizeSelect = null;
    this._legacyBannersToggle = null;

    // Page listeners. Fired with the page name on every page transition:
    //   'root'      — top-level category list
    //   'graphics'  — graphics toggles
    //   'gameplay'  — gameplay toggles
    //   'ui'        — HUD/widget toggles
    //   null        — dialog closed
    // Used by openers (PauseMenuPanel) that want to step aside for
    // specific pages — e.g. hide the pause menu's dark backdrop while
    // the Graphics page is up so the running scene is visible behind it,
    // but restore it the moment the player navigates back to the root.
    this._pageListeners = new Set();

    this.el = this._buildShell();
    document.body.appendChild(this.el);

    this._unsub = SettingsStore.subscribe(() => this._syncFromStore());
    this._showMain();
  }

  // Always lands on the root page — so reopening the dialog never drops the
  // player back into a submenu they left open in a previous session.
  //
  // _showMain() fires the page listener with 'root', so a subscriber that
  // stepped aside for the graphics page sees the transition back the
  // moment the dialog reopens.
  // Context argument is accepted for API compatibility with callers that
  // still pass 'main' / 'pause'; it no longer affects the panel (the
  // Test Features page that used it was removed).
  open(_context) {
    this.el.style.display = 'flex';
    this._showMain();
  }

  // Fires the page listener with null so a subscriber that stepped aside
  // for the graphics page restores its backdrop. Guarded against a
  // redundant close (already hidden) so the listener cannot fire twice
  // for one logical transition.
  close() {
    if (this.el.style.display === 'none') return;
    this.el.style.display = 'none';
    this._notifyPage(null);
  }

  get isOpen() {
    return this.el.style.display === 'flex';
  }

  dispose() {
    if (this._unsub) this._unsub();
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  // Subscribe to page transitions. Returns an unsubscribe function.
  // The listener receives the page name — 'root' | 'graphics' | 'gameplay'
  // | 'ui' — or null when the dialog closes. Multiple callers may subscribe;
  // every listener fires with the same value. Errors thrown by one
  // listener do not prevent the others from running — mirrors
  // SettingsStore's subscriber contract.
  onPageChange(fn) {
    this._pageListeners.add(fn);
    return () => this._pageListeners.delete(fn);
  }

  _notifyPage(page) {
    for (const fn of this._pageListeners) {
      try { fn(page); } catch (e) { /* listener errors must not break others */ }
    }
  }

  // --- shell ----------------------------------------------------------------

  _buildShell() {
    const root = document.createElement('div');
    root.className = 'mt-root';
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      // No dark backdrop. The panel floats over whatever is behind it —
      // the main menu or the pause menu — and both of those already dim
      // the scene on their own. Painting a second dark layer here stacked
      // two overlays on top of each other when Settings was opened from
      // the pause menu. The root element still covers the viewport, so
      // click-outside-to-close (which tests e.target === root) keeps
      // working; only the visible dimming is gone.
      background: 'transparent',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '100',
      fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
      color: '#e8e8e8'
    });

    // Backdrop click closes. mousedown (not click) so a drag that starts
    // inside the panel and releases on the backdrop does not close it.
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) this.close();
    });

    this._panel = document.createElement('div');
    Object.assign(this._panel.style, {
      background: '#1e222a',
      border: '1px solid #384050',
      borderRadius: '8px',
      padding: '20px 24px',
      minWidth: '340px',
      // Cap the width. The panel is a shrink-to-fit flex item, so a
      // block of long, unwrappable-to-intrinsic text — like the Test
      // Features page's notes and explainer — would otherwise size the
      // whole panel to that paragraph's max-content width, hundreds of
      // pixels wider than every other settings page. 420px sits just
      // above the widest intrinsic content any page has today, so
      // nothing clips; it only stops runaway growth. Text wraps inside.
      maxWidth: '420px',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
      // Zoom multiplies lengths, so the viewport limit is divided by the
      // font scale to keep a scaled dialog on screen.
      maxHeight: 'calc((100vh - 32px) / var(--ui-font-scale, 1))',
      overflowY: 'auto',
      boxSizing: 'border-box'
    });
    // The dialog is appended to body, outside #mainMenu, so it scales
    // itself from the same variable UiFontScale writes.
    this._panel.style.zoom = 'var(--ui-font-scale, 1)';
    root.appendChild(this._panel);

    return root;
  }

  // --- pages ----------------------------------------------------------------

  _showMain() {
    this._clearToggleRefs();
    this._panel.innerHTML = '';
    this._panel.appendChild(this._buildTitleRow('Settings'));
    this._panel.appendChild(this._buildNavRow('Graphics', () => this._showGraphics()));
    this._panel.appendChild(this._buildNavRow('Gameplay', () => this._showGameplay()));
    this._panel.appendChild(this._buildNavRow('UI', () => this._showUI()));
    this._notifyPage('root');
  }

  // The Graphics page is organised into three visual sections — Scene,
  // Quality, Soldiers — separated by _buildSectionHeader labels. The
  // section header is a light text label, not a clickable nav row, so
  // the Graphics page keeps working as a single scrollable page while
  // still reading as grouped. See _buildSectionHeader.
_showGraphics() {
    this._clearToggleRefs();
    this._panel.innerHTML = '';
    this._panel.appendChild(this._buildTitleRow('Graphics'));

    // Preset dropdown at the top. Selecting one applies a whole set of
    // quality settings at once (see SettingsStore.applyPreset); the
    // individual controls below stay live and can be tweaked afterwards,
    // at which point the preset select flips to 'Custom' on the next sync.
    this._presetSelect = this._buildPresetRow();
    this._panel.appendChild(this._presetSelect);

    // --- Scene -------------------------------------------------------
    this._panel.appendChild(this._buildSectionHeader('Scene'));
    this._groundToggle = this._buildToggleRow('Ground texture', 'groundTexture');
    this._panel.appendChild(this._groundToggle);
    this._grassToggle = this._buildToggleRow('Grass', 'grass');
    this._panel.appendChild(this._grassToggle);
    this._fieldEdgeToggle = this._buildToggleRow('Field boundary', 'fieldEdge');
    this._panel.appendChild(this._fieldEdgeToggle);
    this._fogToggle = this._buildToggleRow('Fog', 'fog');
    this._panel.appendChild(this._fogToggle);

    // --- Quality -----------------------------------------------------
    // The big levers — shadow pass, resolution multiplier, anti-aliasing.
    // Shadows and their range cutoff share one row (see _buildShadowRow)
    // because they describe one concern; keeping them apart meant a
    // player could see "Shadows: Medium" and "Soldier shadow range: 60
    // units" on separate lines and not realise the second only matters
    // when the first is on.
    this._panel.appendChild(this._buildSectionHeader('Quality'));
    this._shadowRow = this._buildShadowRow();
    this._panel.appendChild(this._shadowRow);

    this._renderScaleSelect = this._buildSelectRow(
      'Resolution',
      'renderScale',
      [
        { value: '0.5',  label: '50% (fastest)' },
        { value: '0.65', label: '65%' },
        { value: '0.8',  label: '80%' },
        { value: '1',    label: '100% (native)' },
        { value: '1.25', label: '125% (sharper)' }
      ]
    );
    this._panel.appendChild(this._renderScaleSelect);

    this._antialiasToggle = this._buildToggleRow(
      'Anti-aliasing (restart to apply)',
      'antialias'
    );
    this._antialiasToggle.title =
      'Smooths jagged edges and pixel shimmer on moving units. Takes ' +
      'effect after pressing Restart or starting a new battle. Costs GPU time.';
    this._panel.appendChild(this._antialiasToggle);

    // --- Soldiers ----------------------------------------------------
    // Only the LOD block stays on the everyday page. Instanced rendering
    // and the three "reduced*" performance shortcuts are fine-grained
    // perf knobs and bug-escape hatches, not everyday quality settings —
    // they live behind the Advanced button below so the default Graphics
    // page stays readable.
    this._panel.appendChild(this._buildSectionHeader('Soldiers'));
    this._panel.appendChild(this._buildLodBlock());

    // --- Advanced (nav) ----------------------------------------------
    // Opens the Advanced sub-page (see _showAdvanced). Reached only by
    // this nav button; the sub-page has its own "← Simple" button back.
    this._panel.appendChild(this._buildNavRow('Advanced', () => this._showAdvanced()));

    this._panel.appendChild(this._buildBackRow(() => this._showMain()));

    this._syncFromStore();
    this._notifyPage('graphics');
  }

// Advanced sub-page of Graphics. Holds the four fine-grained controls
  // that the everyday Graphics page deliberately does not surface:
  //   - instanced soldier rendering (a bug-escape hatch, not a quality
  //     tier — see the note on SettingsStore.DEFAULTS.instancedRendering)
  //   - the three "reduced*" performance shortcuts, each of which trades
  //     a sliver of fidelity for measurable speed.
  //
  // Reached only via the "Advanced" nav row on the Graphics page. Returns
  // via this page's own "← Simple" button (see _buildBackRow's optional
  // label argument), which re-enters _showGraphics — so the player lands
  // back exactly where they were.
  //
  // Every control here is a live SettingsStore write; the running scene
  // reacts through the same subscription wiring the main Graphics page
  // uses. No behavior change from the old placement other than the extra
  // navigation step.
  _showAdvanced() {
    this._clearToggleRefs();
    this._panel.innerHTML = '';
    this._panel.appendChild(this._buildTitleRow('Advanced'));

    // Instanced soldier rendering. Same visuals, far fewer draw calls.
    // Only worth turning off if something looks wrong.
    this._instancedToggle = this._buildToggleRow(
      'Instanced soldier rendering',
      'instancedRendering'
    );
    this._instancedToggle.title =
      'Draws all soldier parts in a few batched draw calls. Same look, ' +
      'much faster in large battles. Turn off only if you see rendering problems.';
    this._panel.appendChild(this._instancedToggle);

    // --- Performance shortcuts ---------------------------------------
    // Each one trades a sliver of fidelity for speed. On by default;
    // turn off for exact visuals at some cost in large battles.
    this._panel.appendChild(this._buildSectionHeader('Performance shortcuts'));

    this._shadowRefreshToggle = this._buildToggleRow(
      'Shadows refresh once per sim tick',
      'reducedShadowRefresh'
    );
    this._shadowRefreshToggle.title =
      'Off: the shadow map refreshes every frame, so shadows follow ' +
      'animations exactly. On: once per simulation tick (faster).';
    this._panel.appendChild(this._shadowRefreshToggle);

    this._spearChecksToggle = this._buildToggleRow(
      'Reduced spear contact checks',
      'reducedSpearChecks'
    );
    this._spearChecksToggle.title =
      'Off: idle spearmen check for a friendly in front of the shaft every ' +
      'tick. On: every 3rd tick, so a spear may rise slightly late.';
    this._panel.appendChild(this._spearChecksToggle);

    this._hudRefreshToggle = this._buildToggleRow(
      'Army bar at 10 Hz',
      'reducedHudRefresh'
    );
    this._hudRefreshToggle.title =
      'Off: the army bar updates every frame. On: 10 times a second ' +
      '(faster, highlights may lag up to 0.1 s).';
    this._panel.appendChild(this._hudRefreshToggle);

    this._panel.appendChild(this._buildBackRow(
      () => this._showGraphics(),
      '\u2190 Simple'
    ));

    this._syncFromStore();
    // Notify as 'graphics' rather than a new 'advanced' name so that
    // PauseMenuPanel's page-change handler — which steps the pause-menu
    // backdrop aside for 'graphics' so the running scene is visible
    // while the player is tuning graphics — treats the Advanced sub-page
    // exactly like the Graphics page. Both pages are "graphics tuning"
    // from the player's point of view and want identical backdrop
    // behaviour. If the two pages ever need to be distinguished, this
    // becomes 'advanced' and PauseMenuPanel gains a matching case.
    this._notifyPage('graphics');
  }

_showGameplay() {
    this._clearToggleRefs();
    this._panel.innerHTML = '';
    this._panel.appendChild(this._buildTitleRow('Gameplay'));

    this._doubleClickToggle = this._buildToggleRow(
      'Double-click: direct march',
      'doubleClickDirectMarch'
    );
    this._panel.appendChild(this._doubleClickToggle);

    // "Formation drag: start from current shape" (the virtual-cursor
    // drag setting) was removed because the feature was buggy in
    // practice — the drag preview could drift from the actual footprint
    // and the hidden OS cursor caused usability problems. The setting
    // is force-disabled at SettingsStore load (see the migration in
    // SettingsStore._load), and the toggle no longer surfaces here.
    // When the bug is fixed, restore both this row and the migration,
    // and flip DEFAULTS.virtualCursorDragEnabled back to true.

    this._panel.appendChild(this._buildBackRow(() => this._showMain()));

    this._syncFromStore();
    this._notifyPage('gameplay');
  }

  // UI page: on-screen widget visibility. Currently the FPS counter, the
  // army-bar overlays, the world-space unit overlays, and the power
  // balance widget. Kept as its own category rather than folded into
  // Graphics because "which HUD widgets are on screen" is a distinct
  // concern from "how the scene is rendered" — a player on low-end
  // hardware may want Graphics settings cranked down but every HUD
  // element on, and vice versa. This is the natural home for any future
  // overlay/readout toggles (range circles, order lines, etc.).
  _showUI() {
    this._clearToggleRefs();
    this._panel.innerHTML = '';
    this._panel.appendChild(this._buildTitleRow('UI'));

    // FPS counter. Purely a display toggle — FpsCounter subscribes to
    // SettingsStore on its own, so this row only has to flip the value.
    // Lives on the UI page rather than Graphics: it is an on-screen
    // readout, not a rendering-quality knob.
    // Font size. UiFontScale subscribes to the store itself, so this row
    // only writes the value.
    this._fontScaleSelect = this._buildSelectRow(
      'Font size',
      'uiFontScale',
      UiFontScale.OPTIONS
    );
    this._fontScaleSelect._select.value =
      String(SettingsStore.get().uiFontScale || '1');
    this._panel.appendChild(this._fontScaleSelect);

    this._fpsToggle = this._buildToggleRow('FPS counter', 'showFps');
    this._panel.appendChild(this._fpsToggle);

    // Army-bar overlays. Two independent toggles for the two bars
    // drawn over each unit card's icon. Placed above the power-widget
    // toggles because they affect the bottom-of-screen army bar that
    // every player looks at constantly, while the power widget is a
    // top-right corner ornament most players leave on default. Both
    // default on, matching the store's DEFAULTS.
    this._moraleBarToggle = this._buildToggleRow(
      'Army bar: morale',
      'showMoraleBar'
    );
    this._panel.appendChild(this._moraleBarToggle);

    // Label says "stamina" while the setting key says "fatigue" — see
    // the naming note on Soldier.fatigueDrainMultiplier. Player-facing
    // strings use "stamina"; internal keys keep the sim's name so a
    // grep for the setting key still lands on every call site.
    this._fatigueBarToggle = this._buildToggleRow(
      'Army bar: stamina',
      'showFatigueBar'
    );
    this._panel.appendChild(this._fatigueBarToggle);

    // World-space unit overlays. Both read each render frame by the
    // overlay renderer — see the note on the store keys. Listed here
    // rather than on the Graphics page for the same reason as the
    // army-bar toggles above: they are HUD density, not scene quality.
    this._unitFlagsToggle = this._buildToggleRow(
      'Unit flags (all units)',
      'showUnitFlags'
    );
    this._panel.appendChild(this._unitFlagsToggle);

    this._unitBarsToggle = this._buildToggleRow(
      'Unit bars (player units)',
      'showUnitBars'
    );
    this._panel.appendChild(this._unitBarsToggle);

    // Banner world-space size. Three discrete tiers rather than a
    // continuous slider — the distance scaling already holds banners at
    // constant SCREEN size across zoom, so this selects what that
    // constant is. Banners are a HUD readability element, so this sits
    // with the other banner toggles rather than on the Graphics page.
    this._bannerSizeSelect = this._buildSelectRow(
      'Banner size',
      'bannerSize',
      [
        { value: 'tiny',   label: 'Tiny' },
        { value: 'small',  label: 'Small' },
        { value: 'medium', label: 'Medium' },
        { value: 'large',  label: 'Large' },
        { value: 'huge',   label: 'Huge' }
      ]
    );
    this._panel.appendChild(this._bannerSizeSelect);

    // Legacy banner style toggle — swaps between the current
    // silhouette-on-race-shape look and the pre-refactor heater-shield
    // with the detailed composite icon. Placed directly below banner
    // size because it is the visual companion setting (same widget,
    // same "how the banner looks" concern). Default off (new banners).
    this._legacyBannersToggle = this._buildToggleRow(
      'Legacy banner style',
      'legacyBanners'
    );
    this._legacyBannersToggle.title =
      'Uses the original heater-shield banner with the detailed multi-' +
      'element unit icon. Off by default — current banners use race-' +
      'shaped outlines and white silhouettes.';
    this._panel.appendChild(this._legacyBannersToggle);

    // Two independent gauges. Either, both or neither can be pinned on
    // screen. With only one pinned, clicking the widget in battle reveals
    // the other plus a numbers readout; with neither, the widget stays
    // hidden.
    this._powerScaleToggle = this._buildToggleRow(
      'Power balance scale',
      'showPowerScale'
    );
    this._panel.appendChild(this._powerScaleToggle);

    this._powerSwordsToggle = this._buildToggleRow(
      'Power swords',
      'showPowerSwords'
    );
    this._panel.appendChild(this._powerSwordsToggle);

    const note = document.createElement('div');
    note.textContent =
      'Click the widget during battle to reveal the other gauge and the numbers.';
    Object.assign(note.style, {
      fontSize: '12px',
      lineHeight: '1.35',
      opacity: '0.6',
      maxWidth: '300px',
      padding: '8px 0 0'
    });
    this._panel.appendChild(note);

    this._panel.appendChild(this._buildBackRow(() => this._showMain()));

    this._syncFromStore();
    this._notifyPage('ui');
  }



  _clearToggleRefs() {
    this._shadowRow = null;
    this._renderScaleSelect = null;
    this._groundToggle = null;
    this._grassToggle = null;
    this._fieldEdgeToggle = null;
    this._fogToggle = null;
    this._doubleClickToggle = null;
    this._presetSelect = null;
    this._fpsToggle = null;
    this._lodToggle = null;
    this._modelDetailSelect = null;
    this._minModelDetailSelect = null;
    this._minModelDetailRow = null;
    this._disableAnimationsToggle = null;
    this._powerScaleToggle = null;
    this._powerSwordsToggle = null;
    this._bannerSizeSelect = null;
    this._legacyBannersToggle = null;
    this._moraleBarToggle = null;
    this._fatigueBarToggle = null;
    this._unitFlagsToggle = null;
    this._unitBarsToggle = null;
    this._instancedToggle = null;
    this._lodScaleSelect = null;
    this._antialiasToggle = null;
    this._shadowRefreshToggle = null;
    this._spearChecksToggle = null;
    this._hudRefreshToggle = null;
  }

  // --- builders -------------------------------------------------------------

  _buildTitleRow(titleText) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '12px'
    });

    const title = document.createElement('h2');
    title.textContent = titleText;
    Object.assign(title.style, {
      margin: '0',
      fontSize: '18px',
      fontWeight: '600'
    });
    row.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00d7'; // multiplication sign, reads as an X
    closeBtn.className = 'mt-close';
    Object.assign(closeBtn.style, {
      background: 'transparent',
      border: 'none',
      color: '#e8e8e8',
      fontSize: '24px',
      lineHeight: '1',
      cursor: 'pointer',
      padding: '0 4px'
    });
    closeBtn.addEventListener('click', () => this.close());
    row.appendChild(closeBtn);

    return row;
  }

  // A dim uppercase label that groups the rows below it into a visual
  // section — "SCENE", "QUALITY", "SOLDIERS" on the Graphics page. Not
  // clickable; purely visual grouping. The border that separates one
  // section from the previous one is the previous row's borderBottom,
  // so this label only needs its own spacing.
  _buildSectionHeader(labelText) {
    const row = document.createElement('div');
    row.textContent = labelText;
    Object.assign(row.style, {
      fontSize: '11px',
      fontWeight: '600',
      letterSpacing: '0.8px',
      textTransform: 'uppercase',
      opacity: '0.5',
      padding: '14px 0 2px'
    });
    return row;
  }

  // A clickable row that navigates deeper into the settings tree. Reads as
  // a sibling of the toggle rows (same height and border) with a chevron
  // on the right signalling "opens something".
  _buildNavRow(labelText, onClick) {
    const row = document.createElement('button');
    row.type = 'button';
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      width: '100%',
      padding: '10px 0',
      border: 'none',
      borderBottom: '1px solid #2a2f3a',
      background: 'transparent',
      color: '#e8e8e8',
      fontSize: '14px',
      fontFamily: 'inherit',
      cursor: 'pointer',
      textAlign: 'left'
    });
    row.addEventListener('mouseenter', () => { row.style.color = '#ffffff'; });
    row.addEventListener('mouseleave', () => { row.style.color = '#e8e8e8'; });
    row.addEventListener('click', onClick);

    const text = document.createElement('span');
    text.textContent = labelText;
    row.appendChild(text);

    const chevron = document.createElement('span');
    chevron.textContent = '\u203a'; // single right-pointing angle quote
    chevron.style.fontSize = '18px';
    chevron.style.opacity = '0.6';
    row.appendChild(chevron);

    return row;
  }

  // A label + checkbox row. The whole row is the label, so clicking anywhere
  // on it toggles the checkbox. The checkbox is stored on the row so
  // _syncFromStore can find it without re-querying the DOM.
  _buildToggleRow(labelText, settingsKey) {
    const row = document.createElement('label');
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '10px 0',
      borderBottom: '1px solid #2a2f3a',
      cursor: 'pointer',
      userSelect: 'none'
    });

    const text = document.createElement('span');
    text.textContent = labelText;
    text.style.fontSize = '14px';
    row.appendChild(text);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.style.cursor = 'pointer';
    checkbox.addEventListener('change', () => {
      SettingsStore.set(settingsKey, checkbox.checked);
    });
    row.appendChild(checkbox);

    row._checkbox = checkbox;
    return row;
  }

  // A label + <select> row, for settings whose value is one of a small set
  // of named options rather than a boolean. Mirrors _buildToggleRow's
  // layout and styling so the two read as the same family; the only
  // structural difference is the control on the right.
  //
  // The select element is stored on the row as `_select`, matching the
  // `_checkbox` convention above, so _syncFromStore can write to it without
  // a DOM query. Options is an array of { value, label }; values are
  // written verbatim to SettingsStore, so they must match whatever the
  // consumer (SceneSetup for shadowQuality) expects.
  _buildSelectRow(labelText, settingsKey, options) {
    const row = document.createElement('label');
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '10px 0',
      borderBottom: '1px solid #2a2f3a',
      cursor: 'pointer',
      userSelect: 'none'
    });

    const text = document.createElement('span');
    text.textContent = labelText;
    text.style.fontSize = '14px';
    row.appendChild(text);

    const select = this._makeSelect(options);
    select.addEventListener('change', () => {
      SettingsStore.set(settingsKey, select.value);
    });
    row.appendChild(select);

    row._select = select;
    return row;
  }

  // Small helper: builds a <select> pre-populated with `options` (an
  // array of { value, label }) and styled to match the panel palette.
  // Shared by every select row so their visual language stays identical.
  _makeSelect(options) {
    const select = document.createElement('select');
    Object.assign(select.style, {
      background: '#2a2f3a',
      color: '#e8e8e8',
      border: '1px solid #384050',
      borderRadius: '4px',
      padding: '3px 6px',
      fontSize: '13px',
      fontFamily: 'inherit',
      cursor: 'pointer'
    });
    for (const opt of options) {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      select.appendChild(el);
    }
    return select;
  }

  // Preset dropdown. Selecting a non-Custom option calls
  // SettingsStore.applyPreset, which writes every key the preset names
  // through set() — subscribers fire per key exactly as if the player
  // flipped each control by hand. The 'Custom' option is not a real
  // preset; it appears (see _syncFromStore) whenever the current
  // settings do not match any preset, and re-selecting it is a no-op.
  _buildPresetRow() {
    const row = document.createElement('label');
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '10px 0',
      borderBottom: '1px solid #2a2f3a',
      cursor: 'pointer',
      userSelect: 'none'
    });

    const text = document.createElement('span');
    text.textContent = 'Preset';
    text.style.fontSize = '14px';
    row.appendChild(text);

    const select = this._makeSelect([
      { value: 'custom',   label: 'Custom' },
      { value: 'ultraLow', label: 'Ultra low' },
      { value: 'low',      label: 'Low' },
      { value: 'medium',   label: 'Medium' },
      { value: 'max',      label: 'Max' }
    ]);
    select.addEventListener('change', () => {
      if (select.value === 'custom') return;
      SettingsStore.applyPreset(select.value);
    });
    row.appendChild(select);

    row._select = select;
    return row;
  }

  // Shadow row. One label, two selects side-by-side — quality on the
  // left, soldier range on the right — because they describe one
  // concern: how the shadow pass behaves. A single enum cannot
  // represent the quality tiers (High / Medium / Low / None); the
  // second select is the optional distance cutoff beyond which soldiers
  // stop casting. Keeping them on one row means the player sees both
  // knobs together instead of hunting the range cutoff on a separate
  // line. The row stores both selects as `_qualitySelect` and
  // `_rangeSelect` so _syncFromStore can write to each without a DOM
  // query.
  _buildShadowRow() {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '10px 0',
      borderBottom: '1px solid #2a2f3a',
      gap: '8px'
    });

    const text = document.createElement('span');
    text.textContent = 'Shadows';
    text.style.fontSize = '14px';
    row.appendChild(text);

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '6px',
      alignItems: 'center'
    });

    // Quality select. 'None' turns the shadow pass off; any other value
    // turns it on at that resolution. SceneSetup maps the three
    // resolution tiers to 2048² / 1024² / 512² (see SHADOW_MAP_SIZES).
    const qualitySelect = this._makeSelect([
      { value: 'high',   label: 'High' },
      { value: 'medium', label: 'Medium' },
      { value: 'low',    label: 'Low' },
      { value: 'none',   label: 'None' }
    ]);
    qualitySelect.addEventListener('change', () => {
      SettingsStore.set('shadowQuality', qualitySelect.value);
    });
    controls.appendChild(qualitySelect);

    // Soldier range select. 'all' keeps every visible soldier casting;
    // any numeric value is the distance, in world units from the camera
    // look-at point, beyond which soldiers stop casting. Only matters
    // while shadows are actually on, so the tooltip spells that out.
    const rangeSelect = this._makeSelect([
      { value: 'all', label: 'Everything visible' },
      { value: '60',  label: '60 units' },
      { value: '40',  label: '40 units' },
      { value: '25',  label: '25 units' }
    ]);
    rangeSelect.title =
      'Soldiers farther than this from the camera focus stop casting ' +
      'shadows. Faster in huge battles.';
    rangeSelect.addEventListener('change', () => {
      SettingsStore.set('soldierShadowRange', rangeSelect.value);
    });
    controls.appendChild(rangeSelect);

    row.appendChild(controls);
    row._qualitySelect = qualitySelect;
    row._rangeSelect = rangeSelect;
    return row;
  }

  // Level-of-detail block: a master toggle + detail-distance select on
  // one row, plus two dependent tier dropdowns below. Stored on `this`
  // in four parts because _syncFromStore needs to write to each
  // independently; the block itself is just the visual container.
  //
  // Why the distance select shares the master row: it is the one knob
  // that "LOD on / off" makes meaningful, and putting it on its own
  // line further down made it look independent. On the master row it
  // reads as part of the same control. The tier dropdowns stay on their
  // own indented rows because their values are separate concerns (max
  // detail vs min detail) and want their own titles.
  //
  // Why one block rather than four sibling rows: the min-tier
  // dropdown's ENABLED state depends on the master toggle, the
  // distance select's ENABLED state depends on the master toggle, and
  // both dropdowns need a range guard that can rewrite the other when
  // the player picks an out-of-range value.
  //
  // The min-tier dropdown deliberately OMITS tier 1 — a minimum of
  // "Detailed" would pin every soldier to the most-detailed tier at every
  // distance, which is exactly the same as turning LOD off. There is no
  // meaningful reason to expose that as a minimum, so the option is not
  // offered and the store is never written a min below 2.
  _buildLodBlock() {
    const block = document.createElement('div');
    Object.assign(block.style, {
      borderBottom: '1px solid #2a2f3a',
      paddingBottom: '4px'
    });

    // --- master row: label + checkbox + detail-distance select ---
    const lodRow = document.createElement('label');
    Object.assign(lodRow.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '10px 0',
      cursor: 'pointer',
      userSelect: 'none'
    });

    const lodText = document.createElement('span');
    lodText.textContent = 'Level of Detail (LOD)';
    lodText.style.fontSize = '14px';
    lodRow.appendChild(lodText);

    const lodHint =
      'Distance-based detail: units close to the camera render at the ' +
      'highest quality, units far away switch to lower-quality models ' +
      'for performance. When off, every unit uses the Model Detail tier ' +
      'below regardless of distance.';

    const controls = document.createElement('div');
    Object.assign(controls.style, {
      display: 'flex',
      gap: '6px',
      alignItems: 'center'
    });

    const lodCheckbox = document.createElement('input');
    lodCheckbox.type = 'checkbox';
    lodCheckbox.style.cursor = 'pointer';
    lodCheckbox.title = lodHint;
    controls.appendChild(lodCheckbox);

    // Detail distance multiplier. Stored as a string; smaller values
    // shrink the high-detail zones around the camera. 'Normal' is the
    // authored look. Only meaningful while LOD is on, so this select is
    // disabled when the master toggle is off — see _applyLodDisabledState.
    const distanceSelect = this._makeSelect([
      { value: '1',   label: 'Normal' },
      { value: '0.7', label: 'Reduced' },
      { value: '0.5', label: 'Minimal' }
    ]);
    distanceSelect.title =
      'How far from the camera soldiers keep their high-detail models. ' +
      'Only matters while Level of Detail is on.';
    distanceSelect.addEventListener('change', () => {
      SettingsStore.set('lodDistanceScale', distanceSelect.value);
    });
    controls.appendChild(distanceSelect);

    lodText.title = lodHint;
    lodRow.title = lodHint;
    lodRow.appendChild(controls);
    block.appendChild(lodRow);

    // --- Model Detail dropdown (indented) ---
    const modelRow = this._buildIndentedSelectRow(
      'Model Detail',
      [
        { value: '1', label: '1 — Detailed' },
        { value: '2', label: '2 — Reduced Details' },
        { value: '3', label: '3 — Simplified' },
        { value: '4', label: '4 — Abstracted' }
      ]
    );
    modelRow.title =
      'The most detailed tier a unit will ever use. When LOD is on, this ' +
      'is the tier for units closest to the camera. When LOD is off, ' +
      'every unit uses this tier at every distance.';
    const modelSelect = modelRow._select;
    block.appendChild(modelRow);

    // --- Minimum Model Version dropdown (indented, tier 1 absent) ---
    // Tier 1 intentionally absent — see the method header.
    const minRow = this._buildIndentedSelectRow(
      'Minimum Model Version',
      [
        { value: '2', label: '2 — Reduced Details' },
        { value: '3', label: '3 — Simplified' },
        { value: '4', label: '4 — Abstracted' }
      ]
    );
    minRow.title =
      'The most simplified tier a unit will ever drop to. Only used when ' +
      'LOD is on — units far from the camera fall to this tier. Higher ' +
      'number = more simplification.';
    const minSelect = minRow._select;
    block.appendChild(minRow);

    // --- cross-wired handlers ---

    lodCheckbox.addEventListener('change', () => {
      SettingsStore.set('lodEnabled', lodCheckbox.checked);
      this._applyLodDisabledState(
        lodCheckbox.checked,
        minSelect,
        minRow,
        distanceSelect
      );
    });

    // Model Detail change: if the chosen tier is more simplified than the
    // current minimum, raise the minimum to match. The range is then
    // [v .. v] which is valid — LOD effectively shows a single tier.
    modelSelect.addEventListener('change', () => {
      const v = parseInt(modelSelect.value, 10);
      SettingsStore.set('modelDetail', v);
      const s = SettingsStore.get();
      if (v > s.minModelDetail) SettingsStore.set('minModelDetail', v);
    });

    // Minimum Model Version change: mirror of the above. If the chosen
    // tier is more detailed than the current maximum, lower the maximum
    // to match. The floor is 2 — the dropdown never yields 1.
    minSelect.addEventListener('change', () => {
      const v = parseInt(minSelect.value, 10);
      SettingsStore.set('minModelDetail', v);
      const s = SettingsStore.get();
      if (v < s.modelDetail) SettingsStore.set('modelDetail', v);
    });

    this._lodToggle = lodCheckbox;
    this._modelDetailSelect = modelSelect;
    this._minModelDetailSelect = minSelect;
    this._minModelDetailRow = minRow;
    this._lodScaleSelect = distanceSelect;

    return block;
  }

  // A select row identical to _buildSelectRow but indented and with a
  // slightly smaller, dimmer label — used for the two LOD sub-rows so
  // they read as children of the master toggle above them.
  //
  // No change handler is wired here (unlike _buildSelectRow) because the
  // LOD rows need custom per-row logic and numeric value conversion. The
  // caller wires both.
  _buildIndentedSelectRow(labelText, options) {
    const row = document.createElement('label');
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '8px 0 8px 18px',
      cursor: 'pointer',
      userSelect: 'none'
    });

    const text = document.createElement('span');
    text.textContent = labelText;
    text.style.fontSize = '13px';
    text.style.opacity = '0.85';
    row.appendChild(text);

    const select = this._makeSelect(options);
    row.appendChild(select);

    row._select = select;
    return row;
  }

  // Enables or disables the minimum-tier and detail-distance controls
  // based on the LOD master toggle, and dims them when disabled so the
  // visual state matches the functional state. The master checkbox
  // itself stays enabled — the player must always be able to turn LOD
  // back on.
  _applyLodDisabledState(enabled, minSelect, minRow, distanceSelect) {
    minSelect.disabled = !enabled;
    minRow.style.opacity = enabled ? '1' : '0.45';
    if (distanceSelect) {
      distanceSelect.disabled = !enabled;
      distanceSelect.style.opacity = enabled ? '1' : '0.45';
    }
  }

// Back button used at the bottom of every sub-page. Defaults to the
  // standard "← Back" label; pass a label to override it (the Advanced
  // sub-page uses "← Simple" to make it read as the counterpart of the
  // "Advanced" nav button it came from). Placement and styling are
  // identical between pages so the button always reads as the same
  // affordance.
  _buildBackRow(onClick, label) {
    const row = document.createElement('button');
    row.type = 'button';
    Object.assign(row.style, {
      display: 'block',
      width: '100%',
      marginTop: '12px',
      padding: '8px 0',
      border: '1px solid #384050',
      borderRadius: '6px',
      background: '#2a2f3a',
      color: '#e8e8e8',
      fontSize: '14px',
      fontFamily: 'inherit',
      cursor: 'pointer',
      textAlign: 'center'
    });
    row.addEventListener('mouseenter', () => { row.style.background = '#343a48'; });
    row.addEventListener('mouseleave', () => { row.style.background = '#2a2f3a'; });
    row.textContent = label || '\u2190 Back';
    row.addEventListener('click', onClick);
    return row;
  }

  // --- state sync -----------------------------------------------------------

  _syncFromStore() {
    const s = SettingsStore.get();
    // Toggle refs are null whenever their page is not mounted, so these
    // guards double as "is the page visible" checks.
    if (this._presetSelect) {
      this._presetSelect._select.value = SettingsStore.getMatchingPreset() || 'custom';
    }
    if (this._shadowRow) {
      this._shadowRow._qualitySelect.value = s.shadowQuality;
      this._shadowRow._rangeSelect.value = String(s.soldierShadowRange || 'all');
    }
    if (this._renderScaleSelect)   this._renderScaleSelect._select.value       = s.renderScale;
    if (this._groundToggle)        this._groundToggle._checkbox.checked        = !!s.groundTexture;
    if (this._grassToggle)         this._grassToggle._checkbox.checked         = !!s.grass;
    if (this._fieldEdgeToggle)     this._fieldEdgeToggle._checkbox.checked     = !!s.fieldEdge;
    if (this._fogToggle)           this._fogToggle._checkbox.checked           = !!s.fog;
    if (this._fpsToggle)           this._fpsToggle._checkbox.checked           = !!s.showFps;
    if (this._lodToggle) {
      this._lodToggle.checked = !!s.lodEnabled;
    }
    if (this._modelDetailSelect) {
      // Store keeps tiers as numbers; the select's option values are
      // strings. parseInt in the change handlers converts back.
      this._modelDetailSelect.value = String(s.modelDetail);
    }
    if (this._minModelDetailSelect) {
      // Defensive floor: a legacy save or a preset written before the
      // min-tier dropdown dropped its tier-1 option could carry a value
      // below 2, which no option matches. Clamp on read so the select
      // renders a valid option; the store itself is left alone here —
      // writes go through the change handler.
      const minVal = Math.max(2, s.minModelDetail);
      this._minModelDetailSelect.value = String(minVal);
      this._applyLodDisabledState(
        !!s.lodEnabled,
        this._minModelDetailSelect,
        this._minModelDetailRow,
        this._lodScaleSelect
      );
    }
    if (this._lodScaleSelect) {
      this._lodScaleSelect.value = String(s.lodDistanceScale || '1');
    }
    if (this._disableAnimationsToggle) this._disableAnimationsToggle._checkbox.checked = !!s.disableAnimations;
    if (this._doubleClickToggle)   this._doubleClickToggle._checkbox.checked   = !!s.doubleClickDirectMarch;
    if (this._powerScaleToggle)    this._powerScaleToggle._checkbox.checked    = !!s.showPowerScale;
    if (this._powerSwordsToggle)   this._powerSwordsToggle._checkbox.checked   = !!s.showPowerSwords;
    if (this._bannerSizeSelect)    this._bannerSizeSelect._select.value        = s.bannerSize || 'small';
    if (this._legacyBannersToggle) this._legacyBannersToggle._checkbox.checked = s.legacyBanners === true;
    // Explicit !== false so a save written before this key existed (where
    // the merged value is already the DEFAULTS true) reads as on, and a
    // save that flipped it off reads as off. Mirrors the
    // virtualCursorDragToggle guard above.
    if (this._moraleBarToggle)  this._moraleBarToggle._checkbox.checked  = s.showMoraleBar !== false;
    if (this._fatigueBarToggle) this._fatigueBarToggle._checkbox.checked = s.showFatigueBar !== false;
    if (this._instancedToggle) this._instancedToggle._checkbox.checked = s.instancedRendering !== false;
    if (this._antialiasToggle) this._antialiasToggle._checkbox.checked = !!s.antialias;
    if (this._shadowRefreshToggle) this._shadowRefreshToggle._checkbox.checked = s.reducedShadowRefresh !== false;
    if (this._spearChecksToggle) this._spearChecksToggle._checkbox.checked = s.reducedSpearChecks !== false;
    if (this._hudRefreshToggle) this._hudRefreshToggle._checkbox.checked = s.reducedHudRefresh !== false;
  }
}