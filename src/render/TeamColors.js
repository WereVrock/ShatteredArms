// Team -> color mapping used at render time.
export const TeamColors = {
  blue: 0x3a6ea5,
  red: 0xa53a3a
};

export function getTeamColor(teamId) {
  return TeamColors[teamId] ?? 0xaaaaaa;
}