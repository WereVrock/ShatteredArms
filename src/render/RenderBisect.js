// ===== RenderBisect.js =====
// GPU cost attribution. Run from the console while a battle is going:
//
//     __diag.bisect()
//
// It steps through a list of configurations. Each one switches a single
// scene feature off, waits a few frames, then times 60 frames of
// renderer work INCLUDING the GPU: after every render it reads one pixel
// back, which cannot return until the GPU has finished the frame. So the
// reported number is the true per-frame render cost, not a vsync-clustered
// frame rate.
//
//   submit   CPU time spent issuing draw calls
//   gpuWait  time the CPU then waited for the GPU to finish
//   total    submit + gpuWait
//
// Compare each row to "baseline": the configuration whose total drops the
// most is where the GPU time goes. Every change is reverted after its
// step. Frame rate is lower than normal while this runs (the readback
// stalls the pipeline on purpose).
const WARMUP_FRAMES = 20;
const SAMPLE_FRAMES = 60;

function avg(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function p95(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

export class RenderBisect {
  constructor(sceneSetup, battleRenderer) {
    this.sceneSetup = sceneSetup;
    this.instancer = battleRenderer._instancer;
    this.running = false;
  }

  run() {
    if (this.running) {
      console.log('[bisect] already running');
      return;
    }
    this.running = true;

    const s = this.sceneSetup;
    const gl = s.renderer.getContext();
    const px = new Uint8Array(4);
    const original = s.render;
    const configs = this._buildConfigs();
    const results = [];

    let index = 0;
    let frame = 0;
    let submit = [];
    let wait = [];
    let revert = () => {};

    const start = () => {
      frame = 0;
      submit = [];
      wait = [];
      revert = configs[index].apply();
    };

    s.render = () => {
      const t0 = performance.now();
      original.call(s);
      const t1 = performance.now();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t2 = performance.now();

      frame++;
      if (frame > WARMUP_FRAMES) {
        submit.push(t1 - t0);
        wait.push(t2 - t1);
      }

      if (frame >= WARMUP_FRAMES + SAMPLE_FRAMES) {
        const totals = submit.map((v, i) => v + wait[i]);
        results.push({
          name: configs[index].name,
          total: avg(totals),
          p95: p95(totals),
          submit: avg(submit),
          wait: avg(wait)
        });
        revert();
        index++;
        if (index >= configs.length) {
          delete s.render;
          this.running = false;
          this._report(results);
        } else {
          start();
        }
      }
    };

    console.log('[bisect] started — ' + configs.length + ' steps, ' +
      'about ' + Math.round(configs.length * (WARMUP_FRAMES + SAMPLE_FRAMES) / 25) +
      ' seconds. Leave the battle running.');
    start();
  }

  _buildConfigs() {
    const s = this.sceneSetup;
    const inst = this.instancer;
    const r = s.renderer;

    const hideGrass = () => {
      const prev = s.grassField.mesh.visible;
      s.grassField.setVisible(false);
      return () => s.grassField.setVisible(prev);
    };
    const hideGround = () => {
      const prev = s.ground.visible;
      s.ground.visible = false;
      return () => { s.ground.visible = prev; };
    };
    const noShadows = () => {
      const prev = s.sun.castShadow;
      s.sun.castShadow = false;
      return () => { s.sun.castShadow = prev; };
    };
    const hideSoldiers = () => {
      inst.debugHidden = true;
      return () => { inst.debugHidden = false; };
    };

    return [
      { name: 'baseline', apply: () => () => {} },
      { name: 'no shadows at all', apply: noShadows },
      {
        name: 'soldiers cast no shadow',
        apply: () => {
          inst.debugNoCast = true;
          return () => { inst.debugNoCast = false; };
        }
      },
      { name: 'soldiers hidden', apply: hideSoldiers },
      { name: 'grass hidden', apply: hideGrass },
      { name: 'ground hidden', apply: hideGround },
      {
        name: 'half resolution',
        apply: () => {
          const prev = s._appliedPixelRatio;
          r.setPixelRatio(prev * 0.5);
          return () => r.setPixelRatio(prev);
        }
      },
      {
        name: 'nothing drawn (floor)',
        apply: () => {
          const undo = [noShadows(), hideSoldiers(), hideGrass(), hideGround()];
          return () => { for (const u of undo) u(); };
        }
      }
    ];
  }

  _report(results) {
    const base = results[0].total;
    const lines = results.map((row) => {
      const delta = row.total - base;
      const sign = delta > 0 ? '+' : '';
      return `[bisect] ${row.name.padEnd(26)} total=${row.total.toFixed(1)}ms ` +
        `(submit=${row.submit.toFixed(1)} gpuWait=${row.wait.toFixed(1)}) ` +
        `p95=${row.p95.toFixed(1)} | vs baseline ${sign}${delta.toFixed(1)}ms`;
    });
    console.log('[bisect] done\n' + lines.join('\n'));
  }
}