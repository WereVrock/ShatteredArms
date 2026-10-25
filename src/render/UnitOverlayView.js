// ===== src/render/UnitOverlayView.js =====
// ===== src/render/UnitOverlayView.js =====
// World-space overlays drawn during battle:
//
//   Shield billboard — ONE THREE.Sprite per unit, carrying the unit's
//     entire marker on a single canvas: HP / morale / stamina bars on
//     top, a team-coloured heater shield below (see ShieldBillboard.js).
//     Because it is one sprite the whole thing billboards as a single
//     unit — bars and shield stay rigidly aligned from any camera angle.
//
//     The shield's face shows the SAME composite unit icon the army bar
//     draws (see UnitIcon.js), so the world marker and the army-bar card
//     can never disagree about what a unit looks like.
//
//     The shield is split into SHIELD_PIECE_COUNT horizontal bands (see
//     ShieldIconBuilder.js). As the unit's total current HP / total max
//     HP drops, bands break off from the bottom up — the pointed base
//     shatters first, the crest last. Each breaking piece is handed to
//     a transient falling sprite that drops, spins and fades on the sim
//     delta, so a paused battle freezes any in-flight shard mid-air.
//
//   Bars — drawn inside the billboard's canvas, ABOVE the shield. Only
//     shown for PLAYER-TEAM units; enemy bars are deliberately NOT shown
//     (reading the enemy's internal morale is information the player
//     should have to infer from behaviour, not read off a bar).
//
// Both are gated by SettingsStore (showUnitFlags / showUnitBars, both
// default true). update() reads the settings fresh every call, so a flip
// in the settings panel takes effect on the very next render frame.
//
// ANCHORING
// The overlay is positioned above the unit's STILL-FIGHTING soldiers —
// the alive subset that is neither routing nor shattered — not above the
// whole living formation. A unit that has lost a few soldiers to a rout
// but is still holding keeps its marker over the men who are still in
// the line; the runners do not drag it off with them. When every living
// soldier is out the fighting subset is empty and the anchor falls back
// to the full alive centroid.
//
// STATE-CHANGE EFFECTS
//   FULL COLLAPSE — the entire billboard FADES in and out on a fixed
//     period while EVERY living soldier on the unit is routing or
//     shattered. Partial routs do NOT fade; the marker just re-anchors
//     to the still-fighting subset. The fade resets to its dim half on
//     the rising edge, so the first thing the player sees is the marker
//     dimming, and it keeps pulsing for as long as the collapse holds.
//
//   Shattered additionally triggers a one-shot burst of team-coloured
//     fragment sprites, and — for a PLAYER-TEAM unit only — destroys
//     the marker for the rest of the battle. Enemy shatters pulse but
//     keep their markers.
//
// PAUSE BEHAVIOUR
// The collapse pulse runs on WALL-CLOCK time (performance.now()), not on
// the sim delta, so it keeps animating while the sim is paused. The
// shield-piece fall and the shatter-burst fragments run on the sim delta
// and freeze with the battle — they are physical effects in world space,
// not UI alarms.
import * as THREE from 'three';
import { SettingsStore } from '../ui/settings/SettingsStore.js';
import { TeamColors } from './TeamColors.js';
import {
  ShieldBillboard,
  SPRITE_WORLD_W,
  SPRITE_LOCAL_Y_OFFSET
} from './ShieldBillboard.js';
import {
  SHIELD_PIECE_COUNT
} from './ShieldIconBuilder.js';

// World Y of the SHIELD's own centre. Bars sit above it in the billboard
// canvas, so their effective world Ys are derived by the canvas layout
// (see ShieldBillboard.js) — this constant is the anchor.
const SHIELD_Y = 2.4;

// Render order within the transparent pass. Billboard draws on top of the
// ground decals and under any UI overlay sprites.
const RENDER_ORDER_BILLBOARD = 3;

// Morale band thresholds, matching ArmyBarView and UnitInfoPanel.
const BAND_FULL_MIN = 0.6;
const BAND_HURT_MIN = 0.3;

// Collapse pulse.
const FLASH_PULSE_PERIOD_S = 0.6;
const FLASH_DIM_OPACITY = 0.30;

