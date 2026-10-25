// ===== CampaignBattleBuilder.js =====
import { UnitFamilies } from './UnitFamilies.js';
import { CampaignConfig } from './CampaignConfig.js';
import { isRanged } from '../config/UnitClasses.js';
import { unitXpProgress } from './UnitXp.js';
import { championXpProgress } from './ChampionSkills.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { raceOf } from '../config/RaceConfig.js';
import { computeUnitPrice } from './UnitPreview.js';
import { layoutRoster } from '../scenarios/RosterLayout.js';

// Builds a scenario object for main.js's startScenario from a campaign state,
// plus the AI roster generator used when a battle begins. The scenario's
// build() places the player roster and the current AI roster on the field.
//
// Formation layout itself lives in src/scenarios/RosterLayout.js — shared
// with CustomBattleBuilder.

const FACE_SOUTH = 0;
const FACE_NORTH = Math.PI;

export function buildCampaignScenario(state) {
  const diffCfg = state.difficulty
    ? CampaignConfig.difficulties[state.difficulty]
    : null;
  return {
    id: `campaign-battle-${state.battleIndex}`,
    name: `Campaign — Battle ${state.battleIndex + 1}`,
    description: '',
    playerTeamId: 'blue',
    aiTeamIds: ['red'],
    // Campaign AI never adopts wholesale 'retreat' posture — it holds and
    // fights at full effort regardless of being outnumbered (see
    // BattleAssessment / TeamAI docs). Without this, a campaign battle that
    // opens with the AI at a numerical disadvantage collapses into a rout
    // before any real fight happens, which plays badly and reads as a bug.
    valiantDefenceTeamIds: ['red'],
    // Difficulty-driven AI tier. Read by main.js's BattleAI construction
    // when it passes scenario fields through as BattleAI options; when it
    // does not, CampaignFlow._beginBattle already calls
    // AITierPreference.set(...) before starting the battle, so the tier
    // is picked up either way.
    tierName: diffCfg ? diffCfg.aiTierName : undefined,
    cameraTarget: { x: 0, z: 0 },
    cameraDistance: 44,
    cameraPitch: 0.95,
    build() {
      return buildUnits(state);
    }
  };
}

// Enemy gold budget for a given battle index. Reads the active
// difficulty's own handcrafted schedule (see
// CampaignConfig.difficulties[id].enemyGoldSchedule), which diverges from
// the base schedule from battle 2 onward. Past the end of that schedule,
// the budget grows linearly by (enemyGoldGrowthPerBattle + the
// difficulty's enemyGoldGrowthDelta) from the schedule's last value, so
// each difficulty's overflow continues from its OWN battle-5 figure.
//
// Fallback: when no difficulty is given, or the difficulty entry lacks a
// schedule, the base CampaignConfig.enemyGoldSchedule is used, so the
// function always returns a sane value regardless of caller error.
function goldForBattle(battleIndex, difficulty) {
  const diffCfg = difficulty ? CampaignConfig.difficulties[difficulty] : null;
  const schedule = (diffCfg && diffCfg.enemyGoldSchedule)
    || CampaignConfig.enemyGoldSchedule;
  const delta = (diffCfg && diffCfg.enemyGoldGrowthDelta) || 0;
  const growth = CampaignConfig.enemyGoldGrowthPerBattle + delta;

  if (battleIndex < schedule.length) return schedule[battleIndex];
  const overflow = battleIndex - schedule.length + 1;
  return schedule[schedule.length - 1] + overflow * growth;
}

