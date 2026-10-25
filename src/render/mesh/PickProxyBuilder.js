// Invisible sphere used purely for click-picking. The visual body is small,
// thin, and full of gaps (between torso and head, between legs, off to one
// side for the weapon) — raycasting the visible meshes directly gave a lot
// of false-negative clicks. One generous proxy per soldier means a click
// anywhere on or near the silhouette counts.
//
// material.visible = false means the mesh issues no draw call; three.js
// raycasting ignores material visibility entirely, so it still hits.
// Cavalry gets a bigger, higher sphere to encompass the mount as well.
//
// Only two distinct proxies exist (foot and cavalry); both their geometries
// and their shared invisible material are cached (see MeshCache.js).
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

export function createPickProxy(isCavalry) {
  const radius = isCavalry ? 0.85 : 0.5;
  const centerY = isCavalry ? 0.7 : 0.55;
  const geo = cachedGeometry(`pickProxy.geo.${isCavalry ? 'cav' : 'foot'}`, () =>
    new THREE.SphereGeometry(radius, 8, 6));
  const mat = cachedMaterial('pickProxy.mat', () =>
    new THREE.MeshBasicMaterial({ visible: false }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = centerY;
  return mesh;
}