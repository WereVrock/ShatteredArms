// ===== src/render/mesh/MegabowBuilder.js =====
// Goblin megabowman weapon: an over-engineered triple-prod crossbow, built
// at GOBLIN scale (the stock is about as long as a goblin is tall, 0.84).
// Carried by the crew CARRIER on a harness (see MegabowHarnessBuilder);
// operated by the SHOOTER.
//
// BOW FRAME
// The model is authored in its own frame: +Z is the firing direction,
// the stock is centred on the origin (z -0.42 .. +0.42), the winch
// mechanism sits at the rear, the three prods at the front, and +Y is the
// "top" prod side. The harness mount rotates this frame so +Z points UP at
// rest (bow upright on the carrier's back) and tilts it forward over the
// head to fire.
//
// THE THREE PRODS
// Top and bottom prods curve forward. The middle prod is REVERSED (curves
// back toward the shooter), the mixed-limb counter-bow layout.
//
// ANIMATION (two independent drivers)
//   layoutMegabowDraw(group, p)    draw cycle: prods flex, strings tighten,
//                                  bolt slides back, gears wind.
//   layoutMegabowDeploy(...)       deployment: hinge tilt / yaw and the
//                                  slide of the bow through the carriage.
import * as THREE from 'three';
import { cachedGeometry, cachedMaterial } from './MeshCache.js';

// --- stock -----------------------------------------------------------
const STOCK_WIDTH = 0.034;
const STOCK_HEIGHT = 0.044;
const STOCK_LENGTH = 0.84;
const STOCK_HALF = STOCK_LENGTH / 2;

// --- mechanism (rear) ------------------------------------------------
const MECH_WIDTH = 0.07;
const MECH_HEIGHT = 0.085;
const MECH_LENGTH = 0.16;
const MECH_Z = -STOCK_HALF + MECH_LENGTH / 2;

const GEAR_RADIUS = 0.042;
const GEAR_THICKNESS = 0.012;
const CRANK_RADIUS = 0.006;
const CRANK_LENGTH = 0.06;

// --- three prods -----------------------------------------------------
const PROD_Y_OFFSETS = [0.055, 0.0, -0.055];
const PROD_SPAN = 0.30;
const PROD_MOUNT_Z = 0.22;
const PROD_BULGE = 0.028;
const PROD_BULGE_REVERSED = 0.045;
const REVERSED_PROD_INDEX = 1;
const PROD_TUBE_RADIUS = 0.008;

// --- nock / strings --------------------------------------------------
const NOCK_REST_Z = 0.20;
const NOCK_DRAW_Z = -0.12;
const MAX_LIMB_ANGLE = 0.6;

// --- bolt ------------------------------------------------------------
const BOLT_RADIUS = 0.008;
const BOLT_MAX_LENGTH = 0.42;
const BOLT_TIP_Z = 0.40;
const BOLT_Y = 0.03;
const BOLT_HEAD_LENGTH = 0.05;

// --- hinge attachment ------------------------------------------------
// Stock coordinate (bow frame) that sits in the hinge carriage. At rest the
// carriage holds the FRONT of the stock, so the bow hangs down the carrier's
// back; when deployed it slides to the stock's middle so the bow balances
// over the head. REST_TILT leans the bottom of the bow slightly away from
// the carrier's back.
const HINGE_REST_Z = 0.34;
const HINGE_FIRE_Z = 0.02;
const REST_TILT_RAD = 0.12;

// ========================================================================

