// ===== ArmyMergeAll.js =====
// "Merge all" orchestration for the army manager. Holds NO merge rules: it
// only asks the controller (through the view's own config callbacks)
// whether a pair can merge, asks it to merge, and re-reads the model after
// every merge so it never iterates a stale list.
//
// config = the ArmyManagerView config (getModel, canMerge, onDropOnCard).

const MAX_STEPS = 500;

function allCards(model) {
  return model.fielded.concat(model.reserve);
}

function pairKey(a, b) {
  return a + '|' + b;
}

// Returns { a, b } (ids) for the first mergeable pair not in `skip`, or null.
function findPair(cards, config, skip) {
  for (let i = 0; i < cards.length; i++) {
    const a = cards[i];
    if (a.locked) continue;
    for (let j = 0; j < cards.length; j++) {
      if (i === j) continue;
      const b = cards[j];
      if (b.locked) continue;
      if (skip && skip.has(pairKey(a.id, b.id))) continue;
      if (config.canMerge(a.id, b.id)) return { a: a.id, b: b.id };
    }
  }
  return null;
}

// True when at least one merge is possible right now.
export function hasMergePair(config, model) {
  return findPair(allCards(model), config, null) !== null;
}

// Merges until nothing is mergeable. Returns the number of merges done.
// Every step re-reads the model, performs at most one merge, then loops, so
// the card list is never modified while it is being iterated.
export function mergeAllUnits(config) {
  const skip = new Set();
  let merges = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const before = allCards(config.getModel());
    const pair = findPair(before, config, skip);
    if (!pair) break;

    const ok = config.onDropOnCard(pair.a, pair.b);
    const after = allCards(config.getModel());

    // A merge must reduce the card count; otherwise treat it as rejected so
    // a controller that reports success without changing anything cannot
    // loop forever.
    if (ok && after.length < before.length) merges++;
    else skip.add(pairKey(pair.a, pair.b));
  }
  return merges;
}