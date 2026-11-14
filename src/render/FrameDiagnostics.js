import { RenderBisect } from './RenderBisect.js';

// Frame / tick profiler, extracted from main.js. Wraps the renderer's per-frame
// sync and render calls, keeps a rolling window of timings and prints a summary
// every LOG_EVERY frames. Also installs window.__diag (draw-call census,
// material census, bisect, flicker audit).
//
// Only attached while main.js has RENDER_DIAG_ENABLED = true. With the flag off
// this module is imported but never constructed, so ordinary play is silent.
//
// main.js owns the loop and feeds loopTimings through recordLoop(), exactly as
// the old inline block did (pre / tick / post section timings per frame).

const WINDOW = 120;    // samples kept (~4 s at 30 fps)
const LOG_EVERY = 60;  // frames between log lines

function push(arr, v) {
  arr.push(v);
  if (arr.length > WINDOW) arr.shift();
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function p95(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

export class FrameDiagnostics {
  // getSimulation is a callback because the simulation is created after the
  // renderer in startScenario.
  static attach(options) {
    return new FrameDiagnostics(options);
  }

  constructor({ sceneSetup, battleRenderer, getSimulation }) {
    this.sceneSetup = sceneSetup;
    this.battleRenderer = battleRenderer;
    this.getSimulation = getSimulation;

    // Filled by main.js's loop (see _recordLoopTimings there).
    this.loopTimings = { pre: [], tick: [], post: [] };

    this.frameStarts = [];
    this.syncTimes = [];
    this.renderTimes = [];

    this._lastStartMs = 0;
    this._frameCount = 0;
    // Incremented whenever SceneSetup actually refreshes the shadow map this
    // frame. Reset at every log, so the rate covers one log window.
    this._shadowUpdateCount = 0;
    this._drawCounts = new Map();

    if (window.__diag && typeof window.__diag.off === 'function') {
      try { window.__diag.off(); } catch (e) { /* previous renderer gone */ }
    }

    this._syncOrig = battleRenderer.syncWithSimulation.bind(battleRenderer);
    this._renderOrig = battleRenderer.render.bind(battleRenderer);
    this._renderer = sceneSetup.renderer;
    this._origRenderBufferDirect = this._renderer.renderBufferDirect;

    this._wrapSync();
    this._wrapRender();
    this._installDrawCensus();

    window.__diag = {
      off: () => this.off(),
      dumpCensus: () => this.dumpCensus(),
      matCensus: () => battleRenderer.dumpMaterialCensus(),
      bisect: () => new RenderBisect(sceneSetup, battleRenderer).run(),
      flickerAudit: (on) => battleRenderer.setFlickerAudit(on),
      frameStarts: this.frameStarts,
      syncTimes: this.syncTimes,
      renderTimes: this.renderTimes
    };

    console.log(
      '%c[diag] frame profiler attached — logs every 60 frames. ' +
      'window.__diag.off() to detach.',
      'color:#8ac'
    );
  }

  off() {
    this.battleRenderer.syncWithSimulation = this._syncOrig;
    this.battleRenderer.render = this._renderOrig;
    this._renderer.renderBufferDirect = this._origRenderBufferDirect;
    console.log('[diag] disabled');
  }

  _wrapSync() {
    const orig = this._syncOrig;
    this.battleRenderer.syncWithSimulation = (...args) => {
      const t = performance.now();
      const r = orig(...args);
      push(this.syncTimes, performance.now() - t);
      return r;
    };
  }

  _wrapRender() {
    const orig = this._renderOrig;
    this.battleRenderer.render = (...args) => {
      const tStart = performance.now();
      if (this._lastStartMs > 0) push(this.frameStarts, tStart - this._lastStartMs);
      this._lastStartMs = tStart;

      const shadowBefore = this.sceneSetup._lastShadowUpdateMs;
      const r = orig(...args);
      if (this.sceneSetup._lastShadowUpdateMs !== shadowBefore) this._shadowUpdateCount++;
      push(this.renderTimes, performance.now() - tStart);

      this._frameCount++;
      if (this._frameCount % LOG_EVERY === 0) this._logWindow();
      return r;
    };
  }

  _logWindow() {
    const { sceneSetup, battleRenderer } = this;
    const simulation = this.getSimulation();
    const info = sceneSetup.renderer.info;

    // One-off scene census on the first log line: total mesh / sprite count is
    // the most useful number for the "is this a draw-call problem" question.
    let meshCount = -1;
    let spriteCount = -1;
    if (this._frameCount === LOG_EVERY) {
      meshCount = 0;
      spriteCount = 0;
      sceneSetup.scene.traverse((o) => {
        if (o.isMesh) meshCount++;
        else if (o.isSprite) spriteCount++;
      });
    }

    const avgFrame = avg(this.frameStarts);
    const avgSync = avg(this.syncTimes);
    const avgRender = avg(this.renderTimes);
    const other = avgFrame - avgSync - avgRender;

    // Partition of `other` from the loop-section timings. Loop work =
    // pre + tick + post; post = prep + sync + UI + render, so the sync and
    // render portions are subtracted to isolate prep+UI. raf = whatever remains
    // of the frame after loop work finishes.
    const lt = this.loopTimings;
    const avgPre = lt.pre.length ? avg(lt.pre) : 0;
    const avgTick = lt.tick.length ? avg(lt.tick) : 0;
    const avgPost = lt.post.length ? avg(lt.post) : 0;
    const avgUi = Math.max(0, avgPost - avgSync - avgRender);
    const loopMs = avgPre + avgTick + avgPost;
    const rafMs = Math.max(0, avgFrame - loopMs);
    const fps = avgFrame > 0 ? 1000 / avgFrame : 0;
    const soldierCount = simulation && simulation.getAllSoldiers
      ? simulation.getAllSoldiers().length
      : -1;

    // Unique materials attached to anything in the scene. Shows whether the
    // tint cache is working: matching tints should share one instance.
    const uniqueMats = (() => {
      const s = new Set();
      sceneSetup.scene.traverse((o) => {
        if (!(o.isMesh || o.isSprite || o.isPoints || o.isLine)) return;
        const m = o.material;
        if (!m) return;
        if (Array.isArray(m)) for (const mm of m) s.add(mm);
        else s.add(m);
      });
      return s.size;
    })();

    // LOD tier histogram. A healthy battle shows most soldiers in tier 2-3.
    const tierHisto = [0, 0, 0, 0, 0];
    if (battleRenderer.views) {
      for (const view of battleRenderer.views.values()) {
        const t = view._tier;
        if (t >= 1 && t <= 4) tierHisto[t]++;
      }
    }

    const windowSeconds = (LOG_EVERY * avgFrame) / 1000;
    const shadowHz = windowSeconds > 0 ? this._shadowUpdateCount / windowSeconds : 0;
    this._shadowUpdateCount = 0;

    console.log('%c[instancing]', 'color:#8c8', battleRenderer.getInstancingStats());
    if (simulation && simulation.tickProfile) {
      console.log('%c[tick-diag]', 'color:#c8a', simulation.tickProfile.drainReport());
    }

    const census = meshCount >= 0
      ? ` | census mesh=${meshCount} sprite=${spriteCount}`
      : '';

    console.log(
      `%c[diag] fps=${fps.toFixed(1)} ` +
      `frame=${avgFrame.toFixed(1)}ms (p95 ${p95(this.frameStarts).toFixed(1)})`,
      'color:#8ac;font-weight:bold',
      `| sync=${avgSync.toFixed(1)}ms ` +
      `render=${avgRender.toFixed(1)}ms ` +
      `other=${other.toFixed(1)}ms ` +
      `| pre=${avgPre.toFixed(1)} tick=${avgTick.toFixed(1)} ` +
      `ui=${avgUi.toFixed(1)} raf=${rafMs.toFixed(1)} ` +
      `| calls=${info.render.calls} tris=${info.render.triangles} ` +
      `| geoms=${info.memory.geometries} tex=${info.memory.textures} ` +
      `progs=${info.programs ? info.programs.length : '?'} ` +
      `| mats=${uniqueMats} ` +
      `shadowHz=${shadowHz.toFixed(1)} ` +
      `tiers=${tierHisto[1]}/${tierHisto[2]}/${tierHisto[3]}/${tierHisto[4]} ` +
      `| soldiers=${soldierCount}${census}`
    );
  }

  // Draw-call census. Wraps three.js's lowest-level per-draw entry point so
  // every draw call (main pass and shadow pass) is counted per geometry.
  // three.js assigns renderBufferDirect as an INSTANCE property in the
  // WebGLRenderer constructor, so patching the prototype would have no effect;
  // the instance is patched directly.
  _installDrawCensus() {
    const counts = this._drawCounts;
    const original = this._origRenderBufferDirect;
    this._renderer.renderBufferDirect = function (
      camera, scene, geometry, material, object, group
    ) {
      counts.set(geometry.uuid, (counts.get(geometry.uuid) || 0) + 1);
      return original.call(this, camera, scene, geometry, material, object, group);
    };
  }

  // Usage: run a battle for a few seconds, then window.__diag.dumpCensus().
  dumpCensus() {
    const meta = new Map();
    this.sceneSetup.scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      if (!g || meta.has(g.uuid)) return;
      const pos = g.attributes.position;
      const verts = pos ? pos.count : 0;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      const size = bb
        ? `${(bb.max.x - bb.min.x).toFixed(2)}x` +
          `${(bb.max.y - bb.min.y).toFixed(2)}x` +
          `${(bb.max.z - bb.min.z).toFixed(2)}`
        : '?';
      meta.set(g.uuid, { verts, size });
    });

    const rows = [];
    let total = 0;
    for (const [uuid, count] of this._drawCounts) {
      const m = meta.get(uuid);
      rows.push({
        geom: uuid.slice(0, 8),
        calls: count,
        verts: m ? m.verts : '?',
        bbox: m ? m.size : '?'
      });
      total += count;
    }
    rows.sort((a, b) => b.calls - a.calls);

    console.log(
      `[draw-census] ${rows.length} unique geometries, ` +
      `${total} total draw calls in the sampled window`);
    console.table(rows.slice(0, 30));
    this._drawCounts.clear();
  }
}