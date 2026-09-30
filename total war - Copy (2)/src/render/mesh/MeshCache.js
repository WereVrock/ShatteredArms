// Shared geometry/material caches for the per-soldier mesh builders.
//
// Every soldier previously constructed its own BufferGeometry and Material
// instances, even though most shapes are identical across every soldier of
// the same type (all blob torsos, all helmets of a given silhouette, all
// spear shafts, all horse legs, ...). At 1000+ soldiers that duplicates
// thousands of identical GPU resources and fragments three.js's render
// list, which groups opaque objects by material.
//
// This module exposes two tiny helpers — cachedGeometry(key, factory) and
// cachedMaterial(key, factory) — that build a value once per key and hand
// out the shared instance on every subsequent call.
//
// RULES
// ------------------------------------------------------------------
// Only share materials that are NOT mutated per-soldier. The body material
// (HP tint) and the shield material (shieldHp tint) are written every frame
// by SoldierView.sync — those must stay per-instance. Everything else
// (weapons, helmets, mounts, arrows, flags, sockets, pick proxies,
// selection rings) is safe to share.
//
// Because resources are shared, do NOT dispose the geometries or materials
// that come out of these caches. UnitThumbnailCapture used to dispose each
// composed icon's resources after rendering; with caching that would rip
// shared resources out from under the live game. See UnitThumbnailCapture
// for how it now handles cleanup (it doesn't — the cache owns the lifetime,
// and the cache is bounded by the number of distinct mesh types in the
// game, which is small and fixed).
import * as THREE from 'three';

const _geometryCache = new Map();
const _materialCache = new Map();

export function cachedGeometry(key, factory) {
  let g = _geometryCache.get(key);
  if (!g) {
    g = factory();
    _geometryCache.set(key, g);
  }
  return g;
}

export function cachedMaterial(key, factory) {
  let m = _materialCache.get(key);
  if (!m) {
    m = factory();
    _materialCache.set(key, m);
  }
  return m;
}