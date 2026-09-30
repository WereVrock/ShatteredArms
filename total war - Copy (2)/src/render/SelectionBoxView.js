// A simple screen-space DOM rectangle overlay for drag-select, drawn over the
// canvas. Pure UI element — no sim/camera logic.
export class SelectionBoxView {
  constructor(containerElement) {
    this.el = document.createElement('div');
    this.el.style.position = 'absolute';
    this.el.style.border = '1px solid #4caf50';
    this.el.style.background = 'rgba(76, 175, 80, 0.15)';
    this.el.style.pointerEvents = 'none';
    this.el.style.display = 'none';
    this.el.style.zIndex = '5';
    containerElement.appendChild(this.el);
  }

  show(startX, startY, endX, endY) {
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.style.width = `${width}px`;
    this.el.style.height = `${height}px`;
    this.el.style.display = 'block';
  }

  hide() {
    this.el.style.display = 'none';
  }
}