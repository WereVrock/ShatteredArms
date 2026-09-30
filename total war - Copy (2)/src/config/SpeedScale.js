import { CombatConfig } from './CombatConfig.js';

// Speed-scale boundary. This is the ONLY module that multiplies or divides
// by CombatConfig.movement.globalSpeedScale for the purpose of interpreting
// a config threshold — every other call site converts through here.
//
// Two spaces exist for any speed value in this codebase:
//
//   DESIGN space — the speed a soldier would move at if
//     movement.globalSpeedScale were 1.0. Every threshold in
//     CombatConfig.js / AIConfig.js that represents a world-units-per-
//     second speed is written in this space, so a designer reading
//     "charge.speedThreshold: 1.8" sees the same number they'd write in
//     a design doc regardless of how the global scale is later tuned.
//
//   SIM space — the actual world-units-per-second a soldier moves at in
//     the live simulation. MovementSystem applies globalSpeedScale when
//     it converts a soldier's design move speed into per-tick
//     displacement, so every `soldier.currentSpeed` read anywhere in
//     the sim is SIM space.
//
// Any comparison between `soldier.currentSpeed` and a config threshold
// MUST go through toSimSpeed(). Skipping the conversion was the concrete
// cause of the pre-patch SANITY failure: charge detection compared a
// sim-space ~1.17 (cavalry's decayed impact speed at globalSpeedScale
// 0.6) against a design-space 1.8 threshold, so isCharging was
// structurally false and both knockdown (kd) and brace-counter (brc)
// counters stayed at zero for the entire run.
//
// toDesignSpeed() is the inverse. It exists only for debug output where
// reading the raw design number is more useful than the sim number. No
// logic should branch on it.

export function toSimSpeed(designSpeed) {
  return designSpeed * CombatConfig.movement.globalSpeedScale;
}

export function toDesignSpeed(simSpeed) {
  return simSpeed / CombatConfig.movement.globalSpeedScale;
}