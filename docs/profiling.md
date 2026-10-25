# Frame diagnostic — how to read it

A one-patch profiler that hooks into `BattleRenderer.syncWithSimulation()`
and `BattleRenderer.render()` and logs a summary every 60 frames.

## Install

Apply the patch below to `src/main.js`. Start a battle with your test
roster (150–200 soldiers) and leave the camera still. Wait ~3 seconds.

## Output

Each log line looks like:

    [diag] fps=24.3 frame=41.2ms (p95 55.8) | sync=8.1ms render=12.4ms other=20.7ms
           | calls=4218 tris=312450 | geoms=2847 tex=23 progs=14 | units=8 soldiers=176

## How to read it

    frame    — one full rAF-to-rAF interval, in ms. 1000/frame = fps.
    p95      — 95th percentile frame time. If this is much higher than
               the average, you have intermittent hitches (usually LOD
               rebuilds or GC).

    sync     — time inside battleRenderer.syncWithSimulation().
               This is where all per-soldier JS lives: position writes,
               LOD, walk cycle, shield positioning, HP tint.
    render   — time inside battleRenderer.render().
               This is CPU time submitting draw calls (three.js WebGL
               calls), NOT GPU time. Usually small even when GPU-bound.
    other    — frame - sync - render. Everything else in the loop:
               armyBar, hudView, powerBalance, cameraController,
               orderPreview, projectiles, and browser/GPU wait.

    calls    — draw calls submitted this frame. COUNTS BOTH PASSES:
               the shadow map pass AND the main pass. Each shadow-casting
               mesh costs 2 calls per frame.
    tris     — triangles submitted this frame.
    geoms    — live BufferGeometry objects. Grows by ~11 per soldier.
    tex      — live textures.
    progs    — compiled shader programs. Should be a small fixed number
               (< 30). If this grows over time, you have a material leak.
    soldiers — total live soldiers right now.

## Interpreting the numbers

### calls is high (>= 2000)

    Draw-call bound. The GPU is waiting on the CPU to feed it work.
    Fix: reduce mesh count per soldier, or instance same-type soldiers.

### calls is low but fps is low

    GPU-bound (fragment/overdraw) or something in `other`.
    Check chrome://gpu for GPU utilization, or use the Performance tab.

### sync is high (>= 8ms)

    CPU-bound in per-soldier JS. The Bucket 1 dirty-tracking and
    no-rebuild-LOD changes matter here. If sync is high even with all
    units standing, something is still doing work per soldier per frame
    (probably the first-frame init or a runaway animation clock).

### other is high

    The bottleneck is outside the soldier pipeline. Suspects:
    - powerBalanceView.update() — iterates every unit each frame
    - hudView.update() — even when hidden, if the toggle check failed
    - armyBarView.update() — rebuilds card DOM every frame
    - GPU wait inside rAF (i.e. actually GPU-bound)

### p95 >> average

    Intermittent spikes. Suspects:
    - GC pauses (object churn in the render loop)
    - LOD rebuilds if you reverted the no-rebuild change
    - Texture uploads on first draw of a new material

## Disable

    window.__diag.off()

## Typical baseline shapes

For reference, well-optimised large-scale RTS titles at this scale
target:

    calls:  < 500     (main + shadow)
    sync:   < 2ms
    render: < 3ms
    frame:  < 16.7ms  (60 fps) or < 33ms (30 fps) at max unit count

If your `calls` is in the thousands, that's the whole story.