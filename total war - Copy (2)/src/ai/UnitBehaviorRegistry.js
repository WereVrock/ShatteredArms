// Maps a unit's unitTypeDef to the behavior that should drive it.
// New unit archetypes plug in here without touching TeamAI.
import { LineBehavior } from './behaviors/LineBehavior.js';
import { SkirmisherBehavior } from './behaviors/SkirmisherBehavior.js';
import { FlankerBehavior } from './behaviors/FlankerBehavior.js';
import { unitTypeOf } from './behaviorUtils.js';
import { isCavalry, isRanged } from '../config/UnitClasses.js';

const lineBehavior = new LineBehavior();
const skirmisherBehavior = new SkirmisherBehavior();
const flankerBehavior = new FlankerBehavior();

export class UnitBehaviorRegistry {
  static forUnit(unit) {
    const type = unitTypeOf(unit);
    if (!type) return null;
    if (isCavalry(type)) return flankerBehavior;
    if (isRanged(type)) return skirmisherBehavior;
    return lineBehavior;
  }
}