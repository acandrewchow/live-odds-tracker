export type MarketKind = "moneyline" | "spread" | "total";

export type Side = {
  label: string;
  line?: number;
  odds: number;
  prevOdds?: number;
  prevLine?: number;
  changedAt?: number;
};

export type Market = {
  kind: MarketKind;
  sides: Side[];
};

export type Game = {
  id: string;
  startsAt: string;
  away: string;
  home: string;
  awayShort: string;
  homeShort: string;
  status: string;
  live: boolean;
  period?: string;
  score?: { away: string; home: string };
  markets: Partial<Record<MarketKind, Market>>;
};

export type Snapshot = {
  league: string;
  games: Game[];
  fetchedAt: number;
  fetchMs: number;
  lastSuccessAt: number;
  ageMs: number;
  failures: number;
  error?: string;
};
