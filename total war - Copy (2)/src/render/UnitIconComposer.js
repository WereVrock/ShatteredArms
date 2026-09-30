// Builds the composite icon rendered on each army-bar card: a weapon as the
// main element, with optional supporting elements layered around it —
//   shield     behind the weapon (if the unit type carries one)
//   horse head to the right side (if the unit is cavalry)
//   skull      top-left corner (if the unit is undead)
//
// Layout is designed for a straight-on orthographic camera looking down -Z
// (see UnitThumbnailCapture). Every element is oriented so its best silhouette
// faces that camera:
//   weapons  rotated +90° around Y so they lie horizontal (they build along +Z)
//   shield   already faces ±Z after its internal rotation.x
//   horse    rotated +90° around Y so the muzzle points screen-right
//   skull    faces +Z natively (sockets on the +Z face)
//
// Depth ordering does the layering: the shield sits at Z=+0.2 (further from
// the camera than the weapon at Z=0), so the weapon occludes it where they
// overlap and the shield peeks out behind. No render-order overrides are used.
import * as THREE from 'three';
import { SoldierMeshFactory } from './SoldierMeshFactory.js';
import { WeaponViewFactory } from './WeaponViewFactory.js';
import { isCavalry } from '../config/UnitClasses.js';

// Longest dimension the weapon is scaled to fill. The camera frame is
// 2 * VIEW_HALF = 2.1 units wide (see UnitThumbnailCapture), so 1.2 puts the
// weapon at ~57% of the frame — legible, with room for the side/corner
// accents around it.
const WEAPON_TARGET_SIZE = 1.2;

const SHIELD_POSITION    = { x: -0.20, y:  0.15, z:  0.20 };
const SHIELD_SCALE       = 1.3;

const HORSE_HEAD_POSITION = { x:  0.75, y:  0.00, z:  0.10 };
const HORSE_HEAD_SCALE    = 0.6;

const SKULL_POSITION     = { x: -0.72, y:  0.72, z:  0.00 };
const SKULL_SCALE        = 0.8;

export class UnitIconComposer {
  // Returns a fresh THREE.Group containing the whole icon. Caller owns the
  // group and is responsible for adding it to a scene and disposing it.
  //
  // isUndead drives the skull accent. weaponType and hasShield/isCavalry
  // drive the rest — see the class comment for the field names this relies
  // on (they mirror what SoldierView already reads).
  static compose(unitTypeDef, isUndead) {
    const group = new THREE.Group();

    // Shield — behind the weapon, so add it first. Depth ordering (Z=+0.2
    // vs the weapon's ~Z=0) handles occlusion; add order is irrelevant.
    if (unitTypeDef.hasShield) {
      const shield = SoldierMeshFactory.createShield();
      group.add(this._centerAndPlace(
        shield,
        SHIELD_POSITION.x, SHIELD_POSITION.y, SHIELD_POSITION.z,
        SHIELD_SCALE
      ));
    }

    // Weapon — the main element, centered at origin, in front of the shield.
    const weapon = WeaponViewFactory.createForWeaponType(unitTypeDef.weaponType);
    this._orientWeapon(weapon);
    this._scaleWeaponToFit(weapon);
    group.add(weapon);

    // Horse head — right side, slightly behind the weapon so any overlap
    // reads as peeking from behind rather than cluttering the blade tip.
    if (isCavalry(unitTypeDef)) {
      const head = SoldierMeshFactory.createHorseHead();
      head.rotation.y = Math.PI / 2;
      group.add(this._centerAndPlace(
        head,
        HORSE_HEAD_POSITION.x, HORSE_HEAD_POSITION.y, HORSE_HEAD_POSITION.z,
        HORSE_HEAD_SCALE
      ));
    }

    // Skull — top-left corner. Does not overlap the weapon in the current
    // layout, so its depth is left at 0.
    if (isUndead) {
      const skull = SoldierMeshFactory.createSkull();
      group.add(this._centerAndPlace(
        skull,
        SKULL_POSITION.x, SKULL_POSITION.y, SKULL_POSITION.z,
        SKULL_SCALE
      ));
    }

    return group;
  }

  // Every weapon factory builds the weapon extending along +Z. Rotating the
  // group +90° around Y turns that into +X, so from the icon camera (looking
  // down -Z) the weapon lies horizontally across the frame.
  //
  // The bow is a special case that comes out right under the same rotation:
  // its limbs are already along Y and its belly at +Z, so after the turn the
  // belly faces +X — a bow in profile, strung toward the viewer.
  static _orientWeapon(weapon) {
    weapon.position.set(0, 0, 0);
    weapon.rotation.set(0, Math.PI / 2, 0);
  }

  // Uniformly scales the weapon so its longest dimension fits
  // WEAPON_TARGET_SIZE, then shifts it so its bounding-box centre sits at the
  // origin. Uses world-space AABBs (weapon has no parent at this point, so
  // world == local), computed twice — once before scaling to find the size,
  // once after to find the new centre.
  static _scaleWeaponToFit(weapon) {
    weapon.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(weapon);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    weapon.scale.setScalar(WEAPON_TARGET_SIZE / maxDim);
    weapon.updateMatrixWorld(true);

    const box2 = new THREE.Box3().setFromObject(weapon);
    const center = new THREE.Vector3();
    box2.getCenter(center);
    weapon.position.set(-center.x, -center.y, -center.z);
  }

  // Wraps `child` in a fresh group so the child is recentered at the
  // wrapper's origin, then positions and scales the wrapper.
  //
  // Centering uses the child's own bounding box, so the child's internal
  // offsets (the horse head's muzzle reaching forward, the skull's jaw
  // hanging low) do not shift where the accent lands. This is what lets the
  // accent sit exactly at its configured (x, y, z) regardless of how the
  // underlying mesh is built.
  static _centerAndPlace(child, x, y, z, scale) {
    const wrap = new THREE.Group();
    wrap.add(child);

    child.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(child);
    const center = new THREE.Vector3();
    box.getCenter(center);
    child.position.sub(center);

    wrap.position.set(x, y, z);
    wrap.scale.setScalar(scale);
    return wrap;
  }
}