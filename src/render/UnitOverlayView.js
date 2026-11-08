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
import { SettingsStore } from '../ui/settings/SettingsStore.js';
import { TeamColors } from './TeamColors.js';
import {
  ShieldBillboard,
  bannerSizeMultiplier
} from './ShieldBillboard.js';
import {
  SHIELD_PIECE_COUNT
} from './ShieldIconBuilder.js';

// Fixed world Y of the shield's BOTTOM edge. The billboard's sprite is
// positioned so the shield's bottom edge sits here; distance scale and
// banner-size multiplier both grow the banner UP from this anchor. Set
// to 2.0 to clear the ~1.7-tall soldier heads at any zoom or size.
const SHIELD_BOTTOM_Y = 2.0;

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

    this.scene.add(group);

    return {
      group,
      billboard,
      shieldPieces,
      teamColorHex,
      wasCollapsed: false,
      wasShattered: false,
      flagShattered: false,
      // Wall-clock timestamp (ms) of the current pulse's rising edge.
      flashStartMs: null
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
    entry.group.position.set(anchorX, 0, anchorZ);

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
      const shieldCenterY = SHIELD_BOTTOM_Y + entry.billboard.getShieldCenterOffset();
      const cam = camera.position;
      const dx = anchorX - cam.x;
      const dy = shieldCenterY - cam.y;
      const dz = anchorZ - cam.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      entry.billboard.setWorldScale(distance);
      entry.billboard.sprite.position.y =
        SHIELD_BOTTOM_Y + entry.billboard.getAnchorOffset();
    }

    // --- collapse / shatter detection -------------------------------------
    const isCollapsed = fightingCount === 0;
    const isShattered = shatteredCount === alive.length;

    if (isCollapsed && !entry.wasCollapsed) entry.flashStartMs = nowMs;
    if (isShattered && !entry.wasShattered) {
      if (unit.teamId === this.playerTeamId && !entry.flagShattered) {
        entry.flagShattered = true;
        const burstY = entry.billboard
          ? SHIELD_BOTTOM_Y + entry.billboard.getShieldCenterOffset()
          : SHIELD_BOTTOM_Y + 0.9;
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