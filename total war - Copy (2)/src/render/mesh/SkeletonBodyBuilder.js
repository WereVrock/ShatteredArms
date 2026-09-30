// Skeleton body: pelvis, spine, rib bars, skull with sockets and jaw, team
// sash, shared legs. All upper-body Y values are expressed as offsets from
// LEG_HIP_Y, so a future leg-length change shifts the whole skeleton with it
// rather than leaving the pelvis and skull misaligned with the hip line.
//
// Geometries, the socket material, and the sash material are cached (see
// MeshCache.js). The bone material stays per-instance because SoldierView
// tints it toward black as HP drops. The sash material is cached by team
// colour so both teams' sashes are shared.
import * as THREE from 'three';
import { LEG_HIP_Y, addLegs } from './LegBuilder.js';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

// Five rib widths, one per rib. Indexed so each rib's cached geometry has a
// stable key. Kept module-level so it is obviously a constant rather than a
// per-call literal.
const RIB_WIDTHS = [0.22, 0.27, 0.28, 0.25, 0.20];

export function createSkeletonBody(color, teamColor) {
  const group = new THREE.Group();

  const boneColor = new THREE.Color(color).lerp(new THREE.Color(0xe8e0c8), 0.55);
  // Per-instance: SoldierView tints this toward black as HP drops.
  const mat = new THREE.MeshLambertMaterial({ color: boneColor });

  const pelvisGeo = cachedGeometry('skeleton.pelvisGeo', () =>
    new THREE.BoxGeometry(0.22, 0.1, 0.14));
  const pelvis = new THREE.Mesh(pelvisGeo, mat);
  pelvis.position.y = LEG_HIP_Y;
  group.add(pelvis);

  const spineGeo = cachedGeometry('skeleton.spineGeo', () =>
    new THREE.CylinderGeometry(0.03, 0.03, 0.36, 5));
  const spine = new THREE.Mesh(spineGeo, mat);
  spine.position.y = LEG_HIP_Y + 0.21;
  group.add(spine);

  // Ribcage: five tapered rib bars stacked up the chest, widest in the
  // middle, so the torso reads as bone rather than a solid box.
  const ribBaseY = LEG_HIP_Y + 0.28;
  const ribSpacing = 0.072;
  for (let i = 0; i < RIB_WIDTHS.length; i++) {
    const ribGeo = cachedGeometry(`skeleton.ribGeo.${i}`, () =>
      new THREE.BoxGeometry(RIB_WIDTHS[i], 0.028, 0.16));
    const rib = new THREE.Mesh(ribGeo, mat);
    rib.position.y = ribBaseY + i * ribSpacing;
    group.add(rib);
  }

  // Cranium stays the sphere — silhouette unchanged. Two small dark recesses
  // for eye sockets and a shallow jaw block poking out below the equator are
  // enough to read as a skull at this zoom. Face is local +Z (SoldierView
  // rotates the body by facing, and facing=0 is +Z world).
  const skullGeo = cachedGeometry('skeleton.skullGeo', () =>
    new THREE.SphereGeometry(0.15, 8, 7));
  const skull = new THREE.Mesh(skullGeo, mat);
  skull.position.y = LEG_HIP_Y + 0.73;
  group.add(skull);

  // Never mutated — safe to share across all skeletons of all teams.
  const socketMat = cachedMaterial('skeleton.socketMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x1a1408 }));
  const socketGeo = cachedGeometry('skeleton.socketGeo', () =>
    new THREE.SphereGeometry(0.028, 6, 5));
  for (const sx of [-0.05, 0.05]) {
    const socket = new THREE.Mesh(socketGeo, socketMat);
    socket.position.set(sx, LEG_HIP_Y + 0.74, 0.125);
    group.add(socket);
  }

  const jawGeo = cachedGeometry('skeleton.jawGeo', () =>
    new THREE.BoxGeometry(0.11, 0.05, 0.10));
  const jaw = new THREE.Mesh(jawGeo, mat);
  jaw.position.set(0, LEG_HIP_Y + 0.63, 0.08);
  group.add(jaw);

  addLegs(group, mat);

  // Team-colored sash: a thin box draped diagonally across the ribcage.
  // Cached by team colour — there are only two team colours in the game.
  const sashGeo = cachedGeometry('skeleton.sashGeo', () =>
    new THREE.BoxGeometry(0.08, 0.42, 0.19));
  const sashMat = cachedMaterial(`skeleton.sashMat.${teamColor}`, () =>
    new THREE.MeshLambertMaterial({ color: teamColor }));
  const sash = new THREE.Mesh(sashGeo, sashMat);
  sash.position.y = LEG_HIP_Y + 0.42;
  sash.rotation.z = Math.PI / 5;
  group.add(sash);

  group.userData.baseMaterial = mat;
  return group;
}