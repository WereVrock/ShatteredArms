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
    // The goblin family (goblin / goblinElite) shares the small-kit
    // weapon meshes. Elite is a cosmetic rank-up on the same frame, so
    // the same goblin spear / shortbow / crude sword apply.
    const isGoblinFamily = bodyVariant === 'goblin' || bodyVariant === 'goblinElite';
    if (weaponType === 'spear') {
      if (isGoblinFamily) return SoldierMeshFactory.createGoblinSpear();
      return SoldierMeshFactory.createSpear();
    }
    if (weaponType === 'bow') {
      if (isGoblinFamily) return SoldierMeshFactory.createGoblinShortbow();
      return SoldierMeshFactory.createBow();
    }
    if (weaponType === 'lance') return SoldierMeshFactory.createLance();
    if (weaponType === 'sword') {
      // The slave's club is a blunt visual on top of the crude sword's
      // mechanical stats: the sim treats it as a sword swing (the swing
      // animation lives in the sword-arm branch of SoldierModelComposer,
      // driven by unitTypeDef.weaponType === 'sword'), and only the
      // mesh differs. This is the exact pattern the crude goblin sword
      // uses — a visual variant on a shared combat type.
      if (bodyVariant === 'goblinSlave') return SoldierMeshFactory.createClub();
      if (isGoblinFamily) return SoldierMeshFactory.createCrudeSword();
      return SoldierMeshFactory.createSword();
    }
    return SoldierMeshFactory.createSpear();
  }
}