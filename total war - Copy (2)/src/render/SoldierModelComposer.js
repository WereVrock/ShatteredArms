// Builds the visible, stateless parts of one soldier model: body (with the
// helmet baked in by SoldierMeshFactory), mount if cavalry, shield if the
// unit type carries one, and weapon. No per-soldier wiring — no selection
// ring, no routing flag, no click proxy, no unit-id tag. Those belong to
// SoldierView, which owns the live instance.
//
// Extracted so that UnitThumbnailCapture can build the exact same model
// shape for its one-off render without duplicating the composition order
// (rider raised on cavalry, shield parented to the rider, weapon rotation
// order set to YXZ). If the live soldier model changes, the thumbnail
// changes with it automatically.
import * as THREE from 'three';
import { SoldierMeshFactory } from './SoldierMeshFactory.js';
import { WeaponViewFactory } from './WeaponViewFactory.js';
import { getTeamColor } from './TeamColors.js';
import { isCavalry } from '../config/UnitClasses.js';

// Shoulder position for the sword arm, in body-local space. Blob and
// skeleton shoulder heights both land near Y 0.85, and the shoulder sits
// just inside the torso's widest point. The sword's factory rest position
// (0.22, 0.65, 0) becomes a (0.07, -0.20, 0) offset from this point — arm
// length ~0.21, hand at roughly hip/waist height.
const SWORD_SHOULDER_X = 0.15;
const SWORD_SHOULDER_Y = 0.85;
const SWORD_SHOULDER_Z = 0;

export class SoldierModelComposer {
  // Returns { group, rider, body, shield, weapon, weaponArm, horseBase }.
  // shield, weaponArm, and horseBase are null when the unit type does not
  // use them. The caller owns the returned group and is responsible for
  // adding it to a scene and disposing it when done.
  static compose(unitTypeDef, teamId, bodyVariant) {
    const group = new THREE.Group();
    const rider = new THREE.Group();
    group.add(rider);

    const color = getTeamColor(teamId);

    const body = bodyVariant === 'skeleton'
      ? SoldierMeshFactory.createSkeletonBody(color, color)
      : SoldierMeshFactory.createBlobBody(color, unitTypeDef.helmetType);
    rider.add(body);

    let horseBase = null;
    if (isCavalry(unitTypeDef)) {
      // Skeleton riders get the skeleton mount; blob riders get the flesh
      // mount. Both builders produce the exact same footprint, scale, and
      // userData contract (horseLegs, riderMountHeight), so nothing
      // downstream needs to know which one was picked.
      horseBase = bodyVariant === 'skeleton'
        ? SoldierMeshFactory.createSkeletonHorseBase()
        : SoldierMeshFactory.createHorseBase();
      // Mount lives on the group, not the rider — the rider is raised above
      // it and the mount keeps its own ground-level transform.
      group.add(horseBase);
      rider.position.y = horseBase.userData.riderMountHeight ?? 0;
    } else {
      rider.position.y = 0;
    }

    let shield = null;
    if (unitTypeDef.hasShield) {
      shield = SoldierMeshFactory.createShield();
      rider.add(shield);
    }

    const weapon = WeaponViewFactory.createForWeaponType(unitTypeDef.weaponType);
    // 'YXZ' order lets yaw (facing) and pitch (aim) compose cleanly — see
    // SoldierView for the full explanation. Set here so both the live model
    // and the thumbnail render agree by construction.
    weapon.rotation.order = 'YXZ';

    // Swords are held by an invisible arm: the swing must pivot from the
    // shoulder, not from the hilt. The arm group sits at the shoulder
    // position and the sword keeps its factory offset as a child of it, so
    // the hand+blade move as a rigid assembly when the arm rotates. The arm
    // is parented under BODY (not rider) so the body's yaw — including the
    // attack twist SoldierView applies — carries the arm and blade with it.
    // Other weapons have no arm; they parent directly to the rider and pick
    // up facing via their own rotation.y as before.
    let weaponArm = null;
    if (unitTypeDef.weaponType === 'sword') {
      weaponArm = new THREE.Group();
      weaponArm.position.set(SWORD_SHOULDER_X, SWORD_SHOULDER_Y, SWORD_SHOULDER_Z);
      weapon.position.sub(weaponArm.position);
      weaponArm.add(weapon);
      body.add(weaponArm);
    } else {
      rider.add(weapon);
    }

    // Every visible mesh in the composed soldier casts a shadow. The sun's
    // shadow map picks these up automatically; the caller only needs a
    // renderer with shadowMap enabled and a shadow-casting light in the
    // scene (SceneSetup provides both). The pick proxy and selection ring
    // are added by SoldierView AFTER this call, so they are not affected —
    // the proxy's material is invisible anyway, and the ring is a ground
    // decal.
    group.traverse((obj) => {
      if (obj.isMesh) obj.castShadow = true;
    });

    return { group, rider, body, shield, weapon, weaponArm, horseBase };
  }
}