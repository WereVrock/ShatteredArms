// ===== SoldierMeshFactory.js =====
// Facade over src/render/mesh/. Every model builder lives in its own file
// there; this module re-exports them under the historical
// SoldierMeshFactory.* API so no importer needs to change.
//
// Adding a new model means: add the builder file under mesh/, import it
// here, and add one entry to the object below. This module holds no model
// geometry itself — it is a pure index.
//
// LOD ROUTING
// Every builder call is routed to one of FOUR tiers, chosen by a
// module-local `_currentTier` that callers set with setTier() before
// composing a model. The four builder families are:
//   1 Detailed    — the original *Builder.js files.
//   2 Medium      — mesh/MediumModels.js.
//   3 Simple      — mesh/SimpleModels.js.
//   4 Ultra       — mesh/UltraSimpleModels.js.
//
// Callers that build a soldier MUST call setTier(tier) immediately before
// SoldierModelComposer.compose(), so the tier that compose() runs at is
// the tier that soldier gets. This is a module-level, not per-instance,
// signal — JS is single-threaded, and every compose() call is synchronous,
// so no interleaving is possible between the set and the reads that follow
// it. UnitIconComposer and ProjectileView also set a tier before their own
// one-off builder calls (both use 1 Detailed).
//
// A tier that has no dedicated builder for a given mesh family falls back
// to the next more-detailed family that does — e.g. the arrow projectile
// has no ultra variant, so tier 4 uses the simple arrow. Fall-through is
// per-family, not per-tier: a family with all four builders (blob body)
// will always use the exact builder for its tier, and a family with only
// three (arrow) will degrade exactly one step.
import { createBlobBody } from './mesh/BlobBodyBuilder.js';
import { createGoblinBody } from './mesh/GoblinBodyBuilder.js';
import { createHobgoblinBody } from './mesh/HobgoblinBodyBuilder.js';
import { createGoblinWarlordBody } from './mesh/GoblinWarlordBuilder.js';
import { createSkeletonBody } from './mesh/SkeletonBodyBuilder.js';
import {
  createShield,
  createGoblinShield,
  createHobgoblinShield,
  createWarlordShield
} from './mesh/ShieldBuilder.js';
import { createSpear, createGoblinSpear } from './mesh/SpearBuilder.js';
import { createBow, createGoblinShortbow } from './mesh/BowBuilder.js';
import { createLance } from './mesh/LanceBuilder.js';
import { createSword, createCrudeSword } from './mesh/SwordBuilder.js';
import { createHorseBase } from './mesh/HorseBuilder.js';
import { createSkeletonHorseBase } from './mesh/SkeletonHorseBuilder.js';
import { createBeastMount } from './mesh/BeastMountBuilder.js';
import { createSwordScythe } from './mesh/SwordScytheBuilder.js';
import { createHorseHead } from './mesh/HorseHeadBuilder.js';
import { createSkull } from './mesh/SkullBuilder.js';
import { createArrowProjectile } from './mesh/ArrowBuilder.js';
import { createWhiteFlag } from './mesh/FlagBuilder.js';
import { createPickProxy } from './mesh/PickProxyBuilder.js';
import { createQuiver } from './mesh/QuiverBuilder.js';
import {
  createSimpleBlobBody,
  createSimpleGoblinBody,
  createSimpleHobgoblinBody,
  createSimpleSkeletonBody,
  createSimpleShield,
  createSimpleGoblinShield,
  createSimpleSpear,
  createSimpleGoblinSpear,
  createSimpleBow,
  createSimpleGoblinShortbow,
  createSimpleLance,
  createSimpleSword,
  createSimpleCrudeSword,
  createSimpleHorseBase,
  createSimpleSkeletonHorseBase,
  createSimpleHorseHead,
  createSimpleSkull,
  createSimpleArrowProjectile,
  createSimpleQuiver
} from './mesh/SimpleModels.js';
import {
  createMediumBlobBody,
  createMediumGoblinBody,
  createMediumHobgoblinBody,
  createMediumSkeletonBody,
  createMediumShield,
  createMediumGoblinShield,
  createMediumSpear,
  createMediumGoblinSpear,
  createMediumBow,
  createMediumGoblinShortbow,
  createMediumLance,
  createMediumSword,
  createMediumCrudeSword,
  createMediumHorseBase,
  createMediumSkeletonHorseBase,
  createMediumHorseHead,
  createMediumSkull,
  createMediumArrowProjectile,
  createMediumQuiver
} from './mesh/MediumModels.js';
import {
  createUltraSimpleBlobBody,
  createUltraSimpleGoblinBody,
  createUltraSimpleHobgoblinBody,
  createUltraSimpleSkeletonBody,
  createUltraSimpleShield,
  createUltraSimpleSpear,
  createUltraSimpleGoblinSpear,
  createUltraSimpleBow,
  createUltraSimpleGoblinShortbow,
  createUltraSimpleLance,
  createUltraSimpleSword,
  createUltraSimpleCrudeSword,
  createUltraSimpleHorseBase,
  createUltraSimpleSkeletonHorseBase,
  createUltraSimpleHorseHead,
  createUltraSimpleSkull,
  createUltraSimpleQuiver
} from './mesh/UltraSimpleModels.js';

// Module-local "current tier" signal. Default 1 (Detailed) so any caller
// that forgets to setTier() gets the safest, most-detailed fallback.
let _currentTier = 1;

// Routes one builder call to the tier-appropriate implementation, read at
// INVOCATION time (not at pick() time) so a single SoldierMeshFactory
// entry can serve every tier across a session. The four builders are
// captured at construction; the switch on _currentTier happens each call.
function pick(t1, t2, t3, t4) {
  return (...args) => {
    switch (_currentTier) {
      case 2: return t2(...args);
      case 3: return t3(...args);
      case 4: return t4(...args);
      default: return t1(...args);
    }
  };
}

export const SoldierMeshFactory = {
  // Set the LOD tier used by subsequent builder calls. Callers MUST set
  // this before composing a model. See the LOD ROUTING comment above for
  // why a module-level signal is safe here.
  setTier(tier) { _currentTier = tier; },
  getTier() { return _currentTier; },

  createBlobBody: pick(createBlobBody, createMediumBlobBody, createSimpleBlobBody, createUltraSimpleBlobBody),
  createGoblinBody: pick(createGoblinBody, createMediumGoblinBody, createSimpleGoblinBody, createUltraSimpleGoblinBody),
  createSkeletonBody: pick(createSkeletonBody, createMediumSkeletonBody, createSimpleSkeletonBody, createUltraSimpleSkeletonBody),
  createHobgoblinBody: pick(createHobgoblinBody, createMediumHobgoblinBody, createSimpleHobgoblinBody, createUltraSimpleHobgoblinBody),
  // The Goblin Warlord is a unique character; the detailed-tier armored
  // body is the only representation. Lower LOD tiers fall through to the
  // detailed builder — a unique character is one soldier, so its cost is
  // irrelevant, and the LOD contract (SoldierView rebuilds on tier change)
  // is satisfied without shipping four near-identical builds.
  createGoblinWarlordBody: pick(createGoblinWarlordBody, createGoblinWarlordBody, createGoblinWarlordBody, createGoblinWarlordBody),
  createShield: pick(createShield, createMediumShield, createSimpleShield, createUltraSimpleShield),
  createGoblinShield: pick(createGoblinShield, createMediumGoblinShield, createSimpleGoblinShield, createUltraSimpleShield),
  // Hobgoblin and Warlord shields have only the detailed-tier builder.
  // Both shapes are a single extruded outline and the Warlord's crest is
  // another; at every LOD below Detailed the silhouette is dominated by
  // the weapon and the head, so a cheaper variant is not worth shipping.
  // Falling through to Detailed at every tier keeps the LOD routing
  // contract (SoldierView rebuilds on tier change) satisfied without
  // four near-identical builds of the same outline.
  createHobgoblinShield: pick(createHobgoblinShield, createHobgoblinShield, createHobgoblinShield, createHobgoblinShield),
  createWarlordShield: pick(createWarlordShield, createWarlordShield, createWarlordShield, createWarlordShield),
  createSpear: pick(createSpear, createMediumSpear, createSimpleSpear, createUltraSimpleSpear),
  // Dothraki-style sword scythe (arakht). Only the detailed builder exists
  // — the weapon is unique to the beast-mounted hobgoblins, and lower LOD
  // tiers fall through to the same geometry. The mesh is a handful of
  // primitives, so the cost at any tier is negligible.
  createSwordScythe: pick(createSwordScythe, createSwordScythe, createSwordScythe, createSwordScythe),
  createGoblinSpear: pick(createGoblinSpear, createMediumGoblinSpear, createSimpleGoblinSpear, createUltraSimpleGoblinSpear),
  createBow: pick(createBow, createMediumBow, createSimpleBow, createUltraSimpleBow),
  createGoblinShortbow: pick(createGoblinShortbow, createMediumGoblinShortbow, createSimpleGoblinShortbow, createUltraSimpleGoblinShortbow),
  createLance: pick(createLance, createMediumLance, createSimpleLance, createUltraSimpleLance),
  createSword: pick(createSword, createMediumSword, createSimpleSword, createUltraSimpleSword),
  createCrudeSword: pick(createCrudeSword, createMediumCrudeSword, createSimpleCrudeSword, createUltraSimpleCrudeSword),
  createHorseBase: pick(createHorseBase, createMediumHorseBase, createSimpleHorseBase, createUltraSimpleHorseBase),
  createSkeletonHorseBase: pick(createSkeletonHorseBase, createMediumSkeletonHorseBase, createSimpleSkeletonHorseBase, createUltraSimpleSkeletonHorseBase),
  // Temporary placeholder. Only the detailed-tier builder exists; lower
  // LOD tiers fall through to the same function so every LOD range shows
  // the same shape. A dedicated modeller pass will add real LOD variants
  // if the beast survives into production — see BeastMountBuilder.js.
  createBeastMount: pick(createBeastMount, createBeastMount, createBeastMount, createBeastMount),
  createHorseHead: pick(createHorseHead, createMediumHorseHead, createSimpleHorseHead, createUltraSimpleHorseHead),
  createSkull: pick(createSkull, createMediumSkull, createSimpleSkull, createUltraSimpleSkull),
  // Arrow: no ultra variant. Tier 4 falls through to simple — an arrow at
  // 100+ world units is a handful of pixels, so the difference between
  // simple and a hypothetical ultra arrow is invisible.
  createArrowProjectile: pick(createArrowProjectile, createMediumArrowProjectile, createSimpleArrowProjectile, createSimpleArrowProjectile),
  createQuiver: pick(createQuiver, createMediumQuiver, createSimpleQuiver, createUltraSimpleQuiver),
  // Flag and pick proxy are not routed — they are already single- or
  // two-primitive meshes and have no cheaper simplified form.
  createWhiteFlag,
  createPickProxy
};