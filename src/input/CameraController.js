// Handles camera controls, all relative to the camera's current facing:
// - Middle-drag: orbit
// - LMB+RMB held together: pan-drag (hides cursor while active)
// - WASD/arrows: pan relative to camera's current yaw
// - Scroll: zoom
// Vertical pan (mouse-drag Y and W/S) is inverted per user preference: dragging
// up / pressing W moves the view forward into the screen (feels like pulling
// the world toward you), matching the requested reversed convention.
export class CameraController {
  constructor(canvas, sceneSetup) {
    this.canvas = canvas;
    this.sceneSetup = sceneSetup;

    this.isOrbiting = false;
    this.lastX = 0;
    this.lastY = 0;

    this.leftDown = false;
    this.rightDown = false;
    this.isPanDragging = false;
    this.panLastX = 0;
    this.panLastY = 0;

    this.keysDown = new Set();

    this._bindEvents();
  }

  _bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.leftDown = true;
      if (e.button === 2) this.rightDown = true;

      if (e.button === 1) {
        this.isOrbiting = true;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        e.preventDefault();
      }

      if (this.leftDown && this.rightDown && !this.isPanDragging) {
        this.isPanDragging = true;
        this.panLastX = e.clientX;
        this.panLastY = e.clientY;
        this.canvas.style.cursor = 'none';
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.leftDown = false;
      if (e.button === 2) this.rightDown = false;
      if (e.button === 1) this.isOrbiting = false;

      if (!(this.leftDown && this.rightDown) && this.isPanDragging) {
        this.isPanDragging = false;
        this.canvas.style.cursor = '';
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isOrbiting) {
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.sceneSetup.orbitCamera(-dx * 0.005, dy * 0.003);
        return;
      }

      if (this.isPanDragging) {
        const dx = e.clientX - this.panLastX;
        const dy = e.clientY - this.panLastY;
        this.panLastX = e.clientX;
        this.panLastY = e.clientY;
        // Y inverted per request: was `dy * 0.02`, now `-dy * 0.02`.
        this._panRelativeToCamera(-dx * 0.02, -dy * 0.02);
      }
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.sceneSetup.zoomCamera(e.deltaY * 0.01);
    }, { passive: false });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => this.keysDown.add(e.key.toLowerCase()));
    window.addEventListener('keyup', (e) => this.keysDown.delete(e.key.toLowerCase()));
  }

  _panRelativeToCamera(rightAmount, forwardAmount) {
    const yaw = this.sceneSetup.cameraYaw;
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);

    this.sceneSetup.panCamera(
      rightX * rightAmount + forwardX * forwardAmount,
      rightZ * rightAmount + forwardZ * forwardAmount
    );
  }

  update(deltaSeconds) {
    const panSpeed = 10 * deltaSeconds;
    let right = 0, forward = 0;

    // W/S inverted per request: was forward += / -=, now swapped.
    if (this.keysDown.has('w') || this.keysDown.has('arrowup')) forward -= panSpeed;
    if (this.keysDown.has('s') || this.keysDown.has('arrowdown')) forward += panSpeed;
    if (this.keysDown.has('a') || this.keysDown.has('arrowleft')) right -= panSpeed;
    if (this.keysDown.has('d') || this.keysDown.has('arrowright')) right += panSpeed;

    if (right !== 0 || forward !== 0) {
      this._panRelativeToCamera(right, forward);
    }
  }
}