// Fixed first-battle roster for every difficulty. Returns an array of AI
// entries matching the difficulty's declared firstBattleComposition, or
// null when the difficulty does not declare one — in which case the caller
// falls through to the standard gold-budgeted generator. Today no preset
// takes that null path; the guard exists so a future difficulty can opt
// out without code changes.
//
// Composition is drawn pool-by-pool: `human: 2` draws 2 random types from
// UnitFamilies.allTypeIds() (the 5 human variants), `goblin: 1` draws 1
// random type from UnitFamilies.goblinTypeIds() (the 5 goblin variants).
// Entry ids are assigned after each push, so the roster is always
// ai-0-0 .. ai-0-(n-1) regardless of how many units each pool contributed.
//
// Then firstBattleGoldBonus (0 on easy and normal, 120 on hard) is spent
// on additional units drawn from the full campaign pool (human + goblin,
// shielded + unshielded), using the same per-roll affordability test as
// the standard generator. A positive bonus therefore makes hard a strict
// superset of normal's opener — same 2+1 core, plus whatever 120 gold buys
// on top.
//
// Sized against CampaignConfig.defaultSizes, so a goblin unit fields its
// doubled soldier count (30 vs 15) automatically. isUndead is false on
// every entry: the difficulty design does not call for skeleton-bodied AI
// in the opening battle, and keeping it off makes the flavours visually
// distinct.
//
// This helper is only ever reached when battleIndex === 0 and there are no
// carried-over survivors (see generateAIRoster). Nothing here touches
// enemyGoldSchedule or enemyGoldGrowthDelta, so later battles are wholly
// unaffected by a difficulty's first-battle composition.
function buildFirstBattleRoster(difficulty) {
  const diffCfg = difficulty ? CampaignConfig.difficulties[difficulty] : null;
  if (!diffCfg || !diffCfg.firstBattleComposition) return null;

  const comp = diffCfg.firstBattleComposition;
  const entries = [];

  const appendFromPool = (pool, count) => {
    if (!Array.isArray(pool) || pool.length === 0) return;
    for (let i = 0; i < count; i++) {
      const typeId = pool[Math.floor(Math.random() * pool.length)];
      const size = CampaignConfig.defaultSizes[typeId];
      if (size == null) continue;
      entries.push({
        id: `ai-0-${entries.length}`,
        typeId,
        aliveCount: size,
        maxCount: size,
        isUndead: false
      });
    }
  };

  appendFromPool(UnitFamilies.allTypeIds(), comp.human || 0);
  appendFromPool(UnitFamilies.goblinTypeIds(), comp.goblin || 0);

  let bonus = diffCfg.firstBattleGoldBonus || 0;
  if (bonus <= 0) return entries;

  const bonusPool = UnitFamilies.campaignPoolTypeIds();

  const MAX_EXTRA_UNITS = 20;
  const MAX_CONSECUTIVE_FAILURES = 24;
  let consecutiveFailures = 0;

  while (bonus > 0
         && entries.length < 3 + MAX_EXTRA_UNITS
         && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
    const typeId = bonusPool[Math.floor(Math.random() * bonusPool.length)];
    const size = CampaignConfig.defaultSizes[typeId];
    const typeDef = UnitTypes[typeId];
    if (size == null || !typeDef) {
      consecutiveFailures++;
      continue;
    }

    const price = computeUnitPrice({
      typeDef,
      isUndead: false,
      aliveCount: size
    });
    if (price > bonus) {
      consecutiveFailures++;
      continue;
    }

    bonus -= price;
    entries.push({
      id: `ai-0-${entries.length}`,
      typeId,
      aliveCount: size,
      maxCount: size,
      isUndead: false
    });
    consecutiveFailures = 0;
  }

  return entries;
}

// Fresh AI roster for the given battle index. Starts from `survivors`
// (AI units that carried over from the previous battle — see
// processAISurvivors) at NO gold cost, then spends this battle's gold
// budget on new random units until the budget runs out.
//
// On battle 0 with no survivors, every difficulty substitutes a fixed
// composition (see CampaignConfig.difficulties[id].firstBattleComposition)
// for the gold-budgeted draw; see buildFirstBattleRoster. A difficulty
// that also declares firstBattleGoldBonus spends that gold on extra units
// on top of the fixed composition, so a harder tier's opener is a strict
// superset of a softer tier's. Every subsequent battle on every difficulty
// uses the standard generator below, which is entirely unaffected by these
// fields.
//
// The loop bails out after a run of consecutive unaffordable rolls —
// with the schedule-driven budgets the leftover gold after a bad run is
// small anyway, and this keeps the generator from spinning on an
// expensive pool.
//
// Survivor ids are preserved. New units get ids of the form
// `ai-{battleIndex}-{n}` starting from n = survivors.length, so a fresh
// unit can never collide with a survivor or another fresh unit.
export function generateAIRoster(battleIndex, survivors = [], difficulty = 'normal') {
  const entries = (survivors || []).map(s => ({ ...s }));

  // First-battle special. Only fires when there are genuinely no
  // survivors — an AI roster that survived into a replay of index 0
  // (shouldn't happen, but possible with a hand-edited save) keeps its
  // units rather than being silently replaced.
  if (battleIndex === 0 && entries.length === 0) {
    const fixed = buildFirstBattleRoster(difficulty);
    if (fixed) return fixed;
  }

  let gold = goldForBattle(battleIndex, difficulty);

  const MAX_UNITS = 50;
  const MAX_CONSECUTIVE_FAILURES = 24;
  let consecutiveFailures = 0;
  let i = entries.length;

  while (entries.length < MAX_UNITS
         && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
    const offer = UnitFamilies.randomOffer({
      skeletonChance: CampaignConfig.aiUndeadChance
    });
    const typeDef = UnitTypes[offer.typeId];
    const size = CampaignConfig.defaultSizes[offer.typeId];

    if (!typeDef || size == null) {
      consecutiveFailures++;
      continue;
    }

    const price = computeUnitPrice({
      typeDef,
      isUndead: offer.isUndead,
      aliveCount: size
    });

    if (price > gold) {
      consecutiveFailures++;
      continue;
    }

    gold -= price;
    entries.push({
      id: `ai-${battleIndex}-${i++}`,
      typeId: offer.typeId,
      aliveCount: size,
      maxCount: size,
      isUndead: offer.isUndead
    });
    consecutiveFailures = 0;
  }

  return entries;
}

