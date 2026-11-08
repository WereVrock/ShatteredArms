// ===== AutoPlayerProfiles.js =====
// The automated campaign players. `tierName` is the AI tier that drives
// the player's own army. The board row uses only `playerName`.
//
// The names are written with \u escapes so the file survives any editor
// or encoding round-trip.
export const AUTO_PLAYER_PROFILES = [
  {
    id: 'best',
    playerName: 'Tayyar I',
    tierName: 'best_possible'
  },
  {
    id: 'weak',
    playerName: 'Mc Donald Turp',
    tierName: 'weakened'
  }
];