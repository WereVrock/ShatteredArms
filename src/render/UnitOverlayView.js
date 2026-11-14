// ===== src/render/UnitOverlayView.js =====
// World-space overlays drawn during battle:
//
//   Shield billboard — ONE THREE.Sprite per unit, carrying the unit's
//     entire marker on a single canvas: HP / morale / stamina bars on
//     top, a team-coloured banner below (see ShieldBillboard.js).
//     Because it is one sprite the whole thing billboards as a single
//     unit — bars and banner stay rigidly aligned from any camera angle.
//
//   Bars — drawn inside the billboard's canvas, ABOVE the banner. Only
//     shown for PLAYER-TEAM units; enemy bars are deliberately NOT shown.
//
// ANCHORING
// The overlay is positioned above the unit's STILL-FIGHTING soldiers —
// the alive subset that is neither routing nor shattered. A unit that
// has lost a few soldiers to a rout but is still holding keeps its
// marker over the men who are still in the line.
//
// BANNER BOTTOM ANCHOR
// The shield's bottom edge is pinned to SHIELD_BOTTOM_Y (2.0 world
// units — above soldier heads at ~1.7). Both the distance scale and the
// player-chosen banner size grow the shield UPWARD from that fixed
// bottom edge, so neither zooming out nor picking "large" can cause the
// banner to clip into the soldier models beneath it.
//
// STATE-CHANGE EFFECTS
//   FULL COLLAPSE — the entire billboard pulses opacity while EVERY
//     living soldier on the unit is routing or shattered.
//
//   Shattered additionally triggers a one-shot burst of team-coloured
//     fragment sprites, and — for a PLAYER-TEAM unit only — destroys
//     the marker for the rest of the battle.
//
// PAUSE BEHAVIOUR
// The collapse pulse runs on WALL-CLOCK time; the shield-piece fall and
// the shatter-burst fragments run on the sim delta and freeze with the
// battle.
import * as THREE from 'three';
import { ActiveTerrain } from '../session/ActiveTerrain.js';
import { SettingsStore } from '../ui/settings/SettingsStore.js';
import { TeamColors } from './TeamColors.js';
import {
  ShieldBillboard,
  bannerSizeMultiplier
} from './ShieldBillboard.js';
import {
  SHIELD_PIECE_COUNT
} from './ShieldIconBuilder.js';
import { computeBannerLift } from './BannerOcclusion.js';

// Fixed world Y of the shield's BOTTOM edge. The billboard's sprite is
// positioned so the shield's bottom edge sits here; distance scale and
// banner-size multiplier both grow the banner UP from this anchor. Set
// to 2.0 to clear the ~1.7-tall soldier heads at any zoom or size.
const SHIELD_BOTTOM_Y = 2.0;

// Occlusion-lift smoothing and chain-visibility hysteresis. See
// BannerOcclusion.js for the lift itself and _updateEntry for how these
// are applied.
//
// LIFT_SMOOTHING is the per-16ms blend fraction. The applied rate is
// asymmetric: raising is faster (banner clears a newly-intruding tree
// promptly), lowering is slower (a passing tree must not drop the
// banner the frame after it leaves the ray).
//
// The chain thresholds are deliberately distinct. A single threshold
// would let a lift hovering near it toggle the chain on and off every
// frame — the exact flicker the hysteresis exists to prevent. The gap
// (0.35 vs 0.08) also absorbs the small lift oscillation that a
// drifting camera produces when an occluder is intermittent along the
// ray.
const LIFT_SMOOTHING = 0.18;        // blend per 16ms frame at 60fps
const CHAIN_ON_THRESHOLD = 0.35;    // lift above which the chain appears
const CHAIN_OFF_THRESHOLD = 0.08;   // lift below which the chain disappears

// Render order within the transparent pass.
const RENDER_ORDER_BILLBOARD = 3;

// Morale band thresholds, matching ArmyBarView and UnitInfoPanel.
const BAND_FULL_MIN = 0.6;
const BAND_HURT_MIN = 0.3;

// Collapse pulse.
const FLASH_PULSE_PERIOD_S = 0.6;
const FLASH_DIM_OPACITY = 0.30;

