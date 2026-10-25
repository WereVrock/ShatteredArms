// ===== SettingsStore.js =====
// Persistent user settings, backed by localStorage. One shared key holds
// the whole settings object, so adding a new field is a one-line change to
// DEFAULTS and existing saves pick up the new default automatically.
//
// Subscribers are notified whenever a value changes via set(). They are NOT
// notified on initial load — callers who need the current value should call
// SettingsStore.get() explicitly at startup. This keeps the load path
// side-effect-free (loading a page shouldn't fire every subscriber).
//
// All storage access is wrapped in try/catch: localStorage can throw in
// private-browsing mode, on quota-exceeded writes, or when disabled by
// policy. In any of those cases the store degrades to in-memory-only —
// settings still apply for the session, they just don't persist.
const STORAGE_KEY = 'battle.settings.v1';

// Named graphics-quality presets. Each maps a subset of setting keys to
// target values; SettingsStore.applyPreset() writes every entry through
// set(), so subscribers react to a preset exactly as they would to a
// player flipping the same controls by hand. Keys a preset does not list
// are left alone — a preset never silently resets an unrelated setting.
//
// Design intent per tier:
//   ultraLow — every scene cost cut AND the most aggressive LOD: closest
//              soldiers render at Simplified, distant ones at Abstracted,
//              shadow range tightened to 40 units, LOD distance shrunk
//              to 0.5, animations frozen, MSAA off. The "will it run on
//              a decade-old laptop" floor.
//   low      — the same scene cuts, but with Detailed models at closest
//              range and Abstracted at distance, shadow range at 60
//              units, LOD distance at 0.7, MSAA off. Lets a player who
//              can afford triangles but not fill rate keep the fidelity
//              they care about where they are looking, and pay nothing
//              at distance.
//   medium   — everything on at native resolution, medium shadows, full
//              shadow range, full LOD distance, MSAA on. Matches
//              DEFAULTS, so a fresh install starts on Medium. This is
//              the vanilla experience: everything visible, with the
//              cheap perf guards already in place (no supersampling, no
//              high-res shadow map).
//   max      — every quality knob at its ceiling, supersampled render
//              scale, full shadow range, full LOD distance, MSAA on,
//              and LOD disabled so every soldier is Detailed at every
//              distance. For high-end hardware.
//
// instancedRendering is deliberately absent from every preset — including
// max — because it is a bug-escape hatch, not a quality tier. Turning it
// off fixes rendering glitches on some drivers, and a preset switch must
// never silently re-enable the broken path; the player would have to find
// the toggle all over again. enableTestFeatures and rushMode are also
// absent for the same "escape hatch / non-quality" reason.
const PRESETS = Object.freeze({
  ultraLow: {
    shadowQuality: 'none',
    renderScale: '0.5',
    groundTexture: false,
    grass: false,
    fieldEdge: false,
    fog: false,
    lodEnabled: true,
    modelDetail: 3,          // Simplified at closest range
    minModelDetail: 4,       // Abstracted at distance
    disableAnimations: true,
    antialias: false,
    soldierShadowRange: '40',
    lodDistanceScale: '0.5'
  },
  low: {
    shadowQuality: 'none',
    renderScale: '0.5',
    groundTexture: false,
    grass: false,
    fieldEdge: false,
    fog: false,
    lodEnabled: true,
    modelDetail: 1,          // Detailed at closest range
    minModelDetail: 4,       // Abstracted at distance
    disableAnimations: false,
    antialias: false,
    soldierShadowRange: '60',
    lodDistanceScale: '0.7'
  },
  medium: {
    shadowQuality: 'medium',
    renderScale: '1',
    groundTexture: true,
    grass: true,
    fieldEdge: true,
    fog: true,
    lodEnabled: true,
    modelDetail: 1,          // Detailed at closest range
    minModelDetail: 4,       // Abstracted at distance
    disableAnimations: false,
    antialias: true,
    soldierShadowRange: 'all',
    lodDistanceScale: '1'
  },
  max: {
    shadowQuality: 'high',
    renderScale: '1.25',
    groundTexture: true,
    grass: true,
    fieldEdge: true,
    fog: true,
    lodEnabled: false,       // LOD off — every soldier stays at modelDetail
    modelDetail: 1,          // Detailed
    minModelDetail: 4,       // unused when LOD is off; still a valid value
    disableAnimations: false,
    antialias: true,
    soldierShadowRange: 'all',
    lodDistanceScale: '1'
  }
});

const DEFAULTS = Object.freeze({
  // Shadow map resolution tier: 'high' | 'medium' | 'low' | 'none'.
  // 'none' disables the shadow pass entirely — the same concept the old
  // boolean 'shadows' toggle carried, now folded into this single
  // dropdown so shadows have exactly one control, not two. SceneSetup
  // maps the three resolution tiers to 2048² / 1024² / 512² (see
  // SHADOW_MAP_SIZES). 'medium' is the default: 1024² over the 90-unit
  // shadow frustum is ~11 texels per world unit, visually near-identical
  // to 2048² on soldier silhouettes at battle zoom while costing a
  // quarter of the shadow-map fill.
  shadowQuality: 'medium',
  // Render scale multiplier, applied on top of the device pixel ratio
  // (itself capped at 1.5 to bound the cost on 4K displays). '1' renders
  // at native; '0.5' halves each axis — quarter the pixels, roughly 4×
  // faster fill — and lets the browser upscale; '1.25' supersamples for
  // sharper edges on high-end hardware. Stored as a string to match the
  // <select> element's value type directly. Parsed with parseFloat at the
  // consumer (SceneSetup.applySettings).
  renderScale: '1',
  groundTexture: true,
  grass: true,
  fieldEdge: true,
  fog: true,
  // When true, a right-click double-click commits its move order with
  // directMarch — soldiers walk straight to their new formation slots
  // instead of the block assembling en route. Read by
  // OrderDragController at each right-mousedown.
  doubleClickDirectMarch: true,
  // Movement mode toggle, flipped from the command bar. When true, EVERY
  // player-issued move / formation order commits with directMarch —
  // soldiers walk straight to their final slots and skip the en-route
  // formation assembly entirely. When false (orderly mode, the default),
  // that behaviour is only disabled for the order that came from a
  // right-click double-click (and only if doubleClickDirectMarch is
  // also on). Read by OrderDragController._resolveDirectMarch().
  //
  // Orthogonal to the graphics presets — no preset lists this key, so
  // applying a preset never flips it.
  rushMode: false,
  // Right-click formation drag behaviour.
  //   true  (default) — a drag opens the preview already shaped as the
  //                     selection's existing formation. Implemented in
  //                     OrderDragController by measuring the drag from a
  //                     virtual cursor offset so the preview starts at
  //                     the selection's current total width instead of
  //                     collapsing to a minimum. The OS mouse cursor is
  //                     hidden for the duration of the drag (the ghost
  //                     formation is the visual indicator) and restored
  //                     on release.
  //   false           — pre-existing behaviour: the preview starts at
  //                     the minimum width and widens as the cursor is
  //                     dragged outward. Cursor is not hidden.
  // Read by OrderDragController on each right-mousedown. Orthogonal to
  // the graphics presets — no preset lists this key.
  virtualCursorDragEnabled: true,
  // Corner FPS readout. Default off — the user-facing toggle lives in
  // Settings → UI. Debug mode (G+click unit inspection) forces the
  // counter on regardless of this value; see FpsCounter.setDebugOverride.
  showFps: false,
  // Top-right power widget, two independent gauges. Toggled from
  // Settings → UI.
  //   showPowerScale  — the antique beam balance with the two hanging pans.
  //   showPowerSwords — the two swords that shatter as power is lost.
  // With both off the widget stays hidden regardless of show()/hide()
  // calls from the battle flow. With only one on, clicking the widget
  // reveals the other gauge too — see PowerBalanceView._applyLayout.
  showPowerScale: true,
  showPowerSwords: false,
  // Army-bar card overlays. Two independent toggles because a player
  // might want to see morale on every unit but not fatigue, or vice
  // versa. Read once per update() call by ArmyBarView — no per-frame
  // cost per element, and toggling either takes effect on the next
  // render frame without any subscription plumbing.
  //
  //   showMoraleBar  — thin green/amber/red bar under each card's icon,
  //                    averaged across the unit's living soldiers and
  //                    measured against each soldier's own morale
  //                    ceiling (goblins cap at 70, humans at 100), so a
  //                    full-strength goblin unit reads as 100% rather
  //                    than being penalised for its race.
  //   showFatigueBar — thin tan bar below the morale bar, averaged
  //                    across living soldiers against the universal 100
  //                    ceiling on Soldier.fatigue.
  //
  //                    UI NOTE: the setting key and the underlying
  //                    field are named "fatigue" (sim vocabulary), but
  //                    every player-facing label calls the stat
  //                    "stamina" — the value reads as stamina
  //                    remaining (100 = fresh), so the negative word
  //                    is wrong for the UI. Same rule as
  //                    UnitInfoPanel's stat label. Keep the key as-is;
  //                    do not rename the field.
  //
  // Both default on: the bars are a HUD density choice, not a scene
  // quality one, and a new player is better served by being able to
  // read unit state at a glance than by having to find the toggle.
  showMoraleBar: true,
  showFatigueBar: true,
  // World-space unit overlays. Two independent toggles controlling the
  // floating markers drawn above units during battle:
  //
  //   showUnitFlags — a small team-coloured flag glyph floating above
  //                   EVERY living unit, enemy and player alike. The
  //                   point is legibility: the player can read unit
  //                   positions and sides at a glance without having to
  //                   hover, click, or zoom.
  //   showUnitBars  — morale and stamina bars floating above PLAYER-TEAM
  //                   units only. Mirrors the army-bar card overlays
  //                   (showMoraleBar / showFatigueBar) but anchored to
  //                   the unit's world position rather than its card.
  //                   Enemy bars are deliberately not shown — reading
  //                   the enemy's internal morale is information the
  //                   player should have to infer from behaviour, not
  //                   read off a bar.
  //
  // Both default on: the overlay is a HUD density choice, not a scene
  // quality one, matching showMoraleBar / showFatigueBar above. Read
  // each render frame by the world-overlay renderer.
  showUnitFlags: true,
  showUnitBars: true,
  // Level of Detail. When true, every soldier picks its model tier each
  // frame based on its XZ distance from the camera, between modelDetail
  // (the most detailed tier shown) and minModelDetail (the most simplified
  // tier shown). When false, every soldier uses modelDetail as a fixed
  // tier regardless of distance. See render/LodConfig.js for the tier
  // enum and the distance thresholds, and SoldierView._maybeUpdateLod for
  // the per-frame decision.
  lodEnabled: true,
  // The most detailed tier the player allows. Lower number = more detail.
  // 1 = Detailed, 2 = Reduced Details, 3 = Simplified, 4 = Abstracted.
  // When lodEnabled is false this is the fixed tier for the whole battle.
  modelDetail: 1,
  // The most simplified tier the player allows. Higher number = less
  // detail. Only consulted when lodEnabled is true; when LOD is off this
  // value is ignored. Must be >= modelDetail (SettingsPanel enforces).
  minModelDetail: 4,
  // When true, all procedural per-frame animations (walk cycles, attack
  // swings, bow draw, shield block bump) freeze at their rest pose. The
  // death topple and airborne tumble are state transitions, not
  // animations, and still play. Off by default.
  disableAnimations: false,
  // Same-device multiplayer only. When true, the coin toss that decides
  // who deploys first and who takes the first turn each cycle resolves
  // instantly — no animation. Toggled from the checkbox next to the in-
  // game Menu button. Default false: the toss is part of the local-MP
  // feel and its result is worth reading.
  instantCoinToss: false,
  // Draws all soldier parts through a few instanced draw calls instead of
  // one draw call per part. Same geometry, materials, lighting and
  // shadows — only the submission path changes. Turn off to fall back to
  // the classic per-mesh path.
  //
  // Deliberately not listed by any preset, INCLUDING max: this is a
  // bug-escape hatch, not a quality tier. Turning it off is a fix for
  // rendering glitches on some drivers, and a preset switch must never
  // silently re-enable the broken path behind the player's back. Presets
  // leave it exactly where the player (or DEFAULTS) put it.
  instancedRendering: true,
  // Optional shadow cut-off for soldiers: 'all' keeps every visible
  // soldier casting a shadow (no visual loss); a number is the distance,
  // in world units from the camera's look-at point, beyond which soldiers
  // stop casting shadows. Part of the graphics presets — the low tiers
  // tighten the range — but written through set() so a manual tweak made
  // afterwards survives until the next explicit preset switch.
  soldierShadowRange: 'all',
  // Optional LOD distance multiplier, stored as a string like the other
  // select settings. '1' keeps the authored thresholds (no visual loss);
  // smaller values shrink the high-detail zones around the camera. Part
  // of the graphics presets — the low tiers shrink it — but written
  // through set() so a manual tweak made afterwards survives until the
  // next explicit preset switch.
  lodDistanceScale: '1',
  // Hardware multisampling (MSAA). Smooths edges on small high-contrast
  // parts such as helmets. Only read when the WebGL context is created, so
  // a change applies after the next battle start / Restart. Costs GPU
  // fill rate. Default on — Medium (the vanilla experience) includes it,
  // and the two low preset tiers turn it off as part of their perf
  // budget.
  antialias: true,
  // Master switch for in-development features that are not balanced for
  // normal play. Exposed only in the main-menu Settings dialog (see
  // SettingsPanel.open context handling) — the in-game pause menu does
  // not surface it, because flipping a test flag mid-battle could
  // destabilise an active session that was built under the other value.
  //
  // When true, gates like the Campaign Commander (champion) system open
  // up. Read via areChampionsEnabled() in ChampionConfig.js; do not read
  // this key directly at feature sites — the champion gate is the only
  // consumer today, but the pattern is to add one helper per gated
  // subsystem rather than scatter raw key reads.
  //
  // Orthogonal to the graphics presets — no preset lists this key, so
  // applying a preset never flips it, and getMatchingPreset() ignores
  // it (only compares keys a preset explicitly names).
  enableTestFeatures: false
});

export class SettingsStore {
  static _current = null;
  static _listeners = new Set();

  // Returns the live settings object. The object is shared, not copied —
  // callers should treat it as read-only and mutate via set() so subscribers
  // fire. On first call, loads from localStorage and merges over DEFAULTS.
  static get() {
    if (!this._current) {
      this._current = this._load();
    }
    return this._current;
  }

  // Sets a single key. No-op if the value is unchanged, so subscribers don't
  // fire on redundant sets (a checkbox syncing from state, for example).
  static set(key, value) {
    const s = this.get();
    if (s[key] === value) return;
    s[key] = value;
    this._persist(s);
    for (const fn of this._listeners) {
      try { fn(s, key, value); } catch (e) { /* subscriber errors must not break others */ }
    }
  }

  // Registers a change listener. Returns an unsubscribe function.
  static subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // Applies a named preset (see PRESETS). Writes each of the preset's
  // keys through set(), so an already-matching key is a no-op and every
  // changed key fires subscribers exactly once. Unknown names are
  // ignored — a caller passing a stale preset id gets no side effects.
  static applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;
    for (const key of Object.keys(preset)) {
      this.set(key, preset[key]);
    }
  }

  // Returns the name of the preset whose key/value set matches the current
  // settings, or null if nothing matches (i.e. the player has customised
  // at least one preset-controlled key). Used by SettingsPanel to show
  // "Custom" in the preset dropdown when no preset fully describes the
  // current configuration.
  //
  // Only keys present in the preset are compared — a preset that does not
  // list a given setting is not considered to disagree with it, because
  // every preset is documented (see PRESETS) to leave unlisted keys
  // untouched.
  static getMatchingPreset() {
    const s = this.get();
    for (const name of Object.keys(PRESETS)) {
      const preset = PRESETS[name];
      let matches = true;
      for (const key of Object.keys(preset)) {
        if (s[key] !== preset[key]) { matches = false; break; }
      }
      if (matches) return name;
    }
    return null;
  }

  // Clears persisted settings and resets in-memory state to DEFAULTS,
  // notifying subscribers. Useful for a "reset to defaults" button later.
  static reset() {
    this._current = { ...DEFAULTS };
    this._persist(this._current);
    for (const fn of this._listeners) {
      try { fn(this._current, null, null); } catch (e) { /* see set() */ }
    }
  }

  static _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };

      // Spread order: DEFAULTS first, saved values over. Any key added to
      // DEFAULTS after a save was written is filled in with its default,
      // and any key removed from DEFAULTS but still present in an old save
      // is carried along unused.
      const merged = { ...DEFAULTS, ...parsed };

      // Migration: pre-dropdown saves stored shadows as a boolean and had
      // no 'none' tier. Fold a 'shadows: false' save into
      // 'shadowQuality: none' so the player's intent survives the UI
      // change. Only fires when the save PREDATES shadowQuality — a save
      // that has both keys is newer, and its shadowQuality is
      // authoritative.
      if (parsed.shadowQuality === undefined && parsed.shadows === false) {
        merged.shadowQuality = 'none';
      }
      // Drop the legacy key so it does not linger in persisted form.
      delete merged.shadows;

      // Migration: the single 'showPowerBalance' toggle was split into
      // independent scale / sword toggles. A save that had the widget
      // hidden keeps both hidden; any other old save falls through to the
      // new defaults (scale on, swords only on click).
      if (parsed.showPowerScale === undefined && parsed.showPowerBalance === false) {
        merged.showPowerScale = false;
        merged.showPowerSwords = false;
      }
      delete merged.showPowerBalance;

      // Migration: the binary 'simpleModels' toggle was replaced by the
      // LOD trio. A save that had simpleModels:true becomes LOD-off with
      // a fixed Simplified tier — the closest match to the old
      // fixed-simplified behaviour. A save that had simpleModels:false
      // falls through to the new defaults (LOD on, Detailed at close
      // range). Only fires when the save PREDATES modelDetail; a save
      // with both keys is newer and its LOD values are authoritative.
      if (parsed.modelDetail === undefined && parsed.simpleModels !== undefined) {
        if (parsed.simpleModels === true) {
          merged.lodEnabled = false;
          merged.modelDetail = 3;
          merged.minModelDetail = 3;
        }
      }
      delete merged.simpleModels;

      return merged;
    } catch (e) {
      return { ...DEFAULTS };
    }
  }

  static _persist(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      // See file header — silent no-op, in-memory values still apply.
    }
  }
}