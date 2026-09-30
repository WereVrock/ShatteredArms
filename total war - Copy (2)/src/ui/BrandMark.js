// ===== BrandMark.js =====
// The main-menu brand mark: a shattered shield crossed by a broken sword.
// Returned as an inline SVG markup string — no image asset, no async load,
// no build step. Sized by CSS via the .menu-brand container.
//
// Composition (draw order):
//   1. Shield body       — full heater silhouette, cracks drawn on top
//   2. Displaced shards  — three fragments pulled off the edges
//   3. Sword             — hilt + lower blade + break gap + upper blade
//   4. Debris marks      — a few warm spark dots near the break
//
// All coordinates are in a 240x140 viewBox; the whole thing is designed to
// read as a wordmark header — wide, short, centered. The sword is grouped
// and transformed as a whole so it can be rotated across the shield; the
// upper blade segment sits in a nested transform so it can be displaced
// independently to sell the break.

export function brandMarkSvg() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 140" aria-hidden="true">
  <defs>
    <linearGradient id="bm-shield" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#38424f"/>
      <stop offset="1" stop-color="#161b24"/>
    </linearGradient>
    <linearGradient id="bm-blade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f2f6fb"/>
      <stop offset="0.55" stop-color="#a8b3c1"/>
      <stop offset="1" stop-color="#7a8592"/>
    </linearGradient>
    <radialGradient id="bm-boss" cx="0.5" cy="0.4" r="0.65">
      <stop offset="0" stop-color="#d4a574"/>
      <stop offset="1" stop-color="#7a5832"/>
    </radialGradient>
  </defs>

  <!-- ============ SHIELD ============ -->
  <g transform="translate(120 70)">
    <!-- Main heater silhouette -->
    <path d="M -48 -46 L 48 -46 L 48 8 Q 48 46 0 60 Q -48 46 -48 8 Z"
          fill="url(#bm-shield)" stroke="#56657a" stroke-width="2"
          stroke-linejoin="round"/>

    <!-- Crack lines: dark strokes that read as fractures at small sizes -->
    <path d="M -6 -46 L -2 -22 L 8 -14 L 4 6 L 14 22 L 6 44"
          fill="none" stroke="#0a0d12" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M -48 6 L -26 4 L -14 14 L 10 10 L 30 20 L 48 12"
          fill="none" stroke="#0a0d12" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M -32 -46 L -26 -20 L -34 2"
          fill="none" stroke="#0a0d12" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Central boss -->
    <circle cx="0" cy="-4" r="12"
            fill="url(#bm-boss)" stroke="#3a2c1a" stroke-width="1.5"/>
    <circle cx="0" cy="-4" r="4" fill="#1a1208" opacity="0.55"/>

    <!-- Displaced shards pulled off the left, right, and bottom edges -->
    <path d="M -58 -22 L -44 -26 L -42 -8 L -54 -6 Z"
          fill="url(#bm-shield)" stroke="#56657a" stroke-width="1.5"
          stroke-linejoin="round"/>
    <path d="M 50 26 L 64 22 L 62 40 L 50 40 Z"
          fill="url(#bm-shield)" stroke="#56657a" stroke-width="1.5"
          stroke-linejoin="round"/>
    <path d="M -24 52 L -14 46 L -8 58 L -18 62 Z"
          fill="url(#bm-shield)" stroke="#56657a" stroke-width="1.5"
          stroke-linejoin="round"/>
  </g>

  <!-- ============ SWORD (broken, diagonal across the shield) ============ -->
  <g transform="translate(120 70) rotate(-38)">
    <!-- Pommel -->
    <circle cx="-64" cy="0" r="5"
            fill="#a87a44" stroke="#4a3820" stroke-width="1.2"/>
    <!-- Grip -->
    <rect x="-60" y="-3.5" width="22" height="7" rx="1.5"
          fill="#3a2a18" stroke="#5a4020" stroke-width="1"/>
    <line x1="-56" y1="-3" x2="-56" y2="3" stroke="#1a1008" stroke-width="0.8"/>
    <line x1="-50" y1="-3" x2="-50" y2="3" stroke="#1a1008" stroke-width="0.8"/>
    <line x1="-44" y1="-3" x2="-44" y2="3" stroke="#1a1008" stroke-width="0.8"/>
    <!-- Crossguard -->
    <path d="M -40 -16 L -34 -16 L -30 -4 L -30 4 L -34 16 L -40 16 L -38 4 L -38 -4 Z"
          fill="#a87a44" stroke="#4a3820" stroke-width="1.2"
          stroke-linejoin="round"/>

    <!-- Lower blade segment -->
    <path d="M -30 -5 L 8 -5 L 8 5 L -30 5 Z"
          fill="url(#bm-blade)" stroke="#3a4555" stroke-width="0.8"/>
    <line x1="-28" y1="0" x2="6" y2="0"
          stroke="#cfd8e4" stroke-width="0.8" opacity="0.6"/>

    <!-- Break edge (jagged cap on the lower segment) -->
    <path d="M 8 -5 L 12 -2 L 9 1 L 13 4 L 8 5 Z" fill="#3a4555"/>

    <!-- Upper blade segment, displaced and slightly rotated -->
    <g transform="translate(20 -6) rotate(8)">
      <path d="M -10 -4 L 22 -4 L 30 0 L 22 4 L -10 4 Z"
            fill="url(#bm-blade)" stroke="#3a4555" stroke-width="0.8"/>
      <line x1="-8" y1="0" x2="24" y2="0"
            stroke="#cfd8e4" stroke-width="0.8" opacity="0.6"/>
      <!-- Tip -->
      <path d="M 30 -4 L 42 0 L 30 4 Z"
            fill="#f2f6fb" stroke="#3a4555" stroke-width="0.8"
            stroke-linejoin="round"/>
    </g>
  </g>

  <!-- Debris / spark marks near the break -->
  <g fill="#d4a574">
    <circle cx="133" cy="58" r="1.6" opacity="0.9"/>
    <circle cx="141" cy="54" r="1.1" opacity="0.7"/>
    <circle cx="127" cy="62" r="0.9" opacity="0.5"/>
    <circle cx="147" cy="50" r="0.9" opacity="0.4"/>
  </g>
</svg>
  `.trim();
}