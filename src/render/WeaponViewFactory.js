import { SoldierMeshFactory } from './SoldierMeshFactory.js';

// Picks the correct procedural weapon mesh for a unit's weaponType.
//
// `bodyVariant` is optional. When supplied, it selects a variant-appropriate
// mesh for weapon types that have one:
//   - sword:  goblins get a crude, shorter blade (SwordBuilder.createCrudeSword).
//   - spear:  goblins get darker wood and a flint tip (SpearBuilder.createGoblinSpear).
//   - bow:    goblins get a shorter, simpler shortbow (BowBuilder.createGoblinShortbow).
// Every other weapon type has no body-variant variant today.
//
// Callers that don't know the body variant (e.g. any tool that wants a
// neutral icon) can omit it and get the standard weapon.
export class WeaponViewFactory {
  static createForWeaponType(weaponType, bodyVariant) {
    if (weaponType === 'spear') {
      if (bodyVariant === 'goblin') return SoldierMeshFactory.createGoblinSpear();
      return SoldierMeshFactory.createSpear();
    }
    if (weaponType === 'bow') {
      if (bodyVariant === 'goblin') return SoldierMeshFactory.createGoblinShortbow();
      return SoldierMeshFactory.createBow();
    }
    if (weaponType === 'lance') return SoldierMeshFactory.createLance();
    if (weaponType === 'sword') {
      if (bodyVariant === 'goblin') return SoldierMeshFactory.createCrudeSword();
      return SoldierMeshFactory.createSword();
    }
    return SoldierMeshFactory.createSpear();
  }
}