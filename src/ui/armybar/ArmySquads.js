// Pure logic: visual squads, the coloured frames drawn around clusters of
// cards. No DOM. A unit belongs to at most one squad; a squad that loses its
// last member disappears. Not to be confused with control groups (1-9, see
// ArmyControlGroups), which are keyboard recall sets.
//
// A locked squad keeps its members: nothing can be added to it or removed
// from it, and it cannot be disbanded until it is unlocked.
//
// `version` is bumped on every change so the view can refresh cheaply.

const SQUAD_COLORS = ['#e8c060', '#6fb3e0', '#7fcf7f', '#d98fd9', '#e08a5a', '#6fd0c8'];

export class ArmySquads {
  constructor() {
    this.squads = new Map();       // squadId -> { id, color, collapsed, locked }
    this.squadByUnit = new Map();  // unitId -> squadId
    this.version = 0;
    this._nextId = 1;
    this._nextColor = 0;
  }

  get size() {
    return this.squads.size;
  }

  get(squadId) {
    return this.squads.get(squadId);
  }

  // undefined when the unit is not in a squad.
  squadIdFor(unitId) {
    return this.squadByUnit.get(unitId);
  }

  // False for an unknown or undefined squad id.
  isLocked(squadId) {
    const squad = this.squads.get(squadId);
    return !!squad && squad.locked;
  }

  memberIds(squadId) {
    const out = [];
    for (const [unitId, sid] of this.squadByUnit) {
      if (sid === squadId) out.push(unitId);
    }
    return out;
  }

  // Makes a new squad from the given units, pulling them out of any squad
  // they were in. Units of locked squads are left where they are. Returns
  // the new squad id, or null when nothing was left to group.
  create(unitIds) {
    const free = (unitIds || []).filter(
      (unitId) => !this.isLocked(this.squadByUnit.get(unitId))
    );
    if (free.length === 0) return null;

    for (const unitId of free) this._detach(unitId);

    const id = this._nextId++;
    this.squads.set(id, {
      id,
      color: SQUAD_COLORS[this._nextColor % SQUAD_COLORS.length],
      collapsed: false,
      locked: false
    });
    this._nextColor++;
    for (const unitId of free) this.squadByUnit.set(unitId, id);

    this.version++;
    return id;
  }

  addUnit(squadId, unitId) {
    if (!this.squads.has(squadId) || this.isLocked(squadId)) return false;
    if (this.squadByUnit.get(unitId) === squadId) return false;
    if (this.isLocked(this.squadByUnit.get(unitId))) return false;
    this._detach(unitId);
    this.squadByUnit.set(unitId, squadId);
    this.version++;
    return true;
  }

  removeUnit(unitId) {
    if (!this.squadByUnit.has(unitId)) return false;
    if (this.isLocked(this.squadByUnit.get(unitId))) return false;
    this._detach(unitId);
    this.version++;
    return true;
  }

  disband(squadId) {
    if (!this.squads.has(squadId) || this.isLocked(squadId)) return false;
    for (const unitId of this.memberIds(squadId)) this.squadByUnit.delete(unitId);
    this.squads.delete(squadId);
    this.version++;
    return true;
  }

  toggleCollapsed(squadId) {
    const squad = this.squads.get(squadId);
    if (!squad) return false;
    squad.collapsed = !squad.collapsed;
    this.version++;
    return true;
  }

  toggleLocked(squadId) {
    const squad = this.squads.get(squadId);
    if (!squad) return false;
    squad.locked = !squad.locked;
    this.version++;
    return true;
  }

  // Removes the unit from its squad, deleting the squad if that emptied it.
  // Does not bump version; callers do.
  _detach(unitId) {
    const squadId = this.squadByUnit.get(unitId);
    if (squadId === undefined) return;
    this.squadByUnit.delete(unitId);
    if (this.memberIds(squadId).length === 0) this.squads.delete(squadId);
  }
}