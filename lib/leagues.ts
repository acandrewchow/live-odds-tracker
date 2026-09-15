/**
 * The leagues that DraftKings offers (bound to change if new Sportsbooks are added)
 */
export type LeagueSlug = "nfl" | "mlb";

export type League = {
  slug: LeagueSlug;
  id: string;
  name: string;
  spreadLabel: string;
};

export const LEAGUES: readonly League[] = [
  { slug: "nfl", id: "88808", name: "NFL", spreadLabel: "Spread" },
  { slug: "mlb", id: "84240", name: "MLB", spreadLabel: "Run Line" },
] as const;

export function findLeague(slug: string | null | undefined): League | undefined {
  return LEAGUES.find((l) => l.slug === slug);
}