// Shield-piece fall. One piece is released when the unit's HP crosses its
// threshold; it drops + spins + fades over this duration, on the sim
// delta so a paused battle freezes it in mid-air.
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
    // every other piece — collected here so dispose() can clean up any
    // still in flight.
    this._fallingPieceMaterials = new Set();

    // Active shatter bursts. Each is { material, frags, timeLeft }.
    this._shatterBursts = [];
  }

  // Which team's units get bars inside their billboard. Shields show for
  // every team regardless.
  setPlayerTeamId(teamId) {
    this.playerTeamId = teamId;
  }

  update(unitsById, deltaSeconds) {
    const settings = SettingsStore.get();
    const showShields = settings.showUnitFlags !== false;
    const showBars = settings.showUnitBars !== false;
    const showAnything = showShields || showBars;

    // Wall-clock timestamp for the collapse pulse — see the PAUSE
    // BEHAVIOUR note at the top of the file.
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

      let entry = this._entriesByUnitId.get(unitId);
      if (!entry) {
        entry = this._createEntry(unit);
        this._entriesByUnitId.set(unitId, entry);
      }

      this._updateEntry(
        entry, unit, alive, showShields, showBars, nowMs, deltaSeconds
      );
    }

    // Defensive: hide any entry whose unit is no longer in the map.
    for (const [unitId, entry] of this._entriesByUnitId) {
      if (!seen.has(unitId)) entry.group.visible = false;
    }
  }

  dispose() {
    for (const entry of this._entriesByUnitId.values()) {
      this.scene.remove(entry.group);
      if (entry.billboard) entry.billboard.dispose();
      // Detach any still-falling piece sprites (they live as children of
      // the group, but the sprite itself was removed on completion —
      // here we just make sure anything mid-flight is cleaned up).
      for (const piece of entry.shieldPieces) {
        if (piece.sprite && piece.sprite.parent) {
          piece.sprite.parent.remove(piece.sprite);
        }
      }
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

  // --- internals ---------------------------------------------------------

  _createEntry(unit) {
    const group = new THREE.Group();

    const lead = unit.soldiers && unit.soldiers[0];
    const typeDef = lead ? lead.unitTypeDef : null;

    const teamColorHex = TeamColors[unit.teamId] ?? 0xaaaaaa;

    // --- The combined billboard (bars + shield, one sprite) ---
    // Its local Y is offset by SPRITE_LOCAL_Y_OFFSET so the SHIELD's own
    // centre (not the sprite's canvas centre) lands at SHIELD_Y. The
    // bars then sit above that by their canvas layout.
    let billboard = null;
    if (typeDef) {
      // A unit is a "thrall unit" when its lead soldier carries the
      // isThrall flag. Thralls get a blood-drop icon on their shield
      // instead of the unit type's SVG icon. See ShieldIconBuilder.
      const isThrallUnit = lead && lead.isThrall === true;
      billboard = new ShieldBillboard(
        typeDef, unit.isUndead, unit.teamId, isThrallUnit
      );
      billboard.sprite.position.set(
        0,
        SHIELD_Y + SPRITE_LOCAL_Y_OFFSET,
        0
      );
      billboard.sprite.renderOrder = RENDER_ORDER_BILLBOARD;
      group.add(billboard.sprite);
    }

    // Per-piece break bookkeeping. Piece 0 is the shield's TOP band; the
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
        // Per-chunk HP break threshold, derived from the chunk's area
        // and its distance from the shield's centre (see
        // ShieldIconBuilder). Read below when deciding which chunks to
        // break at the unit's current HP.
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
      // Null when not pulsing.
      flashStartMs: null
    };
  }

  _updateEntry(entry, unit, alive, showShields, showBars, nowMs, deltaSeconds) {
    entry.group.visible = true;

    // --- anchoring --------------------------------------------------------
    // Split the alive list into the STILL-FIGHTING subset (neither
    // routing nor shattered) and the rest. The marker anchors to the
    // fighting subset so a few runners do not drag it away.
    let fightingCount = 0;
    let shatteredCount = 0;
    let fx = 0, fz = 0;   // fighting centroid accumulator
    let ax = 0, az = 0;   // full-alive centroid accumulator

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

    // --- collapse / shatter detection -------------------------------------
    const isCollapsed = fightingCount === 0;
    const isShattered = shatteredCount === alive.length;

    if (isCollapsed && !entry.wasCollapsed) entry.flashStartMs = nowMs;
    if (isShattered && !entry.wasShattered) {
      if (unit.teamId === this.playerTeamId && !entry.flagShattered) {
        entry.flagShattered = true;
        this._spawnShatterBurst(anchorX, SHIELD_Y, anchorZ, entry.teamColorHex);
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

    // Total current HP / total max HP across the whole unit. Dead
    // soldiers contribute 0 to the numerator but full maxHp to the
    // denominator, so losing men reads as losing shield integrity even
    // at full per-soldier health.
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
    // freezes shards in mid-air.
    for (const piece of entry.shieldPieces) {
      if (!piece.falling) continue;
      piece.fallTime += deltaSeconds;
      const t = Math.min(1, piece.fallTime / PIECE_FALL_DURATION_S);

      // Quadratic drop so a shard accelerates as it falls.
      const drop = t * t * PIECE_FALL_DROP;
      piece.sprite.position.set(
        piece.fallDriftX * t,
        SHIELD_Y - drop,
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

    // Hide the entire billboard when the shield overlay is off, or when
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
        // Enemy units and shattered units have barsVisible === false,
        // so the billboard renders as a shield-only marker for them.
        showBars: barsVisible
      });
    }
  }

  // Spawns the transient falling sprite for a piece that just broke. The
  // sprite uses the SHARED piece texture (which is CANVAS-sized and
  // carries the piece's content at the correct y-offset), so starting
  // the sprite at SHIELD_Y puts the piece's visible content exactly
  // where it was on the shield, before the fall animation begins.
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

    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(SPRITE_WORLD_W, SPRITE_WORLD_W, 1);
    sprite.position.set(0, SHIELD_Y, 0);
    sprite.renderOrder = RENDER_ORDER_BILLBOARD;

    entry.group.add(sprite);
    piece.sprite = sprite;
    piece.material = mat;
  }

  // --- shatter burst --------------------------------------------------------

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