// Shield-piece fall. One piece is released when the unit's HP crosses
// its threshold; it drops + spins + fades over this duration, on the
// sim delta so a paused battle freezes it in mid-air.
const PIECE_FALL_DURATION_S = 0.7;
const PIECE_FALL_DROP = 1.5;
const PIECE_FALL_ROTATION_MAX = 0.9;

// Shatter burst.
const SHATTER_BURST_DURATION_S = 0.85;
const SHATTER_FRAGMENT_COUNT = 6;
const SHATTER_FRAGMENT_SIZE = 0.22;
const SHATTER_FRAGMENT_SPEED_MIN = 1.2;
const SHATTER_FRAGMENT_SPEED_MAX = 2.2;
const SHATTER_FRAGMENT_UP_VELOCITY = 1.8;
const SHATTER_FRAGMENT_GRAVITY = 4.5;

export class UnitOverlayView {
  constructor(scene, playerTeamId = 'blue') {
    this.scene = scene;
    this.playerTeamId = playerTeamId;

    // unitId -> entry. Created on first sight of a unit, then reused
    // every frame. No scene-graph churn after the first tick.
    this._entriesByUnitId = new Map();

    // Per-piece sprite materials this view owns. Each falling piece gets
    // its own material so its opacity and rotation are independent of
    // every other piece.
    this._fallingPieceMaterials = new Set();

    // Active shatter bursts. Each is { material, frags, timeLeft }.
    this._shatterBursts = [];
  }

  setPlayerTeamId(teamId) {
    this.playerTeamId = teamId;
  }

  update(unitsById, deltaSeconds, camera) {
    const settings = SettingsStore.get();
    const showShields = settings.showUnitFlags !== false;
    const showBars = settings.showUnitBars !== false;
    const showAnything = showShields || showBars;

    // Banner size multiplier from the setting. Read fresh each frame so
    // a change takes effect on the next render — consistent with how
    // showShields / showBars already behave.
    const sizeMult = bannerSizeMultiplier(settings.bannerSize || 'small');

    // Wall-clock timestamp for the collapse pulse.
    const nowMs = performance.now();

    this._updateShatterBursts(deltaSeconds);

    const seen = new Set();

    for (const [unitId, unit] of unitsById) {
      const alive = unit.getAliveSoldiers();

      if (alive.length === 0 || !showAnything) {
        const existing = this._entriesByUnitId.get(unitId);
        if (existing) existing.group.visible = false;
        continue;
      }

      seen.add(unitId);

      const legacyBanners = settings.legacyBanners === true;
      let entry = this._entriesByUnitId.get(unitId);
      if (!entry) {
        entry = this._createEntry(unit);
        entry.legacyBanners = legacyBanners;
        this._entriesByUnitId.set(unitId, entry);
      } else if (entry.legacyBanners !== legacyBanners) {
        // Style setting flipped — dispose the current entry and rebuild
        // through the other pipeline. The billboard's piece textures are
        // baked by ShieldIconBuilder at construction time, so they cannot
        // be swapped in place; a fresh entry is the simplest correct
        // refresh. Broken-piece state resets, which reads as "the banner
        // re-forms" — acceptable and expected for a display-style
        // toggle that a player flips rarely.
        this._disposeEntry(entry);
        entry = this._createEntry(unit);
        entry.legacyBanners = legacyBanners;
        this._entriesByUnitId.set(unitId, entry);
      }

      this._updateEntry(
        entry, unit, alive, showShields, showBars, nowMs, deltaSeconds, camera, sizeMult
      );
    }

    // Defensive: hide any entry whose unit is no longer in the map.
    for (const [unitId, entry] of this._entriesByUnitId) {
      if (!seen.has(unitId)) entry.group.visible = false;
    }
  }

  dispose() {
    for (const entry of this._entriesByUnitId.values()) {
      this._disposeEntry(entry);
    }
    this._entriesByUnitId.clear();

    for (const mat of this._fallingPieceMaterials) mat.dispose();
    this._fallingPieceMaterials.clear();

    for (const burst of this._shatterBursts) {
      for (const f of burst.frags) this.scene.remove(f.sprite);
      burst.material.dispose();
    }
    this._shatterBursts.length = 0;
  }