export function createMegabow() {
  const group = new THREE.Group();

  const woodMat = cachedMaterial('megabow.woodMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x3a2410 }));
  const metalMat = cachedMaterial('megabow.metalMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x777777 }));
  const darkMetalMat = cachedMaterial('megabow.darkMetalMat', () =>
    new THREE.MeshLambertMaterial({ color: 0x2a2a2a }));
  const stringMat = cachedMaterial('megabow.stringMat', () =>
    new THREE.MeshLambertMaterial({ color: 0xe0e0e0 }));

  // 1. Stock and bolt track
  const stockGeo = cachedGeometry('megabow.stockGeo', () =>
    new THREE.BoxGeometry(STOCK_WIDTH, STOCK_HEIGHT, STOCK_LENGTH));
  group.add(new THREE.Mesh(stockGeo, woodMat));

  const trackGeo = cachedGeometry('megabow.trackGeo', () =>
    new THREE.BoxGeometry(0.02, 0.012, 0.50));
  const track = new THREE.Mesh(trackGeo, darkMetalMat);
  track.position.set(0, STOCK_HEIGHT / 2 + 0.006, 0.12);
  group.add(track);

  // 2. Mechanism housing (rear)
  const mechGeo = cachedGeometry('megabow.mechGeo', () =>
    new THREE.BoxGeometry(MECH_WIDTH, MECH_HEIGHT, MECH_LENGTH));
  const mech = new THREE.Mesh(mechGeo, darkMetalMat);
  mech.position.z = MECH_Z;
  group.add(mech);

  // 3. Gears and cranks
  const gearGeo = cachedGeometry('megabow.gearGeo', () => {
    const g = new THREE.CylinderGeometry(GEAR_RADIUS, GEAR_RADIUS, GEAR_THICKNESS, 8);
    g.rotateZ(Math.PI / 2);
    return g;
  });
  const gearOffset = MECH_WIDTH / 2 + GEAR_THICKNESS / 2;
  const gearLeft = new THREE.Mesh(gearGeo, metalMat);
  gearLeft.position.set(-gearOffset, 0, MECH_Z);
  group.add(gearLeft);
  const gearRight = new THREE.Mesh(gearGeo, metalMat);
  gearRight.position.set(gearOffset, 0, MECH_Z);
  group.add(gearRight);

  const crankGeo = cachedGeometry('megabow.crankGeo', () => {
    const g = new THREE.CylinderGeometry(CRANK_RADIUS, CRANK_RADIUS, CRANK_LENGTH, 5);
    g.rotateZ(Math.PI / 2);
    g.translate(CRANK_LENGTH / 2, 0, 0);
    return g;
  });
  const crankLeft = new THREE.Mesh(crankGeo, metalMat);
  crankLeft.position.set(-gearOffset - GEAR_THICKNESS / 2, 0, MECH_Z);
  group.add(crankLeft);
  const crankRight = new THREE.Mesh(crankGeo, metalMat);
  crankRight.position.set(gearOffset + GEAR_THICKNESS / 2, 0, MECH_Z);
  group.add(crankRight);

  // 4. Three prods (top, middle-reversed, bottom)
  const normalLeftGeo = cachedGeometry('megabow.limbGeo.normalLeft', () => buildLimbGeometry(-PROD_SPAN, PROD_BULGE));
  const normalRightGeo = cachedGeometry('megabow.limbGeo.normalRight', () => buildLimbGeometry(PROD_SPAN, PROD_BULGE));
  const reversedLeftGeo = cachedGeometry('megabow.limbGeo.reversedLeft', () => buildLimbGeometry(-PROD_SPAN, -PROD_BULGE_REVERSED));
  const reversedRightGeo = cachedGeometry('megabow.limbGeo.reversedRight', () => buildLimbGeometry(PROD_SPAN, -PROD_BULGE_REVERSED));
  const capGeo = cachedGeometry('megabow.tipCapGeo', () => {
    const g = new THREE.CylinderGeometry(0.012, 0.012, 0.03, 5);
    g.rotateZ(Math.PI / 2);
    return g;
  });

  const prodPivots = [];
  for (let i = 0; i < PROD_Y_OFFSETS.length; i++) {
    const prodY = PROD_Y_OFFSETS[i];
    const isReversed = (i === REVERSED_PROD_INDEX);

    const leftPivot = new THREE.Group();
    leftPivot.position.set(0, prodY, PROD_MOUNT_Z);
    leftPivot.add(new THREE.Mesh(isReversed ? reversedLeftGeo : normalLeftGeo, woodMat));
    const leftCap = new THREE.Mesh(capGeo, metalMat);
    leftCap.position.set(-PROD_SPAN, 0, 0);
    leftPivot.add(leftCap);
    group.add(leftPivot);

    const rightPivot = new THREE.Group();
    rightPivot.position.set(0, prodY, PROD_MOUNT_Z);
    rightPivot.add(new THREE.Mesh(isReversed ? reversedRightGeo : normalRightGeo, woodMat));
    const rightCap = new THREE.Mesh(capGeo, metalMat);
    rightCap.position.set(PROD_SPAN, 0, 0);
    rightPivot.add(rightCap);
    group.add(rightPivot);

    prodPivots.push({ left: leftPivot, right: rightPivot, reversed: isReversed });
  }

  // 5. Strings and nock block
  const stringGeo = cachedGeometry('megabow.stringGeo', () =>
    new THREE.CylinderGeometry(0.004, 0.004, 1.0, 4));
  const prodStrings = [];
  for (let i = 0; i < PROD_Y_OFFSETS.length; i++) {
    const leftStr = new THREE.Mesh(stringGeo, stringMat);
    const rightStr = new THREE.Mesh(stringGeo, stringMat);
    group.add(leftStr);
    group.add(rightStr);
    prodStrings.push({ left: leftStr, right: rightStr });
  }

  const nockBlockGeo = cachedGeometry('megabow.nockBlockGeo', () =>
    new THREE.BoxGeometry(0.04, 0.05, 0.07));
  const nockBlock = new THREE.Mesh(nockBlockGeo, metalMat);
  group.add(nockBlock);

  // 6. Bolt: shaft of unit length (scaled on Z by the layout) plus a head.
  const boltGeo = cachedGeometry('megabow.boltGeo', () => {
    const g = new THREE.CylinderGeometry(BOLT_RADIUS, BOLT_RADIUS, 1, 6);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, 0.5);
    return g;
  });
  const bolt = new THREE.Mesh(boltGeo, woodMat);
  bolt.visible = false;
  group.add(bolt);

  const boltHeadGeo = cachedGeometry('megabow.boltHeadGeo', () => {
    const g = new THREE.ConeGeometry(0.018, BOLT_HEAD_LENGTH, 6);
    g.rotateX(Math.PI / 2);
    return g;
  });
  const boltHead = new THREE.Mesh(boltHeadGeo, metalMat);
  boltHead.visible = false;
  group.add(boltHead);

  // userData contract for the animation drivers
  group.userData.prodPivots = prodPivots;
  group.userData.prodStrings = prodStrings;
  group.userData.prodYs = PROD_Y_OFFSETS.slice();
  group.userData.prodSpan = PROD_SPAN;
  group.userData.prodMountZ = PROD_MOUNT_Z;
  group.userData.maxLimbAngle = MAX_LIMB_ANGLE;
  group.userData.nockRestZ = NOCK_REST_Z;
  group.userData.nockDrawZ = NOCK_DRAW_Z;
  group.userData.nockBlock = nockBlock;
  group.userData.bolt = bolt;
  group.userData.boltHead = boltHead;
  group.userData.boltMaxLength = BOLT_MAX_LENGTH;
  group.userData.boltTipZ = BOLT_TIP_Z;
  group.userData.boltY = BOLT_Y;
  group.userData.gearLeft = gearLeft;
  group.userData.gearRight = gearRight;
  group.userData.crankLeft = crankLeft;
  group.userData.crankRight = crankRight;
  group.userData.hingeRestZ = HINGE_REST_Z;
  group.userData.hingeFireZ = HINGE_FIRE_Z;
  group.userData.restTilt = REST_TILT_RAD;

  layoutMegabowDraw(group, 0);

  return group;
}

// One limb's baked curve. A negative `bulge` bows the limb backwards
// (the reversed prod).
function buildLimbGeometry(xDir, bulge) {
  const points = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(xDir * 0.55, 0, bulge),
    new THREE.Vector3(xDir, 0, 0)
  ];
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, 8, PROD_TUBE_RADIUS, 5, false);
}

const _UP = new THREE.Vector3(0, 1, 0);
const _DIR = new THREE.Vector3();

// Draw cycle. As p goes 0 -> 1 the limbs flex back, strings tighten, the
// bolt slides back and the gears wind.
export function layoutMegabowDraw(group, drawProgress) {
  if (!group || !group.userData || !group.userData.prodPivots) return;

  const p = Math.max(0, Math.min(1, drawProgress));
  const ud = group.userData;

  const a = p * ud.maxLimbAngle;
  const cosA = Math.cos(a);
  const sinA = Math.sin(a);
  const nockZ = ud.nockRestZ + (ud.nockDrawZ - ud.nockRestZ) * p;

  for (let i = 0; i < ud.prodPivots.length; i++) {
    const prod = ud.prodPivots[i];
    const strings = ud.prodStrings[i];
    const prodY = ud.prodYs[i];

    prod.left.rotation.y = -a;
    prod.right.rotation.y = a;

    const leftTipX = -ud.prodSpan * cosA;
    const rightTipX = ud.prodSpan * cosA;
    const tipZ = ud.prodMountZ - ud.prodSpan * sinA;

    layoutStringHalf(strings.left, leftTipX, prodY, tipZ, 0, 0, nockZ);
    layoutStringHalf(strings.right, 0, 0, nockZ, rightTipX, prodY, tipZ);
  }

  ud.nockBlock.position.set(0, 0, nockZ);

  // The bolt rides the rail: its tail follows the nock, its tip stays near
  // the front of the stock.
  const showBolt = p > 0.05;
  const boltLen = Math.max(0.05, Math.min(ud.boltMaxLength, ud.boltTipZ - nockZ));
  ud.bolt.visible = showBolt;
  ud.bolt.position.set(0, ud.boltY, nockZ);
  ud.bolt.scale.set(1, 1, boltLen);
  ud.boltHead.visible = showBolt;
  ud.boltHead.position.set(0, ud.boltY, nockZ + boltLen - BOLT_HEAD_LENGTH / 2);

  const rot = p * Math.PI * 6;
  ud.gearLeft.rotation.x = rot;
  ud.gearRight.rotation.x = rot;
  ud.crankLeft.rotation.x = rot;
  ud.crankRight.rotation.x = rot;
}

// Deployment. deploy 0 = bow upright on the carrier's back, 1 = tipped
// forward over the head and aimed.
//   group   the bow (the harness mount's child)
//   hinge   the harness hinge pivot
//   aimPitch  elevation of the muzzle above the horizon (radians)
//   aimYaw    muzzle yaw relative to the carrier's facing (radians)
export function layoutMegabowDeploy(group, hinge, deploy, aimPitch, aimYaw) {
  if (!group || !group.userData || group.userData.hingeRestZ === undefined || !hinge) return;
  const ud = group.userData;

  const d = Math.max(0, Math.min(1, deploy));
  const e = d * d * (3 - 2 * d);

  // Slide the bow through the carriage along its own axis.
  group.position.set(0, 0, -(ud.hingeRestZ + (ud.hingeFireZ - ud.hingeRestZ) * e));

  const fireTilt = Math.PI / 2 - aimPitch;
  hinge.rotation.x = ud.restTilt + (fireTilt - ud.restTilt) * e;
  hinge.rotation.y = aimYaw * e;
}

function layoutStringHalf(mesh, ax, ay, az, bx, by, bz) {
  _DIR.set(bx - ax, by - ay, bz - az);
  const len = _DIR.length();
  if (len < 1e-5) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;
  _DIR.multiplyScalar(1 / len);
  mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  mesh.quaternion.setFromUnitVectors(_UP, _DIR);
  mesh.scale.set(1, len, 1);
}