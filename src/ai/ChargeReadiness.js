// Answers one question for cavalry, before committing to a charge: will
// this charge actually land clean, or is the target likely to have turned
// to face us (and therefore brace, per CombatResolutionSystem._isBracedSpearman)
// by the time we arrive?
//
// This is a TIME RACE: the defender needs enough time-to-turn (bounded by
// their effectiveTurnRateRadPerSec, now real since rotation was wired in)
// to reach a facing within brace.frontalArcDeg of our approach angle,
// before we cover the remaining distance to chargeDist at our current
// closing speed. If the defender can plausibly make that turn in time,
// charging them is throwing the unit away for nothing — a countered charge
// deals bonus damage back to the ATTACKER (CombatResolutionSystem._applyBraceCounter)
// and negates the attacker's own charge bonus entirely.
//
// Deliberately soldier-level, not unit-level: it evaluates the specific
// front-facing soldiers of the target unit that would actually receive the
// charge (nearest few to our approach vector), not an average over the
// whole formation — a defender's back rank turning has no bearing on
// whether the FRONT rank we're about to hit is braced.
import { CombatConfig } from '../config/CombatConfig.js';
import { toSimSpeed } from '../config/SpeedScale.js';
import { AIConfig } from '../config/AIConfig.js';
import { AIDebugLog } from './AIDebugLog.js';

export class ChargeReadiness {
  // attacker: a Soldier from the charging cavalry unit (any one; used for
  // effectiveMass/currentSpeed context is on the unit's actual chargers,
  // so this samples the unit's living soldiers directly).
  // targetUnit: the enemy Unit being considered.
  // Returns { willLandClean: bool, reason: string } — reason is for
  // debugging/tuning, not used in logic.
  // leniency: C3 posture-conditional value (AIConfig.posture.{press,hold}
  // .chargeReadinessLeniency). 0 (hold/default) reproduces pre-C3 behavior
  // exactly: abort if >=50% of sampled defenders would brace. Press raises
  // the tolerated braced fraction, so a pressing team accepts a charge it
  // would otherwise call off — deliberately riskier, matching "press
  // allows cavalry to accept riskier charges" from the roadmap.
  static assess(cavalryUnit, targetUnit, allEnemyUnits, leniency, worldCtx) {
    const chargers = cavalryUnit.getAliveSoldiers();
    if (chargers.length === 0) return { willLandClean: false, bracedCount: 0, sampledDefenders: 0, reason: 'no chargers' };

    const targetSoldiers = targetUnit.getAliveSoldiers();
    if (targetSoldiers.length === 0) return { willLandClean: false, bracedCount: 0, sampledDefenders: 0, reason: 'no defenders' };

    const cavCenter = cavalryUnit.getCenter();
    const defCenter = targetUnit.getCenter();

    const dx = defCenter.x - cavCenter.x;
    const dz = defCenter.z - cavCenter.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist <= 0.001) return { willLandClean: false, bracedCount: 0, sampledDefenders: 0, reason: 'degenerate distance' };

    // Distance remaining until charge contact range.
    const distToContact = Math.max(0, dist - CombatConfig.chargeSpotRange);

    // Closing speed: use the cavalry unit's actual current soldier speed if
    // already moving, otherwise assume they accelerate to charge threshold
    // (a conservative/pessimistic assumption — better to under-estimate our
    // own speed and over-estimate the defender's chance to brace than the
    // reverse, since a wrongly-aborted charge costs a tick of hesitation
    // while a wrongly-committed one costs the whole unit).
    // Both operands of the Math.max must be SIM space — actual soldier
    // speeds already are, so the config floor has to be converted too.
    // The result feeds ticksToContact = (dist / sampleSpeed) * tickRateHz,
    // so a design-space floor here would make the readiness projection
    // internally inconsistent (mixed units in a division).
    const sampleSpeed = Math.max(
      chargers.reduce((sum, s) => sum + s.currentSpeed, 0) / chargers.length,
      toSimSpeed(CombatConfig.charge.speedThreshold)
    );
    const rawTicksToContact = (distToContact / sampleSpeed) * CombatConfig.tickRateHz;