// Folds the outcome of a battle into the AI's persistent roster. Reads
// each AI unit's on-field alive count from the finished simulation, plus
// its routing (escaped) soldiers from the extraction record, and applies
// the survival rules:
//
//   1. On-field alive soldiers always carry over.
//   2. Each routing (escaped) soldier has a 50% chance to be recorded as
//      a survivor. Recorded escapees rejoin their unit. Unrecorded
//      escapees are lost — same mechanic as the player's all-return rule,
//      but per-soldier and probabilistic.
//   3. Any unit whose resulting size is below 20% of its maxCount is
//      dropped. A shattered remnant does not come back next battle.
//
// Units that survive join the next battle for free. Their gold cost was
// already paid when they were originally recruited; survivors do NOT
// count against the next battle's budget.
//
// `aiRoster` is the roster that was used for the just-finished battle.
// `simulation` is the finished BattleSimulation. Returns a new array.
export function processAISurvivors(aiRoster, simulation) {
  if (!aiRoster || aiRoster.length === 0) return [];

  const aliveByUnitId = new Map();
  for (const unit of simulation.units) {
    if (unit.teamId !== 'red') continue;
    aliveByUnitId.set(unit.id, unit.getAliveSoldiers().length);
  }

  const extractedByUnit = new Map();
  const extractions = simulation.extractionSystem
    ? simulation.extractionSystem.getExtractions()
    : [];
  for (const ex of extractions) {
    if (!ex || ex.teamId !== 'red') continue;
    if (typeof ex.unitId === 'undefined') continue;
    if (typeof ex.escapedCount !== 'number' || ex.escapedCount <= 0) continue;
    extractedByUnit.set(ex.unitId, ex.escapedCount);
  }

  const survivors = [];
  for (const entry of aiRoster) {
    const aliveCount = aliveByUnitId.get(entry.id) || 0;
    const escaped = extractedByUnit.get(entry.id) || 0;

    // Per-soldier recording roll for routing escapees.
    let recordedEscaped = 0;
    for (let i = 0; i < escaped; i++) {
      if (Math.random() < 0.5) recordedEscaped++;
    }

    const count = aliveCount + recordedEscaped;
    if (count / entry.maxCount < 0.2) continue;

    survivors.push({
      id: entry.id,
      typeId: entry.typeId,
      isUndead: entry.isUndead,
      aliveCount: count,
      maxCount: entry.maxCount
    });
  }

  return survivors;
}

function buildUnits(state) {
  const units = [];
  const playerRoster = state.roster.filter(e => e.aliveCount > 0);
  const aiRoster = state.aiRoster;

  const playerUnits = layoutRoster(
    playerRoster, 'blue', CampaignConfig.playerBaseZ, FACE_SOUTH
  );
  units.push(...playerUnits);

  // Unit-level bonuses first. Each player unit whose roster entry is
  // above level 1 gets its level-derived bonuses applied across every
  // soldier. This runs BEFORE the champion override so the champion's
  // own morale=200 setter stays authoritative — a levelled retinue
  // gives its guards extra morale but never pushes the champion past
  // their fixed ceiling.
  applyPlayerUnitLevels(playerUnits, playerRoster);

  // Annotate every player unit with display-ready progression data.
  // The panel reads three plain fields rather than re-deriving level
  // or XP from the roster — one place builds the view model, one place
  // consumes it.
  annotateUnitProgression(playerUnits, playerRoster);

  // Champion injection. layoutRoster produced a unit for the champion's
  // retinue entry like any other; post-process that unit to mark one
  // soldier as the champion, one as bodyguards, and apply the champion's
  // skill mods. Falls through silently if the champion entry is missing
  // (e.g. a save written before the champion feature).
  if (state.champion) {
    const championEntry = playerRoster.find(e => e.hasChampion);
    if (championEntry) {
      const champUnit = playerUnits.find(u => u.id === championEntry.id);
      if (champUnit) applyChampionToUnit(champUnit, state.champion);
    }
  }

  units.push(...layoutRoster(aiRoster, 'red', CampaignConfig.aiBaseZ, FACE_NORTH));

  return units;
}

