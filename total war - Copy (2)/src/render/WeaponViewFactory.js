import { SoldierMeshFactory } from './SoldierMeshFactory.js';

// Picks the correct procedural weapon mesh for a unit's weaponType.
export class WeaponViewFactory {
  static createForWeaponType(weaponType) {
    if (weaponType === 'spear') return SoldierMeshFactory.createSpear();
    if (weaponType === 'bow') return SoldierMeshFactory.createBow();
    if (weaponType === 'lance') return SoldierMeshFactory.createLance();
    if (weaponType === 'sword') return SoldierMeshFactory.createSword();
    return SoldierMeshFactory.createSpear();
  }
}