import { SoldierMeshFactory } from './SoldierMeshFactory.js';

// Picks the correct procedural shield mesh for a unit's body variant.
//
// Goblins get a small round crude shield; every other body variant gets
// the larger banner shield. The variant parameter is exactly the value
// Soldier.bodyVariant holds ('blob', 'skeleton', or 'goblin'), so the
// composer can pass it straight through.
//
// Mirrors WeaponViewFactory: a tiny picker class, so the composer stays
// free of branch-on-variant code and adding a new shield design later
// is one new entry here plus one new builder in ShieldBuilder.js.
export class ShieldViewFactory {
  // teamColorHex is the team's display colour (TeamColors[teamId]), used
  // only by shields whose face carries team-coloured heraldry — today,
  // the Warlord shield's crest. Optional: the icon path omits it and
  // the Warlord shield's builder falls back to a neutral crest colour.
  static createForBodyVariant(bodyVariant, teamColorHex) {
    if (bodyVariant === 'goblin') return SoldierMeshFactory.createGoblinShield();
    if (bodyVariant === 'hobgoblin') return SoldierMeshFactory.createHobgoblinShield();
    if (bodyVariant === 'goblinWarlord') {
      return SoldierMeshFactory.createWarlordShield(teamColorHex);
    }
    return SoldierMeshFactory.createShield();
  }
}