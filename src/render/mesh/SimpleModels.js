// Low-poly variants of every procedural model, used when
// SettingsStore.simpleModels is on (see GraphicsMode and SoldierMeshFactory).
//
// Each function replaces its detailed counterpart with one primitive, or a
// very small handful, so a 1000-soldier battle renders at a fraction of the
// vertex and draw cost. Silhouettes stay recognisable — a spear is still a
// long stick, a horse is still a torso with a head, a skeleton still has a
// team sash — but every curved tube, bevel, and small detail mesh is gone.
//
// Cache keys are prefixed 'simple.' so the simple set never collides with
// the detailed set in the shared MeshCache. Both sets can coexist if a
// player toggles the setting mid-session; the simple set is tiny.
//
// Materials that SoldierView mutates per-frame (body HP tint, shield
// shieldHp tint) are per-instance here, exactly as their detailed
// counterparts are. Everything else is cached.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';
import { addLegs } from './LegBuilder.js';
import { mergeGeometries, partMatrix } from './MeshMerge.js';

// ---------------------------------------------------------------------------
// weapons
// ---------------------------------------------------------------------------

export function createSimpleSpear() {
  const group = new THREE.Group();
  group.position.set(0.24, 0.65, 0);

  // One tapered cylinder. The taper keeps the tip end visually distinct
  // from the grip end without needing a separate tip mesh.
  const geo = cachedGeometry('simple.spearGeo', () =>
    new THREE.CylinderGeometry(0.018, 0.028, 1.4, 5));
  const mat = cachedMaterial('simple.spearMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x8a5a24 }));

  const shaft = new THREE.Mesh(geo, mat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.6;
  group.add(shaft);
  return group;
}

// Goblin spear: same tapered shaft shape as the standard simple spear,
// only the material changes. The single-mesh simple spear has no distinct
// tip, so a darker wood colour is the whole visible difference at this
// tier — which is exactly what "a bit different" should reduce to when
// the tip geometry is already gone.
export function createSimpleGoblinSpear() {
  const group = new THREE.Group();
  group.position.set(0.24, 0.65, 0);

  const geo = cachedGeometry('simple.spearGeo', () =>
    new THREE.CylinderGeometry(0.018, 0.028, 1.4, 5));
  const mat = cachedMaterial('simple.goblinSpearMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x3f2a12 }));

  const shaft = new THREE.Mesh(geo, mat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.6;
  group.add(shaft);
  return group;
}

export function createSimpleLance() {
  const group = new THREE.Group();
  group.position.set(0.26, 0.70, 0);

  // One tapered cylinder, much longer and thinner than the spear's —
  // the length difference is what reads as a lance at battle zoom.
  const geo = cachedGeometry('simple.lanceGeo', () =>
    new THREE.CylinderGeometry(0.014, 0.028, 2.4, 5));
  const mat = cachedMaterial('simple.lanceMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x8a5a24 }));

  const shaft = new THREE.Mesh(geo, mat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.7;
  group.add(shaft);
  return group;
}

export function createSimpleSword() {
  const group = new THREE.Group();
  group.position.set(0.22, 0.65, 0);

  // One rectangular prism. Long on Z, taller than it is thick, so the
  // side profile still reads as a blade.
  const geo = cachedGeometry('simple.swordGeo', () =>
    new THREE.BoxGeometry(0.06, 0.14, 0.75));
  const mat = cachedMaterial('simple.swordMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xaaaaaa }));

  const blade = new THREE.Mesh(geo, mat);
  blade.position.z = 0.35;
  group.add(blade);
  return group;
}

export function createSimpleCrudeSword() {
  // Same idea as the standard simple sword but shorter and rustier, so a
  // goblin's silhouette still reads different from a human's.
  const group = new THREE.Group();

  const geo = cachedGeometry('simple.crudeSwordGeo', () =>
    new THREE.BoxGeometry(0.05, 0.12, 0.42));
  const mat = cachedMaterial('simple.crudeSwordMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x6a5e52 }));

  const blade = new THREE.Mesh(geo, mat);
  blade.position.z = 0.24;
  group.add(blade);
  return group;
}

export function createSimpleBow() {
  const group = new THREE.Group();
  group.position.set(0.22, 0.65, 0);

  // A C-shaped arc — a segment of a torus. The bow stands vertical in
  // the YZ plane (its hole axis along X, same plane the detailed bow's
  // limbs occupy). The CURVE of the C bulges toward +Z (forward, at the
  // target) and the OPEN side faces -Z (toward the archer) — the string
  // side of a real bow, which is where the string would run between the
  // two tips. This is the reverse of a "belly toward the target" build:
  // a bow's back (the stave) is what faces the target; the archer's
  // hand and string sit on the belly side.
  //
  // Construction, in order:
  //   TorusGeometry(radius, tube, radialSegs, tubularSegs, arc)
  //     authored in the XY plane, ring around Z, sweep starting at +X.
  //   rotateY(π/2)       moves the ring into the YZ plane; the sweep
  //                      now starts at -Z and passes through +Y toward +Z.
  //   rotateX(π - ARC/2) rotates the sweep by 180° minus its own
  //                      half-width, so the arc's midpoint lands on +Z
  //                      and the gap straddles -Z.
  //
  // Segment counts are deliberately tiny: 4 radial, 8 tubular. At battle
  // zoom the arc reads as a smooth C anyway, and this keeps the potato
  // budget honest.
  const ARC = Math.PI * 1.25; // 225° — leaves a 135° gap at the front
  const geo = cachedGeometry('simple.bowGeo', () => {
    const g = new THREE.TorusGeometry(0.24, 0.014, 4, 8, ARC);
    g.rotateY(Math.PI / 2);
    g.rotateX(Math.PI - ARC / 2);
    return g;
  });
  const mat = cachedMaterial('simple.bowMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x5a3d20 }));
  group.add(new THREE.Mesh(geo, mat));

  // Stub userData so layoutBowString and SoldierView._applyBowDraw do not
  // crash when they run against this bow. All pivots and string halves are
  // plain Object3D nodes — zero draw cost, but valid targets for the same
  // position / quaternion / rotation writes the detailed bow receives.
  const topPivot = new THREE.Object3D();
  const bottomPivot = new THREE.Object3D();
  const topString = new THREE.Object3D();
  const bottomString = new THREE.Object3D();
  const nockedArrow = new THREE.Object3D();
  topString.visible = false;
  bottomString.visible = false;
  nockedArrow.visible = false;
  group.userData.topLimbPivot = topPivot;
  group.userData.bottomLimbPivot = bottomPivot;
  group.userData.topString = topString;
  group.userData.bottomString = bottomString;
  group.userData.nockedArrow = nockedArrow;

  return group;
}

// Goblin shortbow: same torus arc as the standard simple bow, smaller
// radius and darker wood. Same Object3D userData stubs so layoutBowString
// and _applyBowDraw run unchanged.
export function createSimpleGoblinShortbow() {
  const group = new THREE.Group();
  group.position.set(0.22, 0.65, 0);

  const ARC = Math.PI * 1.25;
  const geo = cachedGeometry('simple.goblinShortbowGeo', () => {
    const g = new THREE.TorusGeometry(0.18, 0.014, 4, 8, ARC);
    g.rotateY(Math.PI / 2);
    g.rotateX(Math.PI - ARC / 2);
    return g;
  });
  const mat = cachedMaterial('simple.goblinShortbowMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x3f2a12 }));
  group.add(new THREE.Mesh(geo, mat));

  const topPivot = new THREE.Object3D();
  const bottomPivot = new THREE.Object3D();
  const topString = new THREE.Object3D();
  const bottomString = new THREE.Object3D();
  const nockedArrow = new THREE.Object3D();
  topString.visible = false;
  bottomString.visible = false;
  nockedArrow.visible = false;
  group.userData.topLimbPivot = topPivot;
  group.userData.bottomLimbPivot = bottomPivot;
  group.userData.topString = topString;
  group.userData.bottomString = bottomString;
  group.userData.nockedArrow = nockedArrow;

  return group;
}

export function createSimpleArrowProjectile() {
  // One cylinder, laid along +Z to match the detailed arrow's long axis.
  //
  // The rotation is applied to the GEOMETRY, not the mesh, and this is
  // load-bearing: ProjectileView.sync writes mesh.rotation.x/y every
  // frame from the arrow's trajectory yaw and pitch. A mesh-level
  // rotation.x = π/2 would be silently overwritten on the first sync and
  // the arrow would snap back to vertical. Baking into the geometry
  // leaves the mesh rotation entirely free for the view to drive, exactly
  // as the detailed arrow does.
  const geo = cachedGeometry('simple.arrowGeo', () => {
    const g = new THREE.CylinderGeometry(0.010, 0.010, 0.55, 4);
    g.rotateX(Math.PI / 2);
    return g;
  });
  const mat = cachedMaterial('simple.arrowMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x8a5a24 }));
  return new THREE.Mesh(geo, mat);
}

// ---------------------------------------------------------------------------
// shields
// ---------------------------------------------------------------------------

export function createSimpleShield() {
  // A flat rectangular panel. Material is per-instance — SoldierView
  // tints it toward black as shieldHp drops.
  const geo = cachedGeometry('simple.shieldGeo', () =>
    new THREE.BoxGeometry(0.44, 0.60, 0.04));
  const mat = new THREE.MeshLambertMaterial({ color: 0x8b5a2b });
  return new THREE.Mesh(geo, mat);
}

export function createSimpleGoblinShield() {
  const geo = cachedGeometry('simple.goblinShieldGeo', () =>
    new THREE.BoxGeometry(0.34, 0.34, 0.04));
  const mat = new THREE.MeshLambertMaterial({ color: 0x6a4526 });
  return new THREE.Mesh(geo, mat);
}

// ---------------------------------------------------------------------------
// helmets
// ---------------------------------------------------------------------------

// One hemisphere. Every human helmet type — roundCap, nasalHelm,
// conicalHelm, hood, plumedHelm, bandedHelm, crestedHelm — collapses to
// this same single shape in simple mode. The helmet's job at battle zoom
// is to say "this soldier is wearing something on his head"; the
// distinct silhouettes are a detail-tier concern, not a potato-tier one.
//
// Y position matches the blob head's centre (BLOB_HEAD_Y = 1.02), so the
// hemisphere seats on the head sphere the same way every detailed helmet
// does. Material is cached per body colour, so both teams' helmets are
// shared across every soldier of that team — same palette-darkening
// convention the detailed helmets use.
export function createSimpleHelmet(bodyColor) {
  const geo = cachedGeometry('simple.helmetGeo', () =>
    new THREE.SphereGeometry(0.18, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2));
  // Steel grey, matching the detailed-tier helmet change (see
  // HelmetFactory.js). bodyColor is retained for signature compatibility
  // with the detailed-tier factory and every call site, but is ignored —
  // helmets are issued kit, not team livery. Because the colour no longer
  // varies by team the cache key drops bodyColor, so both teams share the
  // one instance.
  const mat = cachedMaterial('simple.helmetMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x818186 }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 1.02;
  return mesh;
}

// ---------------------------------------------------------------------------
// bodies
// ---------------------------------------------------------------------------

export function createSimpleBlobBody(color, helmetType) {
  const group = new THREE.Group();
  // Per-instance: SoldierView tints this toward black as HP drops.
  const mat = new THREE.MeshLambertMaterial({ color });

  // Torso: one low-poly cylinder. No lathe taper — the silhouette at
  // battle zoom is dominated by the helmet and weapon anyway.
  // Torso (low-poly cylinder) + head (low-segment sphere) share one
  // material and never move relative to each other: one merged mesh.
  const bodyGeo = cachedGeometry('simple.blobBodyGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.CylinderGeometry(0.16, 0.20, 0.80, 6),
        matrix: partMatrix(0, 0.65, 0)
      },
      {
        geometry: new THREE.SphereGeometry(0.16, 6, 5),
        matrix: partMatrix(0, 1.02, 0)
      }
    ]));
  group.add(new THREE.Mesh(bodyGeo, mat));

  // Legs: shared with the detailed body — two cylinders per leg and the
  // walk cycle drives their pivots. Not worth a separate simplified build.
  addLegs(group, mat);

  // Helmet — one hemisphere regardless of the unit type's helmetType. See
  // createSimpleHelmet. Only added if the unit type actually has a helmet,
  // so a bare-headed unit still reads as bare-headed in simple mode.
  if (helmetType) group.add(createSimpleHelmet(color));

  group.userData.baseMaterial = mat;
  return group;
}

export function createSimpleSkeletonBody(color, teamColor) {
  const group = new THREE.Group();
  const boneColor = new THREE.Color(color).lerp(new THREE.Color(0xe8e0c8), 0.55);
  // Per-instance: SoldierView tints this toward black as HP drops.
  const mat = new THREE.MeshLambertMaterial({ color: boneColor });

  // Torso: one box. The ribcage read is gone; the skull and the team
  // sash carry the identity instead.
  const torsoGeo = cachedGeometry('simple.skelTorsoGeo', () =>
    new THREE.BoxGeometry(0.22, 0.52, 0.14));
  const torso = new THREE.Mesh(torsoGeo, mat);
  torso.position.y = 0.55;
  group.add(torso);

  // Skull: one low-segment sphere.
  const skullGeo = cachedGeometry('simple.skelSkullGeo', () =>
    new THREE.SphereGeometry(0.14, 5, 4));
  const skull = new THREE.Mesh(skullGeo, mat);
  skull.position.y = 1.03;
  group.add(skull);

  // Two dark eye sockets — the cheapest possible "this is a skull" cue.
  const socketMat = cachedMaterial('simple.skelSocketMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x1a1408 }));
  const socketGeo = cachedGeometry('simple.skelSocketGeo', () =>
    new THREE.BoxGeometry(0.04, 0.04, 0.02));
  for (const sx of [-0.05, 0.05]) {
    const socket = new THREE.Mesh(socketGeo, socketMat);
    socket.position.set(sx, 1.04, 0.12);
    group.add(socket);
  }

  // Team sash. MUST stay — it is the only team-identity carry on a
  // skeleton model, so removing it would make the two teams
  // indistinguishable at battle zoom.
  const sashGeo = cachedGeometry('simple.skelSashGeo', () =>
    new THREE.BoxGeometry(0.08, 0.50, 0.20));
  const sashMat = cachedMaterial(`simple.skelSashMat.${teamColor}`, () =>
    new THREE.MeshLambertMaterial({ color: teamColor }));
  const sash = new THREE.Mesh(sashGeo, sashMat);
  sash.position.y = 0.55;
  sash.rotation.z = Math.PI / 5;
  group.add(sash);

  addLegs(group, mat);

  group.userData.baseMaterial = mat;
  return group;
}

export function createSimpleGoblinBody(color) {
  const group = new THREE.Group();

  const skinColor = new THREE.Color(color).lerp(new THREE.Color(0x6a8a3a), 0.55);
  // Per-instance: SoldierView tints this toward black as HP drops.
  const mat = new THREE.MeshLambertMaterial({ color: skinColor });

  // Torso: one box, tilted forward so the goblin still reads as hunched.
  const torsoGeo = cachedGeometry('simple.goblinTorsoGeo', () =>
    new THREE.BoxGeometry(0.22, 0.44, 0.16));
  const torso = new THREE.Mesh(torsoGeo, mat);
  torso.position.y = 0.42;
  torso.rotation.x = 0.18;
  group.add(torso);

  // Head: low-segment sphere, offset forward of the torso.
  const headGeo = cachedGeometry('simple.goblinHeadGeo', () =>
    new THREE.SphereGeometry(0.13, 5, 4));
  const head = new THREE.Mesh(headGeo, mat);
  head.position.set(0, 0.72, 0.05);
  group.add(head);

  // Long nose: one small cone. Without it the head reads as a plain ball,
  // and the nose is the goblin's strongest single silhouette cue.
  const noseGeo = cachedGeometry('simple.goblinNoseGeo', () =>
    new THREE.ConeGeometry(0.04, 0.18, 5));
  const nose = new THREE.Mesh(noseGeo, mat);
  nose.position.set(0, 0.70, 0.20);
  nose.rotation.x = Math.PI / 2 + 0.4;
  group.add(nose);

  // Team-colour sash across the waist. MUST stay — the body is 55% green,
  // so the sash is where team identity survives on the model. Sized up
  // (was 0.24 × 0.06 × 0.18) so the team tell is unmistakable at battle
  // zoom on a simple-model goblin, matching the detailed model's larger
  // cloth envelope.
  const ragMat = cachedMaterial(`simple.goblinRagMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: new THREE.Color(color) }));
  const sashGeo = cachedGeometry('simple.goblinSashGeo', () =>
    new THREE.BoxGeometry(0.30, 0.12, 0.24));
  const sash = new THREE.Mesh(sashGeo, ragMat);
  sash.position.y = 0.42;
  group.add(sash);

  addSimpleGoblinLegs(group, mat);

  group.userData.baseMaterial = mat;
  return group;
}

function addSimpleGoblinLegs(group, mat) {
  const legGeo = cachedGeometry('simple.goblinLegGeo', () =>
    new THREE.CylinderGeometry(0.022, 0.022, 0.21, 4));

  const left = buildSimpleGoblinLeg(mat, legGeo, -0.06);
  group.add(left.hip);
  const right = buildSimpleGoblinLeg(mat, legGeo, 0.06);
  group.add(right.hip);

  group.userData.legLeftPivot = left.hip;
  group.userData.legRightPivot = right.hip;
  group.userData.legLeftKnee = left.knee;
  group.userData.legRightKnee = right.knee;
}

function buildSimpleGoblinLeg(mat, geo, x) {
  const hip = new THREE.Group();
  hip.position.set(x, 0.21, 0);

  const leg = new THREE.Mesh(geo, mat);
  leg.position.y = -0.105;
  hip.add(leg);

  // Zero-rotation knee group so SoldierView's mounted-pose code does not
  // have to branch on "does this body have a knee".
  const knee = new THREE.Group();
  knee.position.y = -0.21;
  hip.add(knee);

  return { hip, knee };
}

// Hobgoblin simple body: a torso box + head sphere on top, a separate
// armor box (slightly larger, dark steel) around the torso, a helmet dome,
// and a team-coloured skirt box. Taller than the goblin's because a
// hobgoblin IS taller — silhouette height is the cheapest remaining read
// at this tier.
//
// Two meshes: the skin box + head sphere merged into one (team-lerped
// green), and an armor mesh that merges the cuirass box + helmet dome
// (dark steel). The skirt is a third, team-coloured mesh. Legs shared
// with the goblin simple leg builder.
export function createSimpleHobgoblinBody(color) {
  const group = new THREE.Group();

  const skinColor = new THREE.Color(color).lerp(new THREE.Color(0x5a6a3a), 0.50);
  const mat = new THREE.MeshLambertMaterial({ color: skinColor });

  // Body + head, merged.
  const bodyGeo = cachedGeometry('simple.hobgoblinBodyGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.BoxGeometry(0.30, 0.60, 0.20),
        matrix: partMatrix(0, 0.55, 0)
      },
      {
        geometry: new THREE.SphereGeometry(0.15, 6, 5),
        matrix: partMatrix(0, 0.95, 0.03)
      }
    ]));
  group.add(new THREE.Mesh(bodyGeo, mat));

  // Armor: a cuirass box (proud of the torso) + helmet dome. No nasal
  // guard — the hobgoblin's nose protrudes below the helmet dome in every
  // tier, and a guard plate would intersect it. See HobgoblinArmor.js.
  const metalMat = cachedMaterial('simple.hobgoblinMetalMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x50505a }));
  const armorGeo = cachedGeometry('simple.hobgoblinArmorGeo', () =>
    mergeGeometries([
      {
        geometry: new THREE.BoxGeometry(0.34, 0.40, 0.24),
        matrix: partMatrix(0, 0.62, 0)
      },
      {
        geometry: new THREE.SphereGeometry(0.17, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2),
        matrix: partMatrix(0, 0.95, 0.03)
      }
    ]));
  group.add(new THREE.Mesh(armorGeo, metalMat));

  // Team-coloured skirt below the cuirass.
  const skirtMat = cachedMaterial(`simple.hobgoblinSkirtMat.${color}`, () =>
    new THREE.MeshLambertMaterial({ color: new THREE.Color(color) }));
  const skirtGeo = cachedGeometry('simple.hobgoblinSkirtGeo', () =>
    new THREE.BoxGeometry(0.32, 0.14, 0.24));
  const skirt = new THREE.Mesh(skirtGeo, skirtMat);
  skirt.position.y = 0.36;
  group.add(skirt);

  // Shared goblin leg builder — same two-piece pivot contract, hobgoblin
  // proportions.
  const legGeo = cachedGeometry('simple.hobgoblinLegGeo', () =>
    new THREE.CylinderGeometry(0.028, 0.028, 0.30, 4));

  for (const x of [-0.075, 0.075]) {
    const hip = new THREE.Group();
    hip.position.set(x, 0.30, 0);
    const leg = new THREE.Mesh(legGeo, mat);
    leg.position.y = -0.15;
    hip.add(leg);

    const knee = new THREE.Group();
    knee.position.y = -0.30;
    hip.add(knee);

    group.add(hip);
    if (x < 0) {
      group.userData.legLeftPivot = hip;
      group.userData.legLeftKnee = knee;
    } else {
      group.userData.legRightPivot = hip;
      group.userData.legRightKnee = knee;
    }
  }

  group.userData.baseMaterial = mat;
  return group;
}

// ---------------------------------------------------------------------------
// mounts
// ---------------------------------------------------------------------------

// Simple flesh horse: box torso, box head, four leg pivots. The legs
// still swing on their pivots so the trot cycle runs, but there is no
// neck, mane, tail, or ear geometry at this tier.
function buildSimpleFleshHorse() {
  const group = new THREE.Group();
  const mat = cachedMaterial('simple.horseMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x4a2f1a }));

  // Torso: one box. The flesh horse reads as a barrel on legs, so a box
  // is correct here — the skeleton variant below is the one that needs
  // a thin spine.
  const torsoGeo = cachedGeometry('simple.horse.torsoGeo', () =>
    new THREE.BoxGeometry(0.36, 0.36, 0.90));
  const torso = new THREE.Mesh(torsoGeo, mat);
  torso.position.y = 0.42;
  group.add(torso);

  // Head + neck: one box, tilted forward off the front of the torso.
  const headGeo = cachedGeometry('simple.horse.headGeo', () =>
    new THREE.BoxGeometry(0.18, 0.22, 0.44));
  const head = new THREE.Mesh(headGeo, mat);
  head.position.set(0, 0.68, 0.42);
  head.rotation.x = 0.30;
  group.add(head);

  // Four legs, single-cylinder each, on pivots so the trot cycle can
  // still swing them.
  const legGeo = cachedGeometry('simple.horse.legGeo', () =>
    new THREE.CylinderGeometry(0.03, 0.025, 0.32, 4));
  const horseLegs = {};
  for (const lx of [-0.1, 0.1]) {
    for (const lz of [-0.18, 0.18]) {
      const pivot = new THREE.Group();
      pivot.position.set(lx, 0.32, lz);
      const leg = new THREE.Mesh(legGeo, mat);
      leg.position.y = -0.16;
      pivot.add(leg);
      group.add(pivot);

      const end = lz > 0 ? 'f' : 'b';
      const side = lx < 0 ? 'l' : 'r';
      horseLegs[end + side] = pivot;
    }
  }
  group.userData.horseLegs = horseLegs;

  group.scale.setScalar(1.4);
  group.userData.riderMountHeight = 0.50;
  return group;
}

// Simple skeleton horse: thin spine + four leg-connection plates + thin
// head + thin legs.
//
// The previous build reused the flesh horse's box torso with a 0.65
// cross-section scale, which still produced a box roughly 1.5x the
// detailed skeleton horse's ribcage width — the "bulky skeleton horse"
// failure. This build starts from the detailed silhouette — a bare
// spine with plate-like pelvis/scapula bones bridging down to each leg
// pivot — and simplifies it, rather than shrinking a flesh-horse box.
//
// The four plates are the important change: they CONNECT the legs to
// the body. A thin spine on its own leaves the leg pivots (at X=±0.10)
// visually detached from a body only 0.04 half-width wide. Each plate
// bridges the gap exactly the way SkeletonHorseBuilder's pelvis and
// scapula plates do, at one box per leg instead of plate + socket.
//
// Everything except the torso and head geometry matches the flesh
// build byte-for-byte: leg pivot positions, leg mesh offset, group
// scale, and riderMountHeight are identical, so the trot cycle and
// rider seating read the same across variants.
function buildSimpleSkeletonHorse() {
  const group = new THREE.Group();
  const mat = cachedMaterial('simple.skelHorseMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xe8e0c8 }));

  // Static bone structure: spine + four leg-connection plates + head,
  // merged into one mesh. Same material, rigidly attached — one draw
  // call covers all six parts.
  //
  // Plate maths: spine sits at y=0.44 with half-width 0.04, so its
  // lower side edge is at (x=±0.04, y=0.40). Leg pivots sit at
  // (±0.10, 0.32). A plate 0.20 long tilted 0.55 rad around Z bridges
  // from (≈0.003, 0.465) at its top to (≈0.107, 0.295) at its bottom —
  // top buried in the spine, bottom covering the top of the leg.
  // rotation.z sign matches: +X side leans outward on the way down,
  // -X side mirrors.
  const boneGeo = cachedGeometry('simple.skelHorse.boneGeo', () =>
    mergeGeometries([
      {
        // Spine spans from the front-leg row to just past the rear-leg
        // row — matches SkeletonHorseBuilder's SPINE_FRONT_Z (0.26) /
        // SPINE_BACK_Z (-0.32). The previous 0.88 length stuck out
        // well past both leg rows and read as a long bar rather than
        // a spine, making the mount look detached from its legs.
        geometry: new THREE.BoxGeometry(0.08, 0.08, 0.58),
        matrix: partMatrix(0, 0.44, -0.03)
      },
      {
        geometry: new THREE.BoxGeometry(0.04, 0.20, 0.06),
        matrix: partMatrix(-0.055, 0.38, -0.18, 0, 0, -0.55)
      },
      {
        geometry: new THREE.BoxGeometry(0.04, 0.20, 0.06),
        matrix: partMatrix(0.055, 0.38, -0.18, 0, 0, 0.55)
      },
      {
        geometry: new THREE.BoxGeometry(0.04, 0.20, 0.06),
        matrix: partMatrix(-0.055, 0.38, 0.18, 0, 0, -0.55)
      },
      {
        geometry: new THREE.BoxGeometry(0.04, 0.20, 0.06),
        matrix: partMatrix(0.055, 0.38, 0.18, 0, 0, 0.55)
      },
      {
        // Head: matches the detailed tier's skull proportions
        // (SkeletonHorseBuilder.addSkull: ~0.08 wide, ~0.09 tall, 0.30
        // long). The previous 0.10 × 0.14 × 0.42 box was ~40% oversized
        // in every dimension and dominated the thin spine.
        geometry: new THREE.BoxGeometry(0.075, 0.10, 0.30),
        matrix: partMatrix(0, 0.68, 0.42, 0.30, 0, 0)
      }
    ]));
  group.add(new THREE.Mesh(boneGeo, mat));

  // Legs: thin bone cylinders on the same pivots as the flesh mount.
  // Same pivot positions so the trot cycle and rider seating are
  // identical across variants and across LOD tiers.
  const legGeo = cachedGeometry('simple.skelHorse.legGeo', () =>
    new THREE.CylinderGeometry(0.016, 0.013, 0.32, 4));
  const horseLegs = {};
  for (const lx of [-0.1, 0.1]) {
    for (const lz of [-0.18, 0.18]) {
      const pivot = new THREE.Group();
      pivot.position.set(lx, 0.32, lz);
      const leg = new THREE.Mesh(legGeo, mat);
      leg.position.y = -0.16;
      pivot.add(leg);
      group.add(pivot);

      const end = lz > 0 ? 'f' : 'b';
      const side = lx < 0 ? 'l' : 'r';
      horseLegs[end + side] = pivot;
    }
  }
  group.userData.horseLegs = horseLegs;

  group.scale.setScalar(1.4);
  group.userData.riderMountHeight = 0.50;
  return group;
}

export function createSimpleHorseBase() {
  return buildSimpleFleshHorse();
}

export function createSimpleSkeletonHorseBase() {
  return buildSimpleSkeletonHorse();
}

export function createSimpleHorseHead() {
  // Icon accent. One box, muzzle forward on +Z, matching the detailed
  // head's orientation contract (UnitIconComposer rotates it +90° on Y).
  const group = new THREE.Group();
  const mat = cachedMaterial('simple.horseHeadMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x4a2f1a }));
  const geo = cachedGeometry('simple.horseHeadIconGeo', () =>
    new THREE.BoxGeometry(0.18, 0.20, 0.42));
  group.add(new THREE.Mesh(geo, mat));
  return group;
}

// Quivers are removed entirely in simple mode. Rather than branching at
// every call site, this returns an empty Group: the composer still
// parents something to the body (no null checks needed), and the empty
// group issues zero draw calls and has no children. A player who never
// looks at the archer's back cannot tell the difference at battle zoom.
export function createSimpleQuiver() {
  return new THREE.Group();
}

export function createSimpleSkull() {
  // Icon accent. A box cranium plus two dark sockets.
  const group = new THREE.Group();

  const boneMat = cachedMaterial('simple.skullBoneMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xe8e0c8 }));
  const craniumGeo = cachedGeometry('simple.skullCraniumGeo', () =>
    new THREE.BoxGeometry(0.24, 0.22, 0.22));
  group.add(new THREE.Mesh(craniumGeo, boneMat));

  const socketMat = cachedMaterial('simple.skullSocketMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x1a1408 }));
  const socketGeo = cachedGeometry('simple.skullSocketGeo', () =>
    new THREE.BoxGeometry(0.05, 0.05, 0.02));
  for (const sx of [-0.05, 0.05]) {
    const socket = new THREE.Mesh(socketGeo, socketMat);
    socket.position.set(sx, 0, 0.11);
    group.add(socket);
  }
  return group;
}