  // Detaches one entry's scene graph, disposes its billboard's sprite
  // material + texture, and cleans up any in-flight shard sprites and
  // materials. Idempotent — safe to call on a live entry or one whose
  // shards have already completed. Used by dispose() and by the
  // legacyBanners setting flip in update().
  _disposeEntry(entry) {
    this.scene.remove(entry.group);
    if (entry.billboard) entry.billboard.dispose();
    if (entry.chain) {
      entry.chain.geometry.dispose();
      entry.chain.material.dispose();
    }
    for (const piece of entry.shieldPieces) {
      if (piece.sprite && piece.sprite.parent) {
        piece.sprite.parent.remove(piece.sprite);
      }
      if (piece.material) {
        this._fallingPieceMaterials.delete(piece.material);
        piece.material.dispose();
        piece.material = null;
      }
      piece.sprite = null;
    }
  }

  // --- internals ---------------------------------------------------------

  _createEntry(unit) {
    const group = new THREE.Group();

    const lead = unit.soldiers && unit.soldiers[0];
    const typeDef = lead ? lead.unitTypeDef : null;

    const teamColorHex = TeamColors[unit.teamId] ?? 0xaaaaaa;

    let billboard = null;
    if (typeDef) {
      // A unit is a "thrall unit" when its lead soldier carries the
      // isThrall flag. Thralls get a blood-drop icon on their banner.
      const isThrallUnit = lead && lead.isThrall === true;
      billboard = new ShieldBillboard(
        typeDef, unit.isUndead, unit.teamId, isThrallUnit
      );
      // Initial position at the base anchor; real Y set every frame in
      // _updateEntry via getAnchorOffset().
      billboard.sprite.position.set(0, SHIELD_BOTTOM_Y, 0);
      billboard.sprite.renderOrder = RENDER_ORDER_BILLBOARD;
      group.add(billboard.sprite);
    }

    // Per-piece break bookkeeping. Piece 0 is the banner's TOP band; the
    // BOTTOM band (index COUNT-1) has the highest HP threshold and so
    // breaks off first.
    const shieldPieces = [];
    const thresholds = billboard ? billboard.thresholds : null;
    for (let i = 0; i < SHIELD_PIECE_COUNT; i++) {
      shieldPieces.push({
        broken: false,
        falling: false,
        done: false,
        fallTime: 0,
        sprite: null,
        material: null,
        fallRotVel: 0,
        fallDriftX: 0,
        // Set at spawn; used by the fall animation as a stable start Y.
        startY: 0,
        threshold: thresholds ? thresholds[i] : 0
      });
    }

    // Chain. A thin rod from the unit's ground anchor (group-local Y = 0)
    // up to the banner's bottom edge. Hidden by default — the floating
    // banner needs no visible support — and shown only when the banner
    // is lifted to clear an intervening hill or tree (see computeBannerLift
    // and the lift write in _updateEntry). The visible purpose is to
    // preserve the "banner belongs to this unit" read when the banner
    // sits much higher than the unit it labels.
    //
    // Geometry is bottom-anchored (translated +0.5 on Y before assignment)
    // so scale.y directly sets the chain's world height with its base
    // pinned at the group origin.
    const chainGeo = new THREE.CylinderGeometry(0.03, 0.03, 1, 6);
    chainGeo.translate(0, 0.5, 0);
    // depthTest: false so the chain is always visible — the whole reason
    // the banner was lifted is that something stood between it and the
    // camera, and a depth-tested chain would hide behind that same
    // occluder, defeating the "connected to this unit" read.
    // depthWrite: false so the billboard (renderOrder 3) is not affected
    // by the chain's depth, and transparent so the chain can fade in and
    // out around the hysteresis threshold without a visible pop.
    const chainMat = new THREE.MeshBasicMaterial({
      color: 0x4a3a2a,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false
    });
    const chain = new THREE.Mesh(chainGeo, chainMat);
    chain.visible = false;
    chain.renderOrder = 2;
    chain.frustumCulled = false;
    group.add(chain);

    this.scene.add(group);

    return {
      group,
      billboard,
      shieldPieces,
      teamColorHex,
      chain,
      wasCollapsed: false,
      wasShattered: false,
      flagShattered: false,
      // Wall-clock timestamp (ms) of the current pulse's rising edge.
      flashStartMs: null,

      // Occlusion-lift state. _currentLift is the SMOOTHED lift value
      // currently applied to the billboard — it lags the target so a
      // passing occluder produces a gentle rise/fall rather than a
      // jump. _chainActive is a hysteresis flag (separate on/off
      // thresholds) that prevents the chain appearing and disappearing
      // every frame when lift hovers near a single threshold.
      // _chainOpacity is the chain's fade value so its appearance and
      // disappearance are not a pop.
      _currentLift: 0,
      _chainActive: false,
      _chainOpacity: 0,

      // Per-frame cache for computeBannerLift. Both key halves are
      // rounded to 0.25-unit granularity, so sub-quarter-unit camera
      // drift and slow soldier movement reuse the previous lift result
      // instead of re-running the grid query. See _updateEntry.
      _liftCacheKey: '',
      _liftCacheTarget: 0
    };
  }

