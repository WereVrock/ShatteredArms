// ===== src/render/mesh/SkeletonBodyBuilder.js =====
// Skeleton body: pelvis, spine, rib bars, skull with sockets and jaw, team
// sash, shared legs. All upper-body Y values are expressed as offsets from
// LEG_HIP_Y, so a future leg-length change shifts the whole skeleton with it
// rather than leaving the pelvis and skull misaligned with the hip line.
//
// Every bone-material part (pelvis, spine, ribs, skull, jaw) is rigidly
// attached and shares one material, so they merge into a single mesh (see
// MeshMerge.js) — one draw call per skeleton instead of nine, with zero
// visual change. The two eye sockets share a second material and merge
// into a single mesh; the sash keeps its own (cached, shared) material.
//
// The merged geometries are cached (see MeshCache.js); the bone material
// stays per-instance because SoldierView tints it toward black as HP drops.
import * as THREE from 'three';
import { LEG_HIP_Y, addLegs } from './LegBuilder.js';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { mergeGeometries, partMatrix } from './MeshMerge.js';

// Five rib widths, one per rib. Indexed so each rib's cached geometry has a
// stable key. Kept module-level so it is obviously a constant rather than a
// per-call literal.
const RIB_WIDTHS = [0.22, 0.27, 0.28, 0.25, 0.20];

// Fixed Y positions, all expressed relative to LEG_HIP_Y. Kept here so the
// cached geometry factory can read them without a captured closure.
const PELVIS_Y      = LEG_HIP_Y;
const SPINE_Y       = LEG_HIP_Y + 0.21;
const RIB_BASE_Y    = LEG_HIP_Y + 0.28;
const RIB_SPACING   = 0.072;
const SKULL_Y       = LEG_HIP_Y + 0.73;
const SOCKET_Y      = LEG_HIP_Y + 0.74;
const SOCKET_Z      = 0.125;
const JAW_Y         = LEG_HIP_Y + 0.63;
const JAW_Z         = 0.08;

export function createSkeletonBody(color, teamColor) {
  const group = new THREE.Group();

  const boneColor = new THREE.Color(color).lerp(new THREE.Color(0xe8e0c8), 0.55);
  // Per-instance: SoldierView tints this toward black as HP drops.
  const mat = new THREE.MeshLambertMaterial({ color: boneColor });

  // All bone-material parts merged into one mesh. Pelvis, spine, the five
  // ribs, the skull, and the jaw are all rigidly attached and share `mat`,
  // so a single draw call covers the whole bone structure.
  const boneGeo = cachedGeometry('skeleton.boneGeo', () => {
    const entries = [
      {
        geometry: new THREE.BoxGeometry(0.22, 0.1, 0.14),
        matrix: partMatrix(0, PELVIS_Y, 0)
      },
      {
        geometry: new THREE.CylinderGeometry(0.03, 0.03, 0.36, 5),
        matrix: partMatrix(0, SPINE_Y, 0)
      }
    ];
    for (let i = 0; i < RIB_WIDTHS.length; i++) {
      entries.push({
        geometry: new THREE.BoxGeometry(RIB_WIDTHS[i], 0.028, 0.16),
        matrix: partMatrix(0, RIB_BASE_Y + i * RIB_SPACING, 0)
      });
    }
    entries.push({
      geometry: new THREE.SphereGeometry(0.15, 8, 7),
      matrix: partMatrix(0, SKULL_Y, 0)
    });
    entries.push({
      geometry: new THREE.BoxGeometry(0.11, 0.05, 0.10),
      matrix: partMatrix(0, JAW_Y, JAW_Z)
    });
    return mergeGeometries(entries);
  });
  group.add(new THREE.Mesh(boneGeo, mat));

  // Eye sockets share a separate (cached, shared) material and are rigidly
  // attached; merge them into one mesh. The recessed look is preserved —
  // same geometry, same positions, same material.
  const socketMat = cachedMaterial('skeleton.socketMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x1a1408 }));
  const socketGeo = cachedGeometry('skeleton.socketsGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.SphereGeometry(0.028, 6, 5),
        matrix: partMatrix(-0.05, SOCKET_Y, SOCKET_Z)
      },
      {
        geometry: new THREE.SphereGeometry(0.028, 6, 5),
        matrix: partMatrix(0.05, SOCKET_Y, SOCKET_Z)
      }
    ])
  );
  group.add(new THREE.Mesh(socketGeo, socketMat));

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