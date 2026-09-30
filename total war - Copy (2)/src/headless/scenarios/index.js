// ===== index.js =====
// Aggregates every headless scenario into a single SCENARIOS array.
// One scenario per file — see the sibling files. Array order below is the
// display order and the number the user sees on the card.
import { numberScenarios } from './helpers.js';

// Core archetype sanity / baseline
import sanity from './sanity.js';
import baseline from './baseline.js';

// Cavalry behavior
import cavVsExposedArchers from './cavVsExposedArchers.js';
import cavVsSpearLine from './cavVsSpearLine.js';
import cavVsScreenedArchers from './cavVsScreenedArchers.js';
import cavVsScreenedArchersWide from './cavVsScreenedArchersWide.js';
import cavVsCav from './cavVsCav.js';
import twoCavVsScreened from './twoCavVsScreened.js';

// Infantry / weapon matchups
import lineClash from './lineClash.js';
import swordVsSpear from './swordVsSpear.js';
import shieldlessVsShielded from './shieldlessVsShielded.js';
import swordFlankVsSkeletonSpears from './swordFlankVsSkeletonSpears.js';

// Ranged / skirmisher
import archerDuel from './archerDuel.js';
import archerAdvanceNoEnemyCav from './archerAdvanceNoEnemyCav.js';
import archerHugEnemyCavSuperiority from './archerHugEnemyCavSuperiority.js';

// Movement / formation
import friendlyYieldColumn from './friendlyYieldColumn.js';
import stationaryBlockerMarchThrough from './stationaryBlockerMarchThrough.js';

// Morale / rout
import routPincerCollapse from './routPincerCollapse.js';

// Arrow ballistics
import arrowVolleyBasic from './arrowVolleyBasic.js';
import arrowSameUnitSkip from './arrowSameUnitSkip.js';
import arrowFriendlyFireCrossUnit from './arrowFriendlyFireCrossUnit.js';
import arrowShieldBlock from './arrowShieldBlock.js';
import arrowArcMidpath from './arrowArcMidpath.js';
import arrowDodgeStationary from './arrowDodgeStationary.js';
import arrowDodgeStrafing from './arrowDodgeStrafing.js';

// Arrow friendly-fire at target
import arrowFriendlyMidCorridor from './arrowFriendlyMidCorridor.js';
import arrowFriendlyAtTarget from './arrowFriendlyAtTarget.js';
import arrowFriendlyIntermingled from './arrowFriendlyIntermingled.js';

export const SCENARIOS = [
  sanity,
  baseline,

  cavVsExposedArchers,
  cavVsSpearLine,
  cavVsScreenedArchers,
  cavVsScreenedArchersWide,
  cavVsCav,
  twoCavVsScreened,

  lineClash,
  swordVsSpear,
  shieldlessVsShielded,
  swordFlankVsSkeletonSpears,

  archerDuel,
  archerAdvanceNoEnemyCav,
  archerHugEnemyCavSuperiority,

  friendlyYieldColumn,
  stationaryBlockerMarchThrough,

  routPincerCollapse,

  arrowVolleyBasic,
  arrowSameUnitSkip,
  arrowFriendlyFireCrossUnit,
  arrowShieldBlock,
  arrowArcMidpath,
  arrowDodgeStationary,
  arrowDodgeStrafing,

  arrowFriendlyMidCorridor,
  arrowFriendlyAtTarget,
  arrowFriendlyIntermingled
];

numberScenarios(SCENARIOS);