  _updateEntry(entry, unit, alive, showShields, showBars, nowMs, deltaSeconds, camera, sizeMult) {
    entry.group.visible = true;

    // --- anchoring --------------------------------------------------------
    // Split the alive list into the STILL-FIGHTING subset (neither
    // routing nor shattered) and the rest. The marker anchors to the
    // fighting subset so a few runners do not drag it away.
    let fightingCount = 0;
    let shatteredCount = 0;
    let fx = 0, fz = 0;
    let ax = 0, az = 0;

    for (const s of alive) {
      ax += s.pos.x;
      az += s.pos.z;
      if (s.state === 'shattered') shatteredCount++;
      const isOut = s.state === 'routing' || s.state === 'shattered';
      if (!isOut) {
        fx += s.pos.x;
        fz += s.pos.z;
        fightingCount++;
      }
    }

    ax /= alive.length;
    az /= alive.length;

    let anchorX, anchorZ;
    if (fightingCount > 0) {
      anchorX = fx / fightingCount;
      anchorZ = fz / fightingCount;
    } else {
      anchorX = ax;
      anchorZ = az;
    }
    // Anchor the banner group to the terrain under the unit rather than
    // flat world Y = 0. Every child sprite Y value — the shield bottom,
    // falling shard start, etc. — is LOCAL to this group, so raising the
    // group raises the whole banner uniformly. Pre-elevation this read 0
    // and was correct; on hills it left the banner hanging below soldier
    // heads, or buried behind an intervening ridge.
    const groundY = ActiveTerrain.heightAt(anchorX, anchorZ);
    entry.group.position.set(anchorX, groundY, anchorZ);

    // --- distance + size scale --------------------------------------------
    // The banner sits at a fixed SCREEN size across zoom (distance factor)
    // but its WORLD size at that constant screen size is the player's
    // banner-size setting (sizeMult). Both factors are multiplied together
    // by the billboard. The sprite's Y offset is derived from the shield's
    // BOTTOM anchor (SHIELD_BOTTOM_Y) plus the anchor offset at current
    // combined scale, so the shield bottom always sits at SHIELD_BOTTOM_Y
    // regardless of zoom or size.
    if (camera && entry.billboard) {
      entry.billboard.setSizeMultiplier(sizeMult);
      // Shield center Y at the CURRENT state — used only as the reference
      // point for the distance calc. One frame of lag is negligible; the
      // billboard's _worldScale will refresh immediately after.
      // Shield's WORLD-Y centre: the group already sits at groundY, so the
      // local bottom-anchor offset stacks on top of it. Camera-distance
      // sizing must use this world value, not the local offset alone, or
      // the banner will zoom out as the unit climbs toward the camera.
      const shieldCenterY =
        groundY + SHIELD_BOTTOM_Y + entry.billboard.getShieldCenterOffset();
      const cam = camera.position;
      const dx = anchorX - cam.x;
      const dy = shieldCenterY - cam.y;
      const dz = anchorZ - cam.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      entry.billboard.setWorldScale(distance);

      // Occlusion lift. See BannerOcclusion.js for the algorithm and the
      // spatial-grid acceleration. Only computed when the shield is
      // actually drawn (banners hidden → skip the grid query entirely);
      // otherwise the previous smoothed lift is simply held. Lift state
      // is retained through a "shields hidden" period, so when the
      // setting is re-enabled the banner picks up where it left off
      // instead of popping from zero.
      let targetLift = 0;
      if (showShields) {
        // Per-frame cache. Both halves rounded to 0.25 world units, so
        // small camera drift and slow soldier movement reuse the
        // previous result. Cache-miss cost is one grid query plus
        // ~20-80 inner iterations; cache-hit is one string compare.
        const camKey =
          `${Math.round(cam.x * 4)},` +
          `${Math.round(cam.y * 4)},` +
          `${Math.round(cam.z * 4)}`;
        const anchorKey =
          `${Math.round(anchorX * 4)},${Math.round(anchorZ * 4)}`;
        const cacheKey = camKey + '|' + anchorKey;

        if (entry._liftCacheKey === cacheKey) {
          targetLift = entry._liftCacheTarget;
        } else {
          const terrain = ActiveTerrain.get();
          targetLift = computeBannerLift(
            anchorX, anchorZ, cam, terrain, SHIELD_BOTTOM_Y
          );
          entry._liftCacheKey = cacheKey;
          entry._liftCacheTarget = targetLift;
        }
      } else {
        targetLift = entry._currentLift;
      }

      // Smoothing. k is zero when paused (deltaSeconds = 0), so the
      // banner freezes mid-transition exactly like every other
      // animation. Asymmetric rate: rise 2x faster than fall, so a
      // newly-intruding occluder is cleared promptly while a passing
      // one does not drop the banner the frame after it leaves the ray.
      // The final Math.min(1, ...) prevents overshoot on a low-FPS
      // frame; without it the lift would jump past its target and
      // oscillate back the next frame — the exact jitter this smoothing
      // exists to remove.
      const k = deltaSeconds > 0
        ? Math.min(1, LIFT_SMOOTHING * (deltaSeconds / 0.016))
        : 0;
      const rate = Math.min(
        1,
        targetLift > entry._currentLift ? k * 2.0 : k * 0.5
      );
      entry._currentLift += (targetLift - entry._currentLift) * rate;
      if (Math.abs(entry._currentLift) < 0.005) entry._currentLift = 0;

      // Chain visibility hysteresis. On and off use DIFFERENT
      // thresholds, so a lift hovering near a single value cannot
      // toggle the chain every frame. The 0.35 / 0.08 gap is wider than
      // any lift oscillation a drifting camera can produce while an
      // occluder remains intermittent along the ray.
      if (!entry._chainActive && entry._currentLift > CHAIN_ON_THRESHOLD) {
        entry._chainActive = true;
      } else if (entry._chainActive &&
                 entry._currentLift < CHAIN_OFF_THRESHOLD) {
        entry._chainActive = false;
      }

      const spriteLocalY =
        SHIELD_BOTTOM_Y + entry.billboard.getAnchorOffset()
        + entry._currentLift;
      entry.billboard.sprite.position.y = spriteLocalY;

      // Chain. Shown only when the banner has been lifted above the
      // default floating position — the default banner needs no visible
      // support. Scale tracks the SMOOTHED lift (not the target), so
      // the chain's top edge stays exactly at the shield's bottom edge
      // throughout the rise. Opacity fades in and out via the same
      // smoothing rate, so the chain's appearance is not a pop even
      // though its hysteresis threshold is crossed in one frame.
      if (entry.chain) {
        const chainTargetOpacity = entry._chainActive ? 1 : 0;
        entry._chainOpacity +=
          (chainTargetOpacity - entry._chainOpacity) * rate;
        if (entry._chainOpacity > 0.01) {
          entry.chain.visible = true;
          entry.chain.scale.y = SHIELD_BOTTOM_Y + entry._currentLift;
          entry.chain.material.opacity = entry._chainOpacity;
        } else {
          entry.chain.visible = false;
        }
      }
    }

    // --- collapse / shatter detection -------------------------------------
    const isCollapsed = fightingCount === 0;
    const isShattered = shatteredCount === alive.length;

    if (isCollapsed && !entry.wasCollapsed) entry.flashStartMs = nowMs;
    if (isShattered && !entry.wasShattered) {
      if (unit.teamId === this.playerTeamId && !entry.flagShattered) {
        entry.flagShattered = true;
        // Shatter burst particles are added directly to the scene (world
        // coords, NOT group-local), so groundY has to be folded in here —
        // unlike the billboard and falling shards, which inherit groundY
        // from the group position.
        const burstY = groundY + (entry.billboard
          ? SHIELD_BOTTOM_Y + entry.billboard.getShieldCenterOffset()
          : SHIELD_BOTTOM_Y + 0.9);
        this._spawnShatterBurst(anchorX, burstY, anchorZ, entry.teamColorHex);
      }
    }
    entry.wasCollapsed = isCollapsed;
    entry.wasShattered = isShattered;

    // --- pulse phase ------------------------------------------------------
    let pulseOpacity = 1.0;
    if (isCollapsed) {
      if (entry.flashStartMs === null) entry.flashStartMs = nowMs;
      const elapsedS = (nowMs - entry.flashStartMs) / 1000;
      const phase = (elapsedS / FLASH_PULSE_PERIOD_S) % 1;
      pulseOpacity = phase < 0.5 ? FLASH_DIM_OPACITY : 1.0;
    } else {
      entry.flashStartMs = null;
    }

    // --- shield integrity + bar values ------------------------------------
    const isPlayerTeam = unit.teamId === this.playerTeamId;

    let hpSum = 0;
    let maxHpSum = 0;
    for (const s of unit.soldiers) {
      maxHpSum += s.maxHp;
      if (s.isAlive()) hpSum += s.hp;
    }
    const hpFrac = maxHpSum > 0 ? hpSum / maxHpSum : 1;

    if (!entry.billboard) return;

    // Break any piece whose threshold the unit's HP has crossed. A
    // broken piece never un-breaks — HP does not recover in battle.
    for (let i = 0; i < entry.shieldPieces.length; i++) {
      const piece = entry.shieldPieces[i];
      if (piece.broken) continue;
      if (hpFrac < piece.threshold) {
        piece.broken = true;
        piece.falling = true;
        piece.fallTime = 0;
        piece.fallRotVel = (Math.random() - 0.5) * 2 * PIECE_FALL_ROTATION_MAX;
        piece.fallDriftX = (Math.random() - 0.5) * 0.4;
        entry.billboard.breakPiece(i);
        this._spawnFallingPiece(entry, i);
      }
    }

    // Advance in-flight pieces. Uses the sim delta, so a paused battle
    // freezes shards in mid-air. The shard drops from its snapshotted
    // startY, which was the shield's visual center Y at spawn time.
    for (const piece of entry.shieldPieces) {
      if (!piece.falling) continue;
      piece.fallTime += deltaSeconds;
      const t = Math.min(1, piece.fallTime / PIECE_FALL_DURATION_S);

      const drop = t * t * PIECE_FALL_DROP;
      piece.sprite.position.set(
        piece.fallDriftX * t,
        piece.startY - drop,
        0
      );
      piece.material.rotation = piece.fallRotVel * t;
      piece.material.opacity = 1 - t;

      if (t >= 1) {
        piece.falling = false;
        piece.done = true;
        if (piece.sprite && piece.sprite.parent) {
          piece.sprite.parent.remove(piece.sprite);
        }
        piece.sprite = null;
        if (piece.material) {
          this._fallingPieceMaterials.delete(piece.material);
          piece.material.dispose();
          piece.material = null;
        }
      }
    }

    // --- bar values -------------------------------------------------------
    const barsVisible = showBars && isPlayerTeam && !entry.flagShattered;

    let moraleFrac = 0;
    let moraleBand = 'full';
    let fatigueFrac = 0;
    if (barsVisible) {
      let moraleSum = 0;
      let maxMoraleSum = 0;
      for (const s of alive) {
        moraleSum += s.morale;
        maxMoraleSum += (s.maxMorale ?? 100);
      }
      moraleFrac = maxMoraleSum > 0
        ? Math.max(0, Math.min(1, moraleSum / maxMoraleSum))
        : 0;
      if (moraleFrac <= BAND_HURT_MIN) moraleBand = 'critical';
      else if (moraleFrac <= BAND_FULL_MIN) moraleBand = 'hurt';

      let fatigueSum = 0;
      for (const s of alive) fatigueSum += s.fatigue;
      fatigueFrac = alive.length > 0
        ? Math.max(0, Math.min(1, fatigueSum / alive.length / 100))
        : 0;
    }

    let hasChampion = false;
    let championFrac = 0;
    if (barsVisible && unit.championSoldier) {
      const champ = unit.championSoldier;
      if (champ.isAlive()) {
        hasChampion = true;
        championFrac = champ.maxHp > 0
          ? Math.max(0, Math.min(1, champ.hp / champ.maxHp))
          : 0;
      }
    }

    // Hide the entire billboard when the banner overlay is off, or when
    // the unit has shattered (for a player-team unit). Bars ride on the
    // same sprite, so they disappear together.
    entry.billboard.sprite.visible = showShields && !entry.flagShattered;
    if (entry.billboard.sprite.visible) {
      entry.billboard.update({
        moraleFrac,
        moraleBand,
        fatigueFrac,
        hasChampion,
        championFrac,
        pulseOpacity,
        showBars: barsVisible
      });
    }
  }