    // Cap the projection horizon. Evidence from playtest: at long range
    // (50-70+ units) this produced ticksToContact in the 400-600 range,
    // which yields an astronomically large turnAvailableRad — technically
    // correct (a stationary defender given 40 real seconds absolutely
    // could turn to face us) but useless as a decision signal, because it
    // permanently vetoes any long-range target as "will definitely brace"
    // and the unit never gets close enough to re-assess from a shorter,
    // more decision-relevant distance. Readiness should answer "if I
    // commit NOW, is the approach likely to land clean", which only makes
    // sense to ask within a bounded horizon — beyond that, the honest
    // answer is "unknown, get closer first", not "definitely will brace".
    const MAX_PROJECTION_TICKS = 90; // 6s — matches commitTimeoutTicks scale
    const ticksToContact = Math.min(rawTicksToContact, MAX_PROJECTION_TICKS);

    // Approach angle: the direction FROM the defender TO the attacker (this
    // is what the defender needs to face to be "frontal" to us, matching
    // ShieldBlockCalculator.computeAngleOffShield's convention).
    const approachAngle = Math.atan2(cavCenter.x - defCenter.x, cavCenter.z - defCenter.z);

    // Sample pool: the soldiers we'll actually hit on arrival.
    //
    // When allEnemyUnits is provided, that means ALL enemies within 2×
    // chargeSpotRange of the TARGET'S CENTER — the impact point. This is
    // the fix for the observed bug: previously only the target unit's own
    // soldiers were sampled, so a spear line that stepped in front of a
    // committed charge against archers was invisible (archers can't brace,
    // bracedCount locked at 0, abort never fired). Fallback to target-only
    // if the wider radius finds nobody (isolated target).
    //
    // When allEnemyUnits is omitted, sample only the target unit's own
    // soldiers — legacy behavior, appropriate when the question is "will
    // THIS unit brace".
    let samplePool;
    if (allEnemyUnits) {
      const sampleRadius = CombatConfig.chargeSpotRange * 2;
      const sampleRadiusSq = sampleRadius * sampleRadius;
      samplePool = [];
      for (const eu of allEnemyUnits) {
        if (eu.isDefeated()) continue;
        for (const s of eu.getAliveSoldiers()) {
          const sdx = s.pos.x - defCenter.x;
          const sdz = s.pos.z - defCenter.z;
          if (sdx * sdx + sdz * sdz <= sampleRadiusSq) samplePool.push(s);
        }
      }
      if (samplePool.length === 0) samplePool = targetSoldiers;
    } else {
      samplePool = targetSoldiers;
    }

    // Nearest 3 to the impact point — those are the soldiers who'd
    // physically receive the charge.
    const nearestDefenders = samplePool
      .map(s => {
        const ddx = s.pos.x - defCenter.x;
        const ddz = s.pos.z - defCenter.z;
        return { soldier: s, distSq: ddx * ddx + ddz * ddz };
      })
      .sort((a, b) => a.distSq - b.distSq)
      .slice(0, 3)
      .map(e => e.soldier);

    let bracedCount = 0;
    for (const defender of nearestDefenders) {
      if (this._willBeFacingInTime(defender, approachAngle, ticksToContact, cavalryUnit.id)) {
        bracedCount++;
      }
    }

    // Part C: corridor sample. Any braced spearman along the approach path
    // between the charger and the target's center means the charge front
    // hits a wall rather than an exposed flank. Catches the case the
    // impact-point sample misses: a spear screen standing in front of a
    // soft target, positioned more than 2*chargeSpotRange from the
    // target's own center. Inbound only — the return path is a disengage,
    // handled by cavalry regroup, not by ChargeReadiness.
    //
    // Overwhelming gate: when the cav unit's non-routing alive count is
    // >= AIConfig.corridorOverwhelmingRatio * (non-routing spear count in
    // the corridor), the corridor is treated as clean outright — a lone
    // spear cannot veto a full cavalry unit. Returned in `overwhelmed`
    // so the debug view can render it distinctly from a clean corridor.
    // Corridor-skip policy. See shouldSkipCorridor for the two
    // conditions. When skipped, the corridor sample is treated as
    // empty — the impact-point sample above still runs and still
    // refuses a fully-braced spear wall, so the only thing removed is
    // the corridor check's extra layer of refusal.
    const skipReason = this.shouldSkipCorridor(targetUnit, worldCtx);
    const skipCorridor = !!skipReason;
    const corridorResult = (allEnemyUnits && !skipCorridor)
      ? this._countBracedSpearmenInCorridor(
          cavalryUnit, cavCenter, defCenter, dist, allEnemyUnits, sampleSpeed, MAX_PROJECTION_TICKS,
          targetUnit.id
        )
      : { bracedCount: 0, spearCount: 0, overwhelmed: false };
    const corridorBracedCount = corridorResult.bracedCount;
    const corridorOverwhelmed = corridorResult.overwhelmed;

