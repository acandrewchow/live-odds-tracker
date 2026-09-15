import type { League } from "./leagues";
import type { Game, Market, MarketKind, Side } from "./types";

/**
 * DraftKings' sportscontent API.
 */
const JURISDICTION = process.env.DK_JURISDICTION ?? "dkcaon";

/**
 * `DK_ODDS_URL` overrides the endpoint outright, for every league, so the
 */
export function dkUrl(leagueId: string): string {
  const override = process.env.DK_ODDS_URL;
  if (override) {
    const url = new URL(override);
    url.searchParams.set("league", leagueId);
    return url.toString();
  }
  return `https://sportsbook-nash.draftkings.com/api/sportscontent/${JURISDICTION}/v1/leagues/${leagueId}`;
}

/**
 * Akamai is used and rejects requests that do not look
 * like they came from the sportsbook's own web client. A bare GET returns a 403
 * `AkamaiGHost` "Access Denied" page. These headers are what turn it into a 200.
 * Note there is no cookie and no token here as it depends on the Request shape
 */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://sportsbook.draftkings.com",
  Referer: "https://sportsbook.draftkings.com/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
};

const FETCH_TIMEOUT_MS = 4000;

function parseAmerican(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const n = Number(raw.replace(/−/g, "-").replace(/[+\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function marketKind(name: unknown): MarketKind | undefined {
  switch (asString(name)?.toLowerCase()) {
    case "moneyline":
      return "moneyline";
    case "spread":
    case "run line":
    case "puck line":
      return "spread";
    case "total":
      return "total";
    default:
      return undefined;
  }
}

const SIDE_ORDER: Record<string, number> = { Away: 0, Home: 1, Over: 0, Under: 1 };

type Raw = Record<string, unknown>;
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);

/**
 * Map the DraftKings payload onto our own record
 */
export function normalize(payload: unknown): Game[] {
  const root = (payload ?? {}) as Raw;
  const events = arr(root.events);
  const markets = arr(root.markets);
  const selections = arr(root.selections);

  const selectionsByMarket = new Map<string, Raw[]>();
  for (const s of selections) {
    const mid = asString(s.marketId);
    if (!mid) continue;
    const list = selectionsByMarket.get(mid);
    if (list) list.push(s);
    else selectionsByMarket.set(mid, [s]);
  }

  const marketsByEvent = new Map<string, Raw[]>();
  for (const m of markets) {
    const eid = asString(m.eventId);
    if (!eid) continue;
    const list = marketsByEvent.get(eid);
    if (list) list.push(m);
    else marketsByEvent.set(eid, [m]);
  }

  const games: Game[] = [];

  for (const ev of events) {
    const id = asString(ev.id);
    const startsAt = asString(ev.startEventDate);
    if (!id || !startsAt) continue;

    const participants = arr(ev.participants);
    const find = (role: string) =>
      participants.find((p) => asString(p.venueRole) === role);
    const home = find("Home");
    const away = find("Away");
    const homeName = asString(home?.name);
    const awayName = asString(away?.name);
    if (!homeName || !awayName) continue;

    const shortOf = (p: Raw | undefined, fallback: string) =>
      asString((p?.metadata as Raw | undefined)?.shortName) ?? fallback;

    const status = asString(ev.status) ?? "UNKNOWN";
    const liveState = ev.liveGameState as Raw | undefined;
    const scorecard = (ev.eventScorecard as Raw | undefined)?.mainScorecard as
      | Raw
      | undefined;

    const built: Partial<Record<MarketKind, Market>> = {};

    for (const m of marketsByEvent.get(id) ?? []) {
      const mid = asString(m.id);
      const kind =
        marketKind(m.name) ?? marketKind((m.marketType as Raw | undefined)?.name);
      // Ignore anything that is not one of the three main markets, and keep the
      // first of each kind if DraftKings ever sends duplicates.
      if (!mid || !kind || built[kind]) continue;

      const sides: Side[] = [];
      for (const s of selectionsByMarket.get(mid) ?? []) {
        const label = asString(s.label);
        const odds = parseAmerican((s.displayOdds as Raw | undefined)?.american);
        if (!label || odds === undefined) continue;
        const line = typeof s.points === "number" ? s.points : undefined;
        sides.push({ label, odds, ...(line !== undefined ? { line } : {}) });
      }
      if (sides.length === 0) continue;

      const selectionsRaw = selectionsByMarket.get(mid) ?? [];
      sides.sort((a, b) => {
        const rank = (side: Side) => {
          const match = selectionsRaw.find((s) => asString(s.label) === side.label);
          return SIDE_ORDER[asString(match?.outcomeType) ?? ""] ?? 99;
        };
        return rank(a) - rank(b);
      });

      built[kind] = { kind, sides };
    }

    // A game with no main markets priced (suspended, or just not offered) is
    // still worth showing — the UI renders it with empty cells.
    games.push({
      id,
      startsAt,
      home: homeName,
      away: awayName,
      homeShort: shortOf(home, homeName),
      awayShort: shortOf(away, awayName),
      status,
      live: status === "STARTED",
      period: asString(liveState?.period),
      score: scorecard
        ? {
            // firstTeamScore tracks the away participant, secondTeamScore the home one.
            away: asString(scorecard.firstTeamScore) ?? "0",
            home: asString(scorecard.secondTeamScore) ?? "0",
          }
        : undefined,
      markets: built,
    });
  }

  games.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return games;
}

export type FetchResult = { games: Game[]; fetchMs: number };

/**
 * Error response body
 */
async function describeBody(res: Response): Promise<string> {
  try {
    const raw = await res.text();
    const text = raw
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return "";
    return ` — ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`;
  } catch {
    return "";
  }
}

export async function fetchOdds(league: League): Promise<FetchResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(dkUrl(league.id), {
      headers: BROWSER_HEADERS,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(
        `DraftKings returned HTTP ${res.status}${await describeBody(res)}`,
      );
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new Error("DraftKings returned a non-JSON body");
    }

    const games = normalize(payload);
    return { games, fetchMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
