// ===== MenuCard.js =====
// Shared factories for the two button shapes used by the menu screens:
//
//   createMenuCard({ name, description, onClick })
//     A primary mode card — bold title line + muted description line.
//     Used for mode / scenario / campaign entries.
//
//   createMenuButton({ label, className, onClick })
//     A plain text button that reuses the .menu-card shell. Used for
//     utility entries (Back, Settings) that read as siblings of the mode
//     cards but should not carry a name/description pair.
//
// Pure DOM factories — no state, no lifecycle. Callers append the returned
// node wherever they need it. Kept here rather than as a class because
// there is nothing to own: given the same args, both produce the same
// detached button.
//
// CardPickerView is deliberately NOT a consumer: its cards carry icons,
// disabled state, and multi-select hooks, which is a different shape that
// would only complicate this module for no gain.

export function createMenuCard({ name, description = '', onClick }) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'menu-card';

  const nameEl = document.createElement('div');
  nameEl.className = 'menu-card-name';
  nameEl.textContent = name;
  card.appendChild(nameEl);

  // Skip the description element entirely when there is none, rather than
  // emitting an empty node. Empty divs still contribute to layout gaps in
  // some flex contexts, and there is no min-height rule to reserve space.
  if (description) {
    const descEl = document.createElement('div');
    descEl.className = 'menu-card-desc';
    descEl.textContent = description;
    card.appendChild(descEl);
  }

  if (onClick) card.addEventListener('click', onClick);
  return card;
}

// className is appended to the base '.menu-card' class, so a caller that
// wants the muted utility look passes 'menu-back'. Extra modifier classes
// can be space-separated in the same string.
export function createMenuButton({ label, className = '', onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className ? `menu-card ${className}` : 'menu-card';
  btn.textContent = label;
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}