    // Debug visualization: emit the corridor geometry on EVERY assessment,
    // not only refusals, so a unit being debug-inspected (G+click) shows
    // its full corridor-test history. `refused` distinguishes the two
    // cases for the viewer (red vs teal). CorridorDebugView filters by
    // watched unit when one is set; when none is, it falls back to
    // showing only refusals (the previous behavior).
    AIDebugLog.corridorEvent({
      attackerUnitId: cavalryUnit.id,
      targetUnitId: targetUnit.id,
      cavX: cavCenter.x,
      cavZ: cavCenter.z,
      defX: defCenter.x,
      defZ: defCenter.z,
      // Must match the width the corridor check actually used, or the
      // debug view draws a different corridor than the one the AI is
      // reasoning about. TeamAI._isCavPathBlockedBySpears already
      // emits the widened value; this brings ChargeReadiness into
      // agreement.
      halfWidth: CombatConfig.charge.corridorHalfWidth *
        (AIConfig.corridorWidthMultiplier ?? 2.0),
      refused: corridorBracedCount > 0,
      overwhelmed: corridorOverwhelmed,
      // Skipped-corridor signal. When true, the corridor sample above
      // was bypassed entirely — the view renders the geometry in yellow
      // to distinguish this from both "clean" (which was actually
      // evaluated) and "refused" (red). skipReason names the specific
      // condition that fired: 'target-is-spear' or
      // 'no-offensive-options'. See shouldSkipCorridor.
      skipped: skipCorridor,
      skipReason
    });

    // If a majority of the soldiers who'd actually receive the charge will
    // plausibly be facing us in time, the charge is not worth committing —
    // it'll hit a wall of braced spears (or at minimum non-charge-bonus
    // melee) instead of a clean flank/rear hit.
    //
    // C3: leniency shifts the effective majority bar upward. At leniency 0
    // (hold/default) this is exactly ceil(n/2), unchanged from pre-C3. At
    // e.g. leniency 0.15 with 3 sampled defenders, the bar becomes
    // ceil(3 * (0.5 + 0.15)) = ceil(1.95) = 2 — same as before for small n,
    // but the fractional bump compounds correctly as sample size grows.
    const lenient = Math.max(0, Math.min(0.49, leniency || 0));
    const bracedMajorityBar = Math.ceil(nearestDefenders.length * (0.5 + lenient));
    const impactClean = bracedCount < bracedMajorityBar;
    const corridorClean = corridorBracedCount === 0;
    const willLandClean = impactClean && corridorClean;

    AIDebugLog.log('charge', (worldCtx && worldCtx.currentTick) || 0,
      `assess cav=${cavalryUnit.id} target=${targetUnit.id} dist=${dist.toFixed(2)} distToContact=${distToContact.toFixed(2)} ticksToContact=${ticksToContact.toFixed(1)} impact=${bracedCount}/${nearestDefenders.length} corridor=${corridorBracedCount} => clean=${willLandClean}`);

    let reason;
    if (willLandClean) reason = 'defenders unlikely to face in time';
    else if (!corridorClean) reason = 'spear wall in approach corridor';
    else reason = 'defenders likely to turn and brace before contact';

