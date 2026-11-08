// Pure logic: turns a finished drag into changes to the card order and to
// squad membership. No DOM.
//
// Rules:
//   - Dropping a card onto a card of another squad moves it into that squad.
//   - Dropping a card onto an ungrouped card takes it out of its squad.
//   - Dropping a card onto a card of its own squad just reorders it.
//   - Dropping a squad onto a card moves the whole squad as a block. If the
//     card belongs to another squad, the block lands outside that squad,
//     never inside it.
//
// `displayIds` is the order currently on screen. The stored order is synced
// to it first, so every move is relative to what the player saw.

export class ArmyBarReorderer {
  constructor(order, squads) {
    this.order = order;
    this.squads = squads;
  }

dropCard(cardId, targetId, placeAfter, displayIds) {
    if (cardId === targetId) return false;

    // A locked squad moves as one: dragging any of its cards drags the squad.
    const ownSquad = this.squads.squadIdFor(cardId);
    if (ownSquad !== undefined && this.squads.isLocked(ownSquad)) {
      return this.dropSquad(ownSquad, targetId, placeAfter, displayIds);
    }

    this.order.normalize(displayIds);

    const targetSquad = this.squads.squadIdFor(targetId);

    // A locked squad takes no new members: the card lands next to it.
    if (targetSquad !== undefined && targetSquad !== ownSquad
        && this.squads.isLocked(targetSquad)) {
      const theirs = displayIds.filter((id) => this.squads.squadIdFor(id) === targetSquad);
      const anchorId = placeAfter ? theirs[theirs.length - 1] : theirs[0];
      this.squads.removeUnit(cardId);
      return this.order.move(cardId, anchorId, placeAfter);
    }

    if (targetSquad !== ownSquad) {
      if (targetSquad === undefined) this.squads.removeUnit(cardId);
      else this.squads.addUnit(targetSquad, cardId);
    }
    return this.order.move(cardId, targetId, placeAfter);
  }

  dropSquad(squadId, targetId, placeAfter, displayIds) {
    const targetSquad = this.squads.squadIdFor(targetId);
    if (targetSquad === squadId) return false;
    this.order.normalize(displayIds);

    const members = displayIds.filter((id) => this.squads.squadIdFor(id) === squadId);
    if (members.length === 0) return false;

    let anchorId = targetId;
    if (targetSquad !== undefined) {
      const theirs = displayIds.filter((id) => this.squads.squadIdFor(id) === targetSquad);
      anchorId = placeAfter ? theirs[theirs.length - 1] : theirs[0];
    }
    return this.order.moveBlock(members, anchorId, placeAfter);
  }
}