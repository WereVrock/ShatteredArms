// Path-following spine of a marching formation.
//
// The spine is a polyline that starts at the march anchor and runs FORWARD
// (the formation's local +z axis) along the unit's remaining terrain path, then
// continues straight past the last waypoint. Row r of the formation sits at arc
// length r * spacing on it, and soldiers spread sideways along the spine normal.
// That is what lets a long column bend around a corner while staying one
// uniform block: every slot still hangs off the single anchor.
//
// With no detour in the path the spine is just the straight line along
// formationFacing, i.e. the ordinary formation.
//
// build() fills ONE shared scratch buffer and returns it. Consume the result
// before the next build() call (FormationSlots and FormationSqueeze both do).

const spine = {
  n: 0,
  step: 1,
  px: new Float64Array(64),
  pz: new Float64Array(64),
  tx: new Float64Array(64),
  tz: new Float64Array(64)
};

function ensureCapacity(n) {
  if (spine.px.length >= n) return;
  const cap = Math.max(n, spine.px.length * 2);
  spine.px = new Float64Array(cap);
  spine.pz = new Float64Array(cap);
  spine.tx = new Float64Array(cap);
  spine.tz = new Float64Array(cap);
}

// Central-difference tangents. Smooths corners over about two rows.
function fillTangents(n, fx, fz) {
  const X = spine.px, Z = spine.pz, TX = spine.tx, TZ = spine.tz;
  let lastX = fx, lastZ = fz;
  for (let i = 0; i < n; i++) {
    const i0 = i > 0 ? i - 1 : 0;
    const i1 = i < n - 1 ? i + 1 : n - 1;
    const dx = X[i1] - X[i0];
    const dz = Z[i1] - Z[i0];
    const l = Math.sqrt(dx * dx + dz * dz);
    if (l > 1e-9) { lastX = dx / l; lastZ = dz / l; }
    TX[i] = lastX;
    TZ[i] = lastZ;
  }
}

export const FormationSpine = {
  // True while the anchor is following a detour: waypoints still ahead, or a
  // partial path (goal unreachable) where the anchor parks at the last waypoint.
  hasDetour(unit) {
    const p = unit._path;
    if (p === null || unit._directMarch) return false;
    if (unit._pathPartial) return p.length > 0;
    return unit._pathIdx < p.length - 1;
  },

  // `length` is how far ahead of the anchor the spine must reach.
  build(unit, length) {
    const spacing = unit.getFormationSpacing();
    const n = Math.max(2, Math.ceil(length / spacing) + 2);
    ensureCapacity(n);

    const a = unit.formationMarchOrigin;
    const f = unit.formationFacing;
    const fx = Math.sin(f);
    const fz = Math.cos(f);
    const X = spine.px, Z = spine.pz;

    spine.n = n;
    spine.step = spacing;
    X[0] = a.x;
    Z[0] = a.z;

    if (!FormationSpine.hasDetour(unit)) {
      for (let i = 1; i < n; i++) {
        X[i] = a.x + fx * spacing * i;
        Z[i] = a.z + fz * spacing * i;
      }
      fillTangents(n, fx, fz);
      return spine;
    }

    const p = unit._path;
    const len = p.length;
    let wpi = unit._pathIdx;

    // Past the last waypoint the spine continues along the last path segment.
    const lastPt = p[len - 1];
    const prev = len >= 2 ? p[len - 2] : a;
    let tailX = lastPt.x - prev.x;
    let tailZ = lastPt.z - prev.z;
    const tl = Math.sqrt(tailX * tailX + tailZ * tailZ);
    if (tl > 1e-6) { tailX /= tl; tailZ /= tl; } else { tailX = fx; tailZ = fz; }

    let cx = a.x;
    let cz = a.z;
    for (let i = 1; i < n; i++) {
      let need = spacing;
      while (need > 1e-9) {
        if (wpi < len) {
          const w = p[wpi];
          const dx = w.x - cx;
          const dz = w.z - cz;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d < 1e-6) { wpi++; continue; }
          if (d >= need) {
            cx += (dx / d) * need;
            cz += (dz / d) * need;
            need = 0;
          } else {
            cx = w.x;
            cz = w.z;
            need -= d;
            wpi++;
          }
        } else {
          cx += tailX * need;
          cz += tailZ * need;
          need = 0;
        }
      }
      X[i] = cx;
      Z[i] = cz;
    }
    fillTangents(n, fx, fz);
    return spine;
  }
};