// Applies each player unit's current level to every soldier of that unit.
// Safe no-op for level-1 units. Reads the level from the matching roster
// entry by id — layoutRoster preserves entry ids as unit ids, so the
// match is a straight Map lookup.
//
// Damage, HP, and mass are NOT scaled by level. Only the two bonuses the
// design specifies: +10 max morale per level (melee), and 0.9× scatter
// per level (ranged). Keeping the effect list narrow makes tuning simple
// and avoids a second power curve to balance against.
function applyPlayerUnitLevels(playerUnits, playerRoster) {
  const levelById = new Map();
  for (const entry of playerRoster) {
    if (entry.level && entry.level > 1) levelById.set(entry.id, entry.level);
  }
  if (levelById.size === 0) return;

  for (const unit of playerUnits) {
    const level = levelById.get(unit.id);
    if (!level) continue;
    const typeDef = unit.soldiers[0]?.unitTypeDef;
    if (!typeDef) continue;
    const ranged = isRanged(typeDef);
    const bonus = level - 1;

    for (const s of unit.soldiers) {
      if (ranged) {
        // Scatter radius shrinks per level: a level 3 archer's arrows
        // land inside a 0.81× disc.
        s.rangedAccuracyMult = Math.pow(0.9, bonus);
      } else {
        // Melee: flat +10 max morale per level. Applied after the race
        // morale multiplier in Soldier's constructor (so it is +10 to
        // the post-multiplier value, not +10 × moraleMult), giving
        // goblins and humans the same absolute benefit.
        const add = 10 * bonus;
        s.maxMorale += add;
        s.baseMaxMorale += add;
        s.morale += add;
      }
    }
  }
}

// Copies the roster entry's level and XP onto the live unit in a
// display-ready form. Called once per battle, at build time, so the
// values reflect the state the unit entered the battle with — XP earned
// during the battle is only folded back into the roster entry at
// battle end (see CampaignFlow._awardRosterUnitXp).
//
// Non-campaign units (AI rosters, standalone scenarios, custom battles)
// never go through this function and therefore have no unitLevel field.
// UnitInfoPanel guards on that absence.
function annotateUnitProgression(playerUnits, playerRoster) {
  const entryById = new Map();
  for (const e of playerRoster) entryById.set(e.id, e);

  for (const unit of playerUnits) {
    const entry = entryById.get(unit.id);
    if (!entry) continue;
    unit.unitLevel = entry.level || 1;
    const prog = unitXpProgress(entry.level || 1, entry.xp || 0);
    unit.unitXpFrac = prog.frac;
    unit.unitXpText = prog.text;
  }
}