    return {
      willLandClean,
      bracedCount,
      corridorBracedCount,
      sampledDefenders: nearestDefenders.length,
      reason
    };
  }

  // Corridor-skip policy. One condition (plus a tier handicap) lets the
  // corridor check be bypassed entirely:
  //
  //   - The cavalry's team has NEITHER a melee line NOR ranged units.
  //     The corridor check is a "wait for a better moment" instruction
  //     — wait for the melee line to pin the spears, or wait for
  //     archers to soften them. With no melee line and no ranged units,
  //     there will never be a better moment; refusing the charge just
  //     parks the cavalry at its flank slot indefinitely and produces
  //     the walk-off-the-map stall. Combined-arms teams still wait for
  //     their better moment — this condition only fires on the empty-
  //     toolkit case.
  //
  // The old 'target-is-spear' skip has been REMOVED. It was written on
  // the reasoning that a spear target's own soldiers occupy the corridor
  // by construction, so sampling them double-counted against the
  // impact-point check. True — but it also disabled the corridor check
  // entirely, which meant a spear target standing in front of / among
  // OTHER spear units could be charged clean whenever the 3-soldier
  // impact-point sample happened to pick the target's own soldiers and
  // none of them could brace in time (turned away, reeling, or briefly
  // routing). The fix is narrower: the corridor sample now EXCLUDES the
  // target unit's own soldiers (see _countBracedSpearmenInCorridor's
  // excludeUnitId parameter), so the double-count is gone but the wall
  // behind the target is still caught.
  //
  // Impact-point check is NOT affected by the remaining skip. A fully-
  // braced spear wall still refuses a frontal charge.
  //
  // worldCtx is optional. When absent (or missing the composition
  // fields), the policy defaults to "do not skip" — the conservative
  // direction, since skipping widens the cavalry's options.
  // Returns the reason the corridor check should be skipped as a string
  // ('no-offensive-options'), or null when the check should run.
  // Returning a reason rather than a boolean lets the debug view render
  // a distinct color for skipped corridors (yellow) and lets the debug
  // log name the specific condition that fired.
  static shouldSkipCorridor(targetUnit, worldCtx) {
    // Tier-level handicap. A tier that wants to appear less cautious can
    // skip the corridor check unconditionally — the cav charges through
    // spear screens the way a novice commander's cavalry would. Read
    // from worldCtx so no signature change is needed at the assess() or
    // _decideSeeking call sites. Default (no tier field, or field
    // false) is unchanged.
    if (worldCtx?.tierCfg?.skipCorridorCheck) return 'tier-handicap';

    if (!targetUnit || targetUnit.isDefeated()) return null;
    const type = targetUnit.soldiers[0]?.unitTypeDef;
    if (!type) return null;

    const hasMelee = this._hasAliveLineUnit(worldCtx);
    const hasRanged = this._hasAliveRangedUnit(worldCtx);
    if (!hasMelee && !hasRanged) return 'no-offensive-options';

    return null;
  }

  // Default TRUE when the field is missing — matches the conservative
  // default used by FlankerBehavior._teamHasMeleeLine. When we cannot
  // confirm team composition, assume the line exists and do NOT grant
  // the exemption.
  static _hasAliveLineUnit(worldCtx) {
    if (!worldCtx || !Array.isArray(worldCtx.infantryLineUnits)) return true;
    for (const u of worldCtx.infantryLineUnits) {
      if (!u.isDefeated()) return true;
    }
    return false;
  }

  static _hasAliveRangedUnit(worldCtx) {
    if (!worldCtx || !Array.isArray(worldCtx.rangedUnits)) return true;
    for (const u of worldCtx.rangedUnits) {
      if (!u.isDefeated()) return true;
    }
    return false;
  }

  // Part C: sample spearmen along the approach corridor — the cylinder of
  // half-width CombatConfig.charge.corridorHalfWidth centered on the
  // segment from the charger's center to the target's center. A braced
  // spearman inside it will meet the charge's front.
  //
  // Two passes now:
  //   1. Gather every NON-ROUTING spear-wielding soldier in the corridor
  //      EXCEPT soldiers belonging to the target unit itself.
  //   2. Overwhelming gate: if the cav unit's non-routing alive count is
  //      >= AIConfig.corridorOverwhelmingRatio * spearCount, return
  //      overwhelmed=true with bracedCount=0 — the corridor is treated as
  //      clean. Otherwise run the existing brace-in-time math on each
  //      gathered spearman and return the braced count.
  //
  // excludeUnitId: the corridor sample skips soldiers of this unit. The
  // target unit's own soldiers are assessed by the impact-point sample in
  // assess() under a specific approach angle; including them here too
  // would (a) double-count them against a slightly different per-soldier
  // angle and (b) make ANY charge at a spear unit — whose own front rank
  // is trivially inside its own corridor — fail regardless of what the
  // impact-point check would have said. The corridor check exists to
  // catch the OTHER spear units standing between the cav and the target;
  // excluding the target's own soldiers preserves that without the
  // self-blocking artifact.
  //
  // Per-soldier approach angle: each candidate is measured against the
  // direction from itself to cavCenter, not the unit-center-to-unit-center
  // angle used by the impact-point sample. A spearman at the near end of
  // the corridor sees the charge from a slightly different bearing than
  // one at the far end, and the extra cost is negligible for the accuracy
  // gained at close range.
  //
  // Returns { bracedCount, spearCount, overwhelmed }.
  //   bracedCount — spearmen that would plausibly brace in time (0 when
  //                 overwhelmed).
  //   spearCount  — non-routing spear-wielding soldiers found in the
  //                 corridor, pre-brace-check.
  //   overwhelmed— true when the cav-to-spear ratio gate fired.
  static _countBracedSpearmenInCorridor(cavalryUnit, cavCenter, defCenter, dist, allEnemyUnits, sampleSpeed, maxProjectionTicks, excludeUnitId) {
    // Widened corridor (AIConfig.corridorWidthMultiplier, default 2x).
    // The original width only catches spears on the exact line to the
    // target; a spear a few units off that line today is on the line
    // next cycle, by which time the cav has closed past the abort
    // window. Widening catches them while the abort is still clean.
    const halfWidth = CombatConfig.charge.corridorHalfWidth *
      (AIConfig.corridorWidthMultiplier ?? 2.0);
    const halfWidthSq = halfWidth * halfWidth;
    const overshoot = CombatConfig.charge.corridorOvershootUnits || 0;
    const corridorEnd = dist + overshoot;
    const dirX = (defCenter.x - cavCenter.x) / dist;
    const dirZ = (defCenter.z - cavCenter.z) / dist;

    // Pass 1: gather every non-routing spear-wielding soldier in the
    // corridor except the target unit's own soldiers, along with their
    // `along` position so pass 2 does not have to re-derive it.
    const corridorSpears = [];
    for (const eu of allEnemyUnits) {
      if (eu.isDefeated()) continue;
      // Skip the target unit's own soldiers — they are assessed by the
      // impact-point sample, not the corridor sample. See method header.
      if (excludeUnitId != null && eu.id === excludeUnitId) continue;
      for (const s of eu.getAliveSoldiers()) {
        if (s.unitTypeDef.weaponType !== 'spear') continue;
        if (s.isRouting) continue;
        // Engaged spearmen cannot brace. They are fighting someone
        // else, cannot turn to face the charge, and cannot plant a
        // shaft. Counting them as braced defenders over-refuses
        // charges at spears already pinned by our own line, which is
        // exactly the moment the charge should land.
        if (s.isInMelee()) continue;

        const sx = s.pos.x - cavCenter.x;
        const sz = s.pos.z - cavCenter.z;
        const along = sx * dirX + sz * dirZ;
        // Corridor extends `overshoot` units PAST the target's center so
        // spearmen intermingled with the target unit (e.g. spears mixed
        // into an archer formation, one rank behind the archers from the
        // charger's bearing) are still sampled. Without this the corridor
        // stopped exactly at the target's center and those spearmen were
        // invisible — cavalry charged clean-looking archers and arrived
        // at a spear hedge.
        if (along <= 0 || along >= corridorEnd) continue;

        const perpX = sx - along * dirX;
        const perpZ = sz - along * dirZ;
        if (perpX * perpX + perpZ * perpZ > halfWidthSq) continue;

        corridorSpears.push({ soldier: s, along });
      }
    }

    const spearCount = corridorSpears.length;
    if (spearCount === 0) {
      return { bracedCount: 0, spearCount: 0, overwhelmed: false };
    }

    // Overwhelming gate. One spear cannot block a full cavalry unit; when
    // cav strength dominates the corridor's spear presence the corridor
    // is treated as clean regardless of brace-in-time math.
    const cavStrength = cavalryUnit.getAliveSoldiers()
      .filter(s => !s.isRouting).length;
    if (cavStrength >= spearCount * AIConfig.corridorOverwhelmingRatio) {
      return { bracedCount: 0, spearCount, overwhelmed: true };
    }

    // Pass 2: brace-in-time check on each gathered spearman.
    let count = 0;
    for (const { soldier: s, along } of corridorSpears) {
      // A spearman PAST the target's center (along > dist) receives the
      // charge at essentially the same moment the target does — clamp
      // remaining distance to 0 so the time-available model treats them
      // as needing to be already facing. A spearman at or in front of
      // the target center still gets the nominal tick budget.
      const remainingDist = Math.max(0, dist - along);
      const ticksToReachSoldier = Math.min(
        maxProjectionTicks,
        (remainingDist / sampleSpeed) * CombatConfig.tickRateHz
      );

      const soldierApproachAngle = Math.atan2(
        cavCenter.x - s.pos.x,
        cavCenter.z - s.pos.z
      );

      if (this._willBeFacingInTime(s, soldierApproachAngle, ticksToReachSoldier, cavalryUnit.id)) {
        count++;
      }
    }
    return { bracedCount: count, spearCount, overwhelmed: false };
  }

  static _willBeFacingInTime(defender, approachAngle, ticksAvailable, cavUnitIdForLog) {
    // Only spearmen actually brace at all (CombatResolutionSystem._isBracedSpearman
    // requires weaponType === 'spear'). A non-spear defender facing us just
    // means normal frontal melee, not a countered/negated charge — so for
    // charge-worth purposes, only spear-wielding defenders matter here.
    if (defender.unitTypeDef.weaponType !== 'spear') return false;

    // A broken soldier is not manning a spear wall — they are fleeing,
    // and cannot stop, turn, and plant a shaft. Without this guard, a
    // routing spear unit is treated as a defender that will "brace in
    // time" (available turn budget at long range is ~1000°, see
    // MAX_PROJECTION_TICKS), so ChargeReadiness permanently refuses to
    // charge the only cheap kills left on the field.
    //
    // Guard on the isRouting FLAG, not just state === 'routing'. A
    // routing soldier who has been staggered by an incoming hit has its
    // `state` overwritten to 'staggered' by CombatResolutionSystem
    // (which does not itself know about routing), while `isRouting`
    // remains true — so a state-only check would let a broken-and-
    // reeling spearman be counted as a braced defender on the very next
    // hit. isRouting is the authoritative "this soldier has broken"
    // flag; shattered soldiers carry it too (set before state is
    // assigned in MoraleSystem._updateSoldier).
    if (defender.isRouting || defender.state === 'routing' || defender.state === 'shattered') return false;

    let diff = approachAngle - defender.facing;
    diff = ((diff + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const angleOffDeg = Math.abs(diff) * (180 / Math.PI);

    if (angleOffDeg <= CombatConfig.brace.frontalArcDeg) {
      // Already within frontal arc — no turning was needed at all, so
      // "needed"/"available" turn amounts are not meaningful (not zero,
      // just not applicable). Log distinctly from the real turn-math path
      // below so this case can't be misread as "turned 0deg in 0 time".
      AIDebugLog.log('brace', 0, `cav=${cavUnitIdForLog} defender=${defender.id} angleOff=${angleOffDeg.toFixed(1)} ALREADY_FACING willBrace=true`);
      return true; // already facing us
    }

    const turnNeededRad = Math.abs(diff) - (CombatConfig.brace.frontalArcDeg * Math.PI / 180);
    const turnRate = defender.effectiveTurnRateRadPerSec; // rad/sec
    const secondsAvailable = ticksAvailable / CombatConfig.tickRateHz;
    const turnAvailableRad = turnRate * secondsAvailable;

    const willBrace = turnAvailableRad >= turnNeededRad;
    AIDebugLog.braceCheck(0, cavUnitIdForLog, defender.id, angleOffDeg,
      turnNeededRad * (180 / Math.PI), turnAvailableRad * (180 / Math.PI), willBrace);

    return willBrace;
  }
}
