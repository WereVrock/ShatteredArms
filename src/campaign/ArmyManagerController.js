// ===== ArmyManagerController.js =====
// Connects ArmyManagerView to the campaign state. Builds the view model
// from the roster and turns drag/drop/split gestures into CampaignArmy,
// UnitMerge and UnitSplit operations. The view never touches state; this
// class never touches the DOM beyond the view it owns.
//
// Drop on a card:
//   same type          -> merge the dragged unit into the target
//   reserve onto field -> move into an open slot, or swap when none is open
//   field onto reserve -> swap
// Drop on an area (or an open slot): move there if allowed.
//
// Split (from a card's Split menu):
//   the unit is divided in two (see UnitSplit). The new piece is fielded
//   when a slot is open, otherwise it waits in reserve, same as a purchase.

import { CampaignArmy } from './CampaignArmy.js';
import { canMerge, mergeInRoster } from './UnitMerge.js';
import { SplitMode, previewSplit, splitInRoster } from './UnitSplit.js';
import { UnitTypes } from '../config/UnitTypes.js';
import { unitIconSvg } from '../ui/UnitIcon.js';
import { ArmyManagerView } from '../ui/ArmyManagerView.js';

export class ArmyManagerController {
  constructor() {
    this.view = new ArmyManagerView();
  }

  // `onChange` fires after every successful change (use it to save);
  // `onClose` fires when the modal is dismissed.
  open(state, { onChange = null, onClose = null, onCardInfo = null } = {}) {
    const find = (id) => state.roster.find(e => e.id === id);
    const cap = () => CampaignArmy.capFor(state.champion);
    const changed = () => {
      if (onChange) onChange();
      return true;
    };

    this.view.show({
      getModel: () => this._buildModel(state),

      canMerge: (dragId, targetId) => canMerge(find(targetId), find(dragId)),

      onDropOnCard: (dragId, targetId) => {
        const dragged = find(dragId);
        const target = find(targetId);
        if (!dragged || !target || dragged === target) return false;

        if (canMerge(target, dragged)) {
          return mergeInRoster(state.roster, targetId, dragId) ? changed() : false;
        }

        const draggedFielded = CampaignArmy.isFielded(dragged);
        const targetFielded = CampaignArmy.isFielded(target);
        if (draggedFielded === targetFielded) return false;

        if (!draggedFielded && CampaignArmy.openSlots(state.roster, cap()) > 0) {
          return CampaignArmy.setFielded(state.roster, dragId, true, cap())
            ? changed() : false;
        }
        return CampaignArmy.swap(state.roster, dragId, targetId) ? changed() : false;
      },

      onDropOnPane: (dragId, pane) => {
        const entry = find(dragId);
        if (!entry) return false;
        const wantFielded = pane === 'fielded';
        if (CampaignArmy.isFielded(entry) === wantFielded) return true;
        return CampaignArmy.setFielded(state.roster, dragId, wantFielded, cap())
          ? changed() : false;
      },

      onSplit: (id, mode) => {
        const created = splitInRoster(state.roster, id, mode);
        if (!created) return false;
        CampaignArmy.placeNew(state.roster, created, cap());
        return changed();
      },

      onFill: () => (
        CampaignArmy.fillOpenSlots(state.roster, cap()) > 0 ? changed() : false
      ),

      onCardRightClick: (id, el) => {
        const entry = find(id);
        if (entry && onCardInfo) onCardInfo(entry, el);
      },

      onClose
    });
  }

  _buildModel(state) {
    const cap = CampaignArmy.capFor(state.champion);
    const fielded = CampaignArmy.fieldedEntries(state.roster).map(e => this._toCard(e));
    const reserve = CampaignArmy.reserveEntries(state.roster).map(e => this._toCard(e));
    const openSlots = CampaignArmy.openSlots(state.roster, cap);
    return {
      cap,
      fielded,
      reserve,
      openSlots,
      canFill: openSlots > 0 && reserve.length > 0
    };
  }

  _toCard(entry) {
    const typeDef = UnitTypes[entry.typeId];
    const baseName = entry.customName || typeDef.displayName;
    return {
      id: entry.id,
      name: entry.isUndead ? `Skeleton ${baseName}` : baseName,
      imageHtml: unitIconSvg(typeDef, entry.isUndead),
      level: entry.level || 1,
      aliveCount: entry.aliveCount,
      maxCount: entry.maxCount,
      depleted: entry.aliveCount < entry.maxCount,
      locked: !!entry.hasChampion,
      splits: this._buildSplitOptions(entry)
    };
  }

  // Menu entries for the split modes that are valid for this entry. The
  // text is built here so the view only renders strings.
  _buildSplitOptions(entry) {
    const options = [];

    const base = previewSplit(entry, SplitMode.BASE);
    if (base) {
      options.push({
        mode: SplitMode.BASE,
        label: `Split off ${base.detachedMax} soldiers (one base unit)`,
        detail: this._splitDetail(base)
      });
    }

    const half = previewSplit(entry, SplitMode.HALF);
    if (half) {
      options.push({
        mode: SplitMode.HALF,
        label: `Split in half (${half.keptMax} / ${half.detachedMax})`,
        detail: this._splitDetail(half)
      });
    }

    return options;
  }

  _splitDetail(plan) {
    return `${plan.keptAlive}/${plan.keptMax} stays \u00b7 `
      + `${plan.detachedAlive}/${plan.detachedMax} new unit`;
  }
}