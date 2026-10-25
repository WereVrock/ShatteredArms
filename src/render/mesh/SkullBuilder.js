// Standalone skull, centred at the origin and facing +Z (sockets on the +Z
// face). Used as the undead accent on the army-bar unit icon (see
// UnitIconComposer). Cranium sphere + two dark eye sockets + a shallow jaw.
//
// Geometries and both materials are cached (see MeshCache.js).
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

export function createSkull() {
  const group = new THREE.Group();

  const boneMat = cachedMaterial('skull.boneMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xe8e0c8 }));
  const socketMat = cachedMaterial('skull.socketMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x1a1408 }));

  const craniumGeo = cachedGeometry('skull.craniumGeo', () =>
    new THREE.SphereGeometry(0.15, 10, 8));
  const cranium = new THREE.Mesh(craniumGeo, boneMat);
  group.add(cranium);

  const socketGeo = cachedGeometry('skull.socketGeo', () =>
    new THREE.SphereGeometry(0.045, 6, 5));
  for (const sx of [-0.055, 0.055]) {
    const socket = new THREE.Mesh(socketGeo, socketMat);
    socket.position.set(sx, 0.01, 0.125);
    group.add(socket);
  }

  const jawGeo = cachedGeometry('skull.jawGeo', () =>
    new THREE.BoxGeometry(0.14, 0.07, 0.12));
  const jaw = new THREE.Mesh(jawGeo, boneMat);
  jaw.position.set(0, -0.13, 0.06);
  group.add(jaw);

  return group;
}