// ===== src/render/camp/VolcanicProps.js =====
// Volcanic scenery props. Currently one: basaltColumns.
//
// Basalt columns form when thick lava cools slowly — the rock
// contracts and cracks into hexagonal prisms. Classic examples:
// Giant's Causeway, Devil's Postpile, Fingal's Cave. As a battlefield
// scenic prop a cluster of varied-height hexagonal pillars reads as
// "this is volcanic terrain" at any zoom, with a silhouette distinct
// from every existing tree, rock, and ruin.
//
// Built with the same CampPropKit plumbing as every other camp prop:
// takes a Local frame, writes into ctx.merged, participates in the
// same merged-geometry pipeline. No animation — static scenery.
//
// No imports needed: L.cyl, L.disc, L.rock are methods on the Local
// frame the caller passes in, and L.ctx.rng is the CampContext's
// seeded RNG.

// Basalt column cluster. 5-6 hexagonal pillars of varied heights,
// slight natural tilts, dark warm-grey stone with per-column shade
// variation. Broken-top detailing on the taller columns reads as
// natural fracturing, and one fallen column lies on the ground. A
// low rubble/ash disc grounds the formation.
//
// Heights span 3–12.5 units, so the tallest reads as a proper
// landmark (well over the 2-unit soldier silhouette) while the
// shortest is roughly head-height — the cluster has visual hierarchy
// (dominant / secondary / buried), not a flat forest of equal spikes.
//
// Collision is a single circle (configured in BiomeSceneryConfig.js),
// not per-column: the pillars are too close together for units to
// path between them, and one circle reads as "walk around the whole
// formation" which is how a player would treat it anyway.
export function basaltColumns(L) {
  const rng = L.ctx.rng;

  // --- base rubble ---
  // Dark ash disc grounds the formation and hides the column bottoms.
  // Seg: 8 gives a low-poly octagon — organic enough not to look like
  // a perfect circle at battle zoom.
  L.disc({ r: 2.0, y: 0.03, seg: 8, color: 0x140e08 });

  // Scattered rubble chunks around the base, reusing the rock primitive
  // for a slightly irregular silhouette.
  for (let i = 0; i < 6; i++) {
    const a = rng() * Math.PI * 2;
    const r = 1.2 + rng() * 0.8;
    const shade = 0.4 + rng() * 0.3;
    const base = 0x2a2018;
    const rr = Math.min(255, Math.floor(((base >> 16) & 0xff) * shade));
    const gg = Math.min(255, Math.floor(((base >> 8) & 0xff) * shade));
    const bb = Math.min(255, Math.floor((base & 0xff) * shade));
    L.rock({
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      y: 0.08 + rng() * 0.08,
      r: 0.15 + rng() * 0.12,
      sy: 0.65,
      rx: rng() * 3,
      ry: rng() * 3,
      color: (rr << 16) | (gg << 8) | bb
    });
  }

  // --- standing columns ---
  // x, z: offset from cluster centre. h: column height. r: radius.
  // tilt: small X-axis tilt (radians) for natural lean. ry: Y rotation
  // so the hexagonal faces point different ways. The Y rotation is
  // important — a hex prism viewed face-on vs corner-on shows very
  // different silhouettes.
  const columns = [
    { x:  0.0, z:  0.0, h: 12.5, r: 0.60, tilt: 0.02, ry: 0.0 },
    { x:  0.9, z:  0.3, h:  8.5, r: 0.50, tilt: -0.04, ry: 0.5 },
    { x: -0.8, z:  0.5, h: 10.0, r: 0.55, tilt: 0.05, ry: 1.0 },
    { x:  0.5, z: -0.9, h:  6.0, r: 0.45, tilt: 0.08, ry: 1.8 },
    { x: -0.6, z: -0.7, h:  4.5, r: 0.40, tilt: -0.06, ry: 2.5 },
    { x:  1.3, z:  0.8, h:  3.0, r: 0.35, tilt: 0.10, ry: 3.1 }
  ];

  const BASE_R = 0x2a >> 0;  // dummy reads to keep lint happy
  const BASALT_BASE = 0x2a2420;
  const BASE_RED   = (BASALT_BASE >> 16) & 0xff;
  const BASE_GREEN = (BASALT_BASE >>  8) & 0xff;
  const BASE_BLUE  =  BASALT_BASE        & 0xff;

  const shade = (r, g, b, k) =>
    (Math.min(255, Math.floor(r * k)) << 16) |
    (Math.min(255, Math.floor(g * k)) <<  8) |
     Math.min(255, Math.floor(b * k));

  for (const c of columns) {
    // Per-column brightness. Basalt varies from near-black to dark
    // warm grey depending on mineral content and weathering.
    const k = 0.7 + rng() * 0.5;
    const color = shade(BASE_RED, BASE_GREEN, BASE_BLUE, k);

    // Main column. cy is the CENTRE Y of the cylinder, so h/2 puts
    // the base at local Y = 0.
    L.cyl({
      x: c.x, z: c.z,
      cy: c.h / 2,
      r: c.r, h: c.h, seg: 6,
      rx: c.tilt, ry: c.ry, rz: c.tilt * 0.5,
      color
    });

    // Broken-top fragment on the taller columns. A smaller hexagon
    // sitting on top with its own tilt, offset slightly so the break
    // reads as uneven. Darker than the column body — freshly broken
    // basalt is darker than weathered.
    if (c.h > 5) {
      const breakH = 0.25 + rng() * 0.35;
      const bx = c.x + (rng() - 0.5) * 0.15;
      const bz = c.z + (rng() - 0.5) * 0.15;
      const bTiltX = c.tilt + (rng() - 0.5) * 0.35;
      const bTiltZ = c.tilt * 0.5 + (rng() - 0.5) * 0.35;
      const dark = shade(BASE_RED, BASE_GREEN, BASE_BLUE, k * 0.6);
      L.cyl({
        x: bx, z: bz,
        cy: c.h + breakH / 2 - 0.1,
        r: c.r * 0.55, h: breakH, seg: 6,
        rx: bTiltX, rz: bTiltZ,
        color: dark
      });
    }
  }

  // --- fallen column ---
  // One column toppled over. Rotated 90° around X so it lies flat,
  // with a random Y rotation for direction. A subtle but important
  // detail: a fully intact forest of standing pillars reads as a
  // "monument", while one broken piece on the ground suggests age
  // and geological drama — a formation that has been here for a
  // very long time.
  const fallenK = 0.65 + rng() * 0.25;
  const fallenColor = shade(BASE_RED, BASE_GREEN, BASE_BLUE, fallenK);
  L.cyl({
    x: 1.4, z: -1.2,
    cy: 0.32,
    r: 0.48, h: 3.0, seg: 6,
    rx: Math.PI / 2, ry: 1.2, rz: 0.15,
    color: fallenColor
  });
}