// Post-processes the retinue unit laid out by layoutRoster: soldiers[0]
// becomes the champion (elevated HP, skill-derived combat mods), and
// soldiers[1..] become bodyguards (Retinue-tree mods, a back-reference to
// the champion soldier).
//
// The champion's own maxHp is derived at battle-build time rather than
// baked into UnitTypes, so a champion's HP scales with their unlocked
// skills and current level without a per-champion type clone.
//
// IMPORTANT: this assumes soldiers[0] is the champion. That is a
// deliberate convention — the layout preserves soldier order, and the
// roster entry does not track which specific soldier survived (only the
// count). Designating soldiers[0] each battle means the champion has full
// HP at the start of every battle regardless of which physical body it
// "was" before. Consistent with how the campaign already heals surviving
// units between battles.
function applyChampionToUnit(unit, champion) {
  const soldiers = unit.soldiers;
  if (soldiers.length === 0) return;

  const championDef = champion.def;
  const combatMods = champion.combatMods || {};
  const bodyguardMods = champion.bodyguardMods || {};

  // --- Champion soldier ---
  const champSoldier = soldiers[0];
  // setChampion(true) also re-resolves the render body variant: when the
  // unit type declares championBodyVariant (the retinue does, see
  // UnitTypes.js), the champion renders with that distinct model rather
  // than the hobgoblin rank-and-file body. Do NOT assign bodyVariant
  // directly here — that would bypass _resolveBodyVariant and silently
  // defeat the whole override system, and any future championBodyVariant
  // change would need to be mirrored in two places.
  champSoldier.setChampion(true);
  champSoldier.combatMods = combatMods;

  // Champion base HP. Resolved from the SAME formula previewStartingStats
  // uses — bodyguard HP × championHpMultiplier — so the number the player
  // sees on the champion preview screen is the number the sim actually
  // uses. The previous implementation read championDef.championBaseHp,
  // which no def declares; the `?? 200` fallback silently fired, and the
  // sim disagreed with the preview (e.g. 200 vs. ~180 for the Warlord's
  // hobgoblin retinue). Skill-derived bonuses are added on top, as before.
  let baseHp = 200; // defensive fallback if the def or its type is missing
  if (championDef && championDef.unitTypeId) {
    const unitTypeDef = UnitTypes[championDef.unitTypeId];
    if (unitTypeDef) {
      const raceHpMult = raceOf(unitTypeDef).hpMultiplier ?? 1.0;
      const bodyguardHp = Math.max(1, Math.round(unitTypeDef.baseHp * raceHpMult));
      baseHp = Math.round(bodyguardHp * (championDef.championHpMultiplier ?? 1.0));
    }
  }
  const bonusFlat = combatMods.maxHpBonus ?? 0;
  const bonusPerLevel = (combatMods.maxHpPerLevel ?? 0) * champion.level;
  const newMaxHp = baseHp + bonusFlat + bonusPerLevel;
  champSoldier.maxHp = newMaxHp;
  champSoldier.hp = newMaxHp;

  // Morale ceiling. The champion is immune to the goblin race's 0.7
  // morale multiplier — a Warlord's resolve is their defining trait.
  // MoraleSystem reads baseMaxMorale for its casualty-scaled cap, so both
  // fields are set. The champion's morale still degrades with the unit's
  // casualty fraction (battlefield attrition weighs on them), just from a
  // much higher ceiling than the bodyguards.
  champSoldier.maxMorale = 200;
  champSoldier.baseMaxMorale = 200;
  champSoldier.morale = 200;

  unit.championSoldier = champSoldier;
  // Name override for the army bar and any unit-info reader. The unit
  // reads as the champion's name rather than the retinue type's label.
  unit.customName = champion.displayName;

  // Champion progression stamp. The champion has its own XP/level track
  // independent of the unit-level progression annotateUnitProgression
  // writes. UnitInfoPanel reads these fields (when present) to display
  // the champion's personal progression INSTEAD of the unit's — a
  // champion's retinue level is a separate concern from the champion's
  // own growth.
  unit.championLevel = champion.level;
  const champProg = championXpProgress(champion.level, champion.xp);
  unit.championXpFrac = champProg.frac;
  unit.championXpText = champProg.text;
  unit.championUnspentPoints = champion.unspentPoints;

  // --- Bodyguards ---
  // Bodyguard mods use their own vocabulary (bodyguardMaxHpBonus, etc.);
  // they are translated here into the fields the rest of the sim reads.
  // The damage multiplier is re-expressed as a generic combatMods field
  // (outgoingDamageMult) so _resolveAttack reads it through the same path
  // champion mods go through.
  const bgCombatMods = {};
  if (bodyguardMods.bodyguardDamageMult) {
    bgCombatMods.outgoingDamageMult = bodyguardMods.bodyguardDamageMult;
  }
  const hasBgCombatMods = Object.keys(bgCombatMods).length > 0;

  for (let i = 1; i < soldiers.length; i++) {
    const bg = soldiers[i];
    bg.isBodyguard = true;
    bg.championRef = champSoldier;
    if (hasBgCombatMods) bg.combatMods = bgCombatMods;

    if (bodyguardMods.bodyguardMaxHpBonus) {
      bg.maxHp += bodyguardMods.bodyguardMaxHpBonus;
      bg.hp = bg.maxHp;
    }

    if (bodyguardMods.bodyguardShieldHpMult && bg.hasShield) {
      bg.shieldHp = Math.round(bg.shieldHp * bodyguardMods.bodyguardShieldHpMult);
    }

    if (bodyguardMods.bodyguardMoraleBonus) {
      bg.maxMorale = Math.round(bg.maxMorale + bodyguardMods.bodyguardMoraleBonus);
      bg.baseMaxMorale = bg.maxMorale;
      bg.morale = bg.maxMorale;
    }

    if (bodyguardMods.bodyguardCannotRout) {
      bg.cannotRoutWhileChampionLives = true;
    }

    if (bodyguardMods.shoulderToShoulder) {
      bg.shoulderToShoulderActive = true;
    }
  }
}