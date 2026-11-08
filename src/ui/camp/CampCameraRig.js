// ===== CampCameraRig.js =====
// Camera framing for the camp backdrop.
//
// The camp is built as two clusters at x = +/-CAMP_CLUSTER_X with an open
// avenue between them, because the menu panel (max 720 px, centred) covers
// the middle of the screen. configure() solves the camera distance so the
// clusters land in the free bands left and right of the panel, for any
// window size. update() adds a slow sway so the camp is not a dead still.
// The camera is kept low enough that mountains and sky stay in frame.

import { clamp } from './CampMath.js';

export const CAMP_CLUSTER_X = 10;

const FOV = 44;
const CAMERA_HEIGHT = 4.4;
const LOOK = { x: 0, y: 2.2, z: -0.5 };
const SWAY_RAD = 0.2;
const SWAY_SPEED = 0.28;
const PANEL_MAX_PX = 720;
const GUTTER_PX = 16;

export class CampCameraRig {
constructor(camera) {
this.camera = camera;
this.distance = 22;
camera.fov = FOV;
camera.updateProjectionMatrix();
}

// width / height of the rendered area in CSS px.
configure(width, height) {
const aspect = width / Math.max(1, height);
const panelHalf = Math.min(PANEL_MAX_PX, width * 0.9) / 2;
const bandInner = panelHalf + GUTTER_PX;
const bandOuter = width / 2 - GUTTER_PX / 2;
const mid = Math.max(bandInner + 40, (bandInner + bandOuter) / 2);
const ndc = clamp(mid / (width / 2), 0.45, 0.95);
const tanV = Math.tan((FOV * Math.PI / 180) / 2);
this.distance = clamp(CAMP_CLUSTER_X / (ndc * tanV * aspect), 15, 64);
this.camera.aspect = aspect;
this.camera.updateProjectionMatrix();
}

update(time, sway = true) {
const a = sway ? Math.sin(time * SWAY_SPEED) * SWAY_RAD : 0;
const h = CAMERA_HEIGHT + (sway ? Math.sin(time * 0.17) * 0.4 : 0);
this.camera.position.set(
LOOK.x + Math.sin(a) * this.distance,
h,
LOOK.z + Math.cos(a) * this.distance
);
this.camera.lookAt(LOOK.x, LOOK.y, LOOK.z);
}
}