  // Spawns the transient falling sprite for a piece that just broke. The
  // sprite uses the SHARED piece texture (canvas-sized) so starting the
  // sprite at the shield's current visual centre puts the piece's visible
  // content exactly where it was on the shield, before the fall begins.
  _spawnFallingPiece(entry, pieceIndex) {
    const piece = entry.shieldPieces[pieceIndex];
    if (!piece || piece.sprite) return;

    const texture = entry.billboard.getPieceTexture(pieceIndex);
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false
    });
    this._fallingPieceMaterials.add(mat);

    // Shard inherits the banner's current sprite scale so the falling
    // piece is exactly the same size as the band it just detached from.
    // Since both dimensions of the sprite are SPRITE_WORLD_W * scale
    // (the piece texture is square), reading sprite.scale.x gives the
    // shard's world size directly. Snapshotted at spawn, so a camera
    // zoom mid-fall does not resize an in-flight shard — matching the
    // existing snapshot-at-spawn behaviour of entry.currentFactor.
    const shardScale = entry.billboard.sprite.scale.x;
    const startY = SHIELD_BOTTOM_Y + entry.billboard.getShieldCenterOffset();

    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(shardScale, shardScale, 1);
    sprite.position.set(0, startY, 0);
    sprite.renderOrder = RENDER_ORDER_BILLBOARD;

    entry.group.add(sprite);
    piece.sprite = sprite;
    piece.material = mat;
    piece.startY = startY;
  }

  // --- shatter burst ------------------------------------------------------

  _spawnShatterBurst(x, y, z, teamColorHex) {
    const mat = new THREE.SpriteMaterial({
      color: teamColorHex,
      transparent: true,
      opacity: 1,
      depthTest: true,
      depthWrite: false
    });

    const frags = [];
    for (let i = 0; i < SHATTER_FRAGMENT_COUNT; i++) {
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(SHATTER_FRAGMENT_SIZE, SHATTER_FRAGMENT_SIZE, 1);
      sprite.position.set(x, y, z);
      this.scene.add(sprite);

      const angle = (i / SHATTER_FRAGMENT_COUNT) * Math.PI * 2
                  + (Math.random() - 0.5) * 0.6;
      const speed = SHATTER_FRAGMENT_SPEED_MIN
                  + Math.random() * (SHATTER_FRAGMENT_SPEED_MAX - SHATTER_FRAGMENT_SPEED_MIN);

      frags.push({
        sprite,
        vx: Math.cos(angle) * speed,
        vy: SHATTER_FRAGMENT_UP_VELOCITY * (0.85 + Math.random() * 0.3),
        vz: Math.sin(angle) * speed
      });
    }

    this._shatterBursts.push({
      material: mat,
      frags,
      timeLeft: SHATTER_BURST_DURATION_S
    });
  }

  _updateShatterBursts(deltaSeconds) {
    if (this._shatterBursts.length === 0) return;

    for (let i = this._shatterBursts.length - 1; i >= 0; i--) {
      const burst = this._shatterBursts[i];
      burst.timeLeft -= deltaSeconds;

      if (burst.timeLeft <= 0) {
        for (const f of burst.frags) this.scene.remove(f.sprite);
        burst.material.dispose();
        this._shatterBursts.splice(i, 1);
        continue;
      }

      for (const f of burst.frags) {
        f.sprite.position.x += f.vx * deltaSeconds;
        f.sprite.position.y += f.vy * deltaSeconds;
        f.sprite.position.z += f.vz * deltaSeconds;
        f.vy -= SHATTER_FRAGMENT_GRAVITY * deltaSeconds;
      }

      burst.material.opacity = Math.max(0, burst.timeLeft / SHATTER_BURST_DURATION_S);
    }
  }
}