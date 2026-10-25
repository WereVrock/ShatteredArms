// Shared, quantised tint materials for soldier bodies and shields.
//
// A soldier's body and shield used to own a per-instance material whose
// colour was rewritten every frame to show wounds. With hundreds of
// soldiers that meant hundreds of distinct materials, and the renderer
// pays a heavy state change every time two consecutive draws use
// different materials.
//
// Here the tint is quantised into TINT_LEVELS steps and every soldier
// whose (base colour, tint step) matches shares ONE material. The
// renderer then draws all of them back to back without state changes.
// The steps are 1/24 of full brightness, far below what the eye can
// separate, and the template materials are never mutated, so shared
// template materials (ultra tier) no longer fight over their colour.
import * as THREE from 'three';

export const TINT_LEVELS = 24;

const _cache = new Map();

// Maps a brightness factor (0..1) to an integer step 0..TINT_LEVELS.
export function quantizeTint(factor) {
  if (!(factor > 0)) return 0;
  if (factor >= 1) return TINT_LEVELS;
  return Math.round(factor * TINT_LEVELS);
}

// Returns the shared material for (template look, base colour, step).
// `template` supplies everything except colour (type, side, vertexColors);
// it is cloned once per distinct key and never modified.
export function getTintedMaterial(template, baseColor, level) {
  const key = `${template.type}|${baseColor.getHexString()}|` +
    `${template.vertexColors ? 1 : 0}|${template.side}|${level}`;
  let mat = _cache.get(key);
  if (!mat) {
    mat = template.clone();
    mat.color.copy(baseColor).multiplyScalar(level / TINT_LEVELS);
    _cache.set(key, mat);
  }
  return mat;
}