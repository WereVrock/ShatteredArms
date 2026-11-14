// Heightmap stored at cell CORNERS: (cols + 1) x (rows + 1) vertices.
// Bilinear sampling returns height and gradient in one allocation-free call.
export class HeightField {
  constructor(bounds, cellSize) {
    this.bounds = bounds;
    this.cellSize = cellSize;
    this._inv = 1 / cellSize;
    this.cols = Math.ceil((bounds.maxX - bounds.minX) * this._inv);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) * this._inv);
    this.vertCols = this.cols + 1;
    this.vertRows = this.rows + 1;
    this.data = new Float32Array(this.vertCols * this.vertRows);
    // True once any vertex is non-zero. Systems skip all slope work when false.
    this.nonFlat = false;
    this._scratch = { h: 0, gx: 0, gz: 0 };
  }

  getVertex(ix, iz) { return this.data[iz * this.vertCols + ix]; }

  setVertex(ix, iz, h) { this.data[iz * this.vertCols + ix] = h; }

  refreshFlatFlag() {
    const d = this.data;
    let nonFlat = false;
    for (let i = 0; i < d.length; i++) {
      if (d[i] > 1e-4 || d[i] < -1e-4) { nonFlat = true; break; }
    }
    this.nonFlat = nonFlat;
  }

  // Fills out.h (height), out.gx / out.gz (dh/dx, dh/dz). Returns out.
  sample(x, z, out = this._scratch) {
    const inv = this._inv;
    let fx = (x - this.bounds.minX) * inv;
    let fz = (z - this.bounds.minZ) * inv;
    if (fx < 0) fx = 0; else if (fx > this.cols) fx = this.cols;
    if (fz < 0) fz = 0; else if (fz > this.rows) fz = this.rows;
    let ix = fx | 0;
    let iz = fz | 0;
    if (ix >= this.cols) ix = this.cols - 1;
    if (iz >= this.rows) iz = this.rows - 1;
    const tx = fx - ix;
    const tz = fz - iz;
    const d = this.data;
    const vc = this.vertCols;
    const i = iz * vc + ix;
    const h00 = d[i], h10 = d[i + 1], h01 = d[i + vc], h11 = d[i + vc + 1];
    const top = h00 + (h10 - h00) * tx;
    const bot = h01 + (h11 - h01) * tx;
    out.h = top + (bot - top) * tz;
    out.gx = ((h10 - h00) * (1 - tz) + (h11 - h01) * tz) * inv;
    out.gz = (bot - top) * inv;
    return out;
  }

  heightAt(x, z) {
    return this.sample(x, z, this._scratch).h;
  }

  // Rise over run along the unit direction (dx, dz). Positive = uphill.
  slopeAlong(x, z, dx, dz) {
    const s = this.sample(x, z, this._scratch);
    return s.gx * dx + s.gz * dz;
  }

  // 3x3 blur of the vertex block, `passes` times. Borders are left alone.
  smooth(ix0, ix1, iz0, iz1, passes) {
    const d = this.data;
    const vc = this.vertCols;
    const tmp = new Float32Array(d.length);
    const loX = Math.max(1, ix0), hiX = Math.min(this.vertCols - 2, ix1);
    const loZ = Math.max(1, iz0), hiZ = Math.min(this.vertRows - 2, iz1);
    for (let p = 0; p < passes; p++) {
      tmp.set(d);
      for (let iz = loZ; iz <= hiZ; iz++) {
        for (let ix = loX; ix <= hiX; ix++) {
          const i = iz * vc + ix;
          d[i] = (tmp[i] * 4 + tmp[i - 1] + tmp[i + 1] + tmp[i - vc] + tmp[i + vc]) * 0.125;
        }
      }
    }
  }
}