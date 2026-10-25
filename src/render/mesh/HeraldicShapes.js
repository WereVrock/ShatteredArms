// ===== src/render/mesh/HeraldicShapes.js =====
// Shared 2D shape outlines used by more than one model builder.
//
// A heraldic device is not owned by any one garment — the Warlord's
// war-crown appears on the hood, on the cape, and (as a shield-face
// crest) on the shield. Duplicating the outline in three files would
// mean three places to edit if the device ever changes, and three
// chances for the shapes to drift apart visually. This module is the
// one place that outline lives.
//
// The curvy hood ornaments (wing, flourish) are also defined here
// rather than in GoblinWarlordArmor.js because they are heraldic
// vocabulary — a future Warlord variant, a champion of a different
// race, or a banner might want the same shapes. Keeping them in a
// neutral module is what lets that happen without a copy.
//
// CONVENTIONS
// Every shape is authored in its own native frame, roughly [-0.5, 0.5]
// on X and [-0.5, 0.7] on Y, drawn counter-clockwise so ExtrudeGeometry
// and ShapeGeometry produce an outward-facing +Z cap. Consumers scale
// the shape to their own size; they do NOT reauthor the outline.
//
// Curvy shapes are authored with explicit control points and drawn via
// splineThru (Catmull-Rom through the points), so the outline reads as
// a hand-drawn heraldic flourish rather than a polygon. The mirrored
// variants reverse the point order after negating X, which preserves
// winding so Lambert shading does not flip when the shape is mirrored
// to the other side of a symmetric pair.
import * as THREE from 'three';

// --- war-crown -------------------------------------------------------------

// The Warlord's heraldic device: a three-pronged war-crown with side
// flanks and a flat base. Deliberately NOT a geometric primitive — a
// diamond, a triangle, or a plain star reads as decoration, while a
// crown reads as a claim to command, which is what the Warlord IS.
//
// Native extent: X ∈ [-0.5, 0.5], Y ∈ [-0.5, 0.7]. Total height 1.2
// native units. Consumers scale by (targetWidth / 1.0) horizontally and
// (targetHeight / 1.2) vertically.
export function buildWarCrownShape() {
  const s = new THREE.Shape();
  // Bottom edge, left to right.
  s.moveTo(-0.50, -0.50);
  s.lineTo( 0.50, -0.50);
  // Right side up.
  s.lineTo( 0.50,  0.00);
  s.lineTo( 0.40,  0.10);
  s.lineTo( 0.38,  0.35);
  s.lineTo( 0.30,  0.50);   // right prong tip
  s.lineTo( 0.22,  0.35);
  s.lineTo( 0.20,  0.15);
  // Center prong, right side.
  s.lineTo( 0.12,  0.15);
  s.lineTo( 0.10,  0.70);   // center prong right tip
  // Center prong top.
  s.lineTo(-0.10,  0.70);   // center prong left tip
  s.lineTo(-0.12,  0.15);
  // Left of center valley.
  s.lineTo(-0.20,  0.15);
  s.lineTo(-0.22,  0.35);
  s.lineTo(-0.30,  0.50);   // left prong tip
  s.lineTo(-0.38,  0.35);
  s.lineTo(-0.40,  0.10);
  s.lineTo(-0.50,  0.00);
  s.closePath();
  return s;
}

// --- hood wing (curled scrollwork) -----------------------------------------

// A single curled wing / scroll, drawn to sweep from a spine near the
// origin outward (+X) and down, ending in a curling tip. The trailing
// edge (the second half of the loop, running right-to-left) returns the
// outline to the origin as a thinner returning curve, which is what
// makes the shape read as a wing rather than as a blunt blob.
//
// Native extent: X ∈ [0, 0.9], Y ∈ [-0.32, 0.35].
//
// The mirrored variant is used for the left wing of a symmetric pair.
// The point list is negated on X and then REVERSED so the winding stays
// counter-clockwise — reversing is what keeps the front-face normal
// pointing +Z so Lambert shading reads the wing identically on both
// sides of the pair.
export function buildHoodWingShape(mirrorX = false) {
  const raw = [
    [0.00,  0.30],   // 0  inner top (near the spine)
    [0.25,  0.35],   // 1  outer sweep, top
    [0.55,  0.22],   // 2
    [0.80,  0.02],   // 3  tip approach
    [0.90, -0.22],   // 4  curled tip
    [0.72, -0.32],   // 5  underside of the curl
    [0.48, -0.18],   // 6  returning edge
    [0.30, -0.06],   // 7
    [0.15,  0.00],   // 8
    [0.05,  0.15]    // 9  inner edge coming back up
  ];

  const pts = raw.map(([x, y]) =>
    new THREE.Vector2(mirrorX ? -x : x, y));
  if (mirrorX) pts.reverse();

  const s = new THREE.Shape();
  s.moveTo(pts[0].x, pts[0].y);
  // splineThru runs Catmull-Rom through the given points, starting at
  // the current point. It does NOT close the loop, so a straight
  // closing segment is drawn explicitly. On a wing of this size the
  // straight segment falls along the spine (the least visible edge of
  // the shape), so the silhouette still reads as fully curved.
  s.splineThru(pts.slice(1));
  s.lineTo(pts[0].x, pts[0].y);
  s.closePath();
  return s;
}

// --- hood flourish (curved arc) --------------------------------------------

// A single crescent arc — a thin curved band that reads as a decorative
// filigree running above the crown. Outer edge sweeps up and over;
// inner edge sweeps back lower and tighter, giving the crescent its
// thickness.
//
// Native extent: X ∈ [-0.5, 0.5], Y ∈ [0, 0.30].
export function buildHoodFlourishShape() {
  const outer = [
    [-0.50,  0.00],
    [-0.35,  0.20],
    [-0.10,  0.30],
    [ 0.15,  0.30],
    [ 0.38,  0.20],
    [ 0.50,  0.00]
  ];
  const inner = [
    [ 0.38,  0.06],
    [ 0.15,  0.14],
    [-0.10,  0.14],
    [-0.35,  0.06]
  ];

  const pts = [
    ...outer.map(([x, y]) => new THREE.Vector2(x, y)),
    ...inner.map(([x, y]) => new THREE.Vector2(x, y))
  ];

  const s = new THREE.Shape();
  s.moveTo(pts[0].x, pts[0].y);
  s.splineThru(pts.slice(1));
  s.lineTo(pts[0].x, pts[0].y);
  s.closePath();
  return s;
}