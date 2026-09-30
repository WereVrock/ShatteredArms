// Facade over src/render/mesh/. Every model builder lives in its own file
// there; this module re-exports them under the historical
// SoldierMeshFactory.* API so no importer needs to change.
//
// Adding a new model means: add the builder file under mesh/, import it here,
// and add one entry to the object below. This module holds no model geometry
// itself — it is a pure index.
import { createBlobBody } from './mesh/BlobBodyBuilder.js';
import { createSkeletonBody } from './mesh/SkeletonBodyBuilder.js';
import { createShield } from './mesh/ShieldBuilder.js';
import { createSpear } from './mesh/SpearBuilder.js';
import { createBow } from './mesh/BowBuilder.js';
import { createLance } from './mesh/LanceBuilder.js';
import { createSword } from './mesh/SwordBuilder.js';
import { createHorseBase } from './mesh/HorseBuilder.js';
import { createSkeletonHorseBase } from './mesh/SkeletonHorseBuilder.js';
import { createHorseHead } from './mesh/HorseHeadBuilder.js';
import { createSkull } from './mesh/SkullBuilder.js';
import { createArrowProjectile } from './mesh/ArrowBuilder.js';
import { createWhiteFlag } from './mesh/FlagBuilder.js';
import { createPickProxy } from './mesh/PickProxyBuilder.js';

export const SoldierMeshFactory = {
  createBlobBody,
  createSkeletonBody,
  createShield,
  createSpear,
  createBow,
  createLance,
  createSword,
  createHorseBase,
  createSkeletonHorseBase,
  createHorseHead,
  createSkull,
  createArrowProjectile,
  createWhiteFlag,
  createPickProxy
};