import { fetchOdds } from "./draftkings";
import type { League } from "./leagues";
import type { Game, MarketKind, Snapshot } from "./types";

/**
 * Process-wide cache of the latest DraftKings snapshot.
 *
 * On Vercel this lives per warm function instance, so two concurrent instances
 * poll DraftKings independently. That is fine at this scale — the point of the
 * cache is that N browsers watching the page do not become N× load upstream.
 */

/**
 * How long a snapshot is considered fresh enough to serve without refetching.
 * Kept just under the poll interval so the stream never serves a stale frame,
 * while still collapsing concurrent callers onto one upstream request.
 */
const POLL_MS = Number(process.env.DK_POLL_MS) || 1000;
const CACHE_TTL_MS = Math.max(100, Math.floor(POLL_MS * 0.75));
/** Past this age with no successful fetch, the UI stops trusting the numbers. */
export const STALE_AFTER_MS = 10_000;
/**
 * Floor on how fresh a forced refresh insists on being. The Refresh button
 * bypasses the normal TTL, but not this: without a floor every click maps 1:1
 * onto an upstream request, and a held-down button (or a script hitting
 * `/api/odds?force=1`) is unbounded load on DraftKings.
 *
 * Derived from the poll interval rather than fixed, so it stays *below*
 * CACHE_TTL_MS at every setting. A fixed 500 ms would exceed the 375 ms TTL at
 * DK_POLL_MS=500 and invert the whole point of the button — Refresh would
 * refuse to refetch data the background poll was about to replace anyway.
 */
const FORCE_MIN_AGE_MS = Math.max(100, Math.min(500, Math.floor(POLL_MS * 0.5)));
/** Backoff schedule after consecutive upstream failures. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 15_000];

type SideState = {
  odds: number;
  line?: number;
  prevOdds?: number;
  prevLine?: number;
  /** Epoch ms of the last move; 0 means "never moved since we started watching". */
  changedAt: number;
};

/**
 * Per-league state. Each league polls independently and keeps its own price
 * history, cache age and backoff — an MLB outage must not mark NFL stale, and
 * the single-flight guard has to be per-league or one league's in-flight
 * request would satisfy another's caller with the wrong sport's data.
 */
type LeagueState = {
  lastGames: Game[];
  lastSuccessAt: number;
  lastFetchMs: number;
  failures: number;
  lastError?: string;
  nextAttemptAt: number;
  /** key -> last seen price, so we can show what moved and when. */
  sideHistory: Map<string, SideState>;
  /** In-flight request, shared by every caller that arrives while it runs. */
  inFlight: Promise<void> | null;
};

const states = new Map<string, LeagueState>();

function stateFor(league: League): LeagueState {
  let st = states.get(league.slug);
  if (!st) {
    st = {
      lastGames: [],
      lastSuccessAt: 0,
      lastFetchMs: 0,
      failures: 0,
      nextAttemptAt: 0,
      sideHistory: new Map(),
      inFlight: null,
    };
    states.set(league.slug, st);
  }
  return st;
}

const sideKey = (gameId: string, kind: MarketKind, label: string) =>
  `${gameId}|${kind}|${label}`;

/**
 * Diff the incoming games against what we saw last time and annotate each side
 * with its previous price. Mutates `games` in place.
 */
function annotateChanges(
  st: LeagueState,
  games: Game[],
  now: number,
): void {
  for (const game of games) {
    for (const market of Object.values(game.markets)) {
      if (!market) continue;
      for (const side of market.sides) {
        const key = sideKey(game.id, market.kind, side.label);
        const prev = st.sideHistory.get(key);

        // First sighting: record it, but do not report it as a move.
        if (!prev) {
          st.sideHistory.set(key, { odds: side.odds, line: side.line, changedAt: 0 });
          continue;
        }

        const moved = prev.odds !== side.odds || prev.line !== side.line;
        const next: SideState = moved
          ? {
              odds: side.odds,
              line: side.line,
              prevOdds: prev.odds,
              prevLine: prev.line,
              changedAt: now,
            }
          : prev;
        st.sideHistory.set(key, next);

        // Carry the last move forward on every subsequent poll, so the UI can
        // keep showing "was -110" for as long as it wants to rather than for
        // the single poll in which the change happened to land.
        if (next.changedAt > 0) {
          side.prevOdds = next.prevOdds;
          side.prevLine = next.prevLine;
          side.changedAt = next.changedAt;
        }
      }
    }
  }
}

function buildSnapshot(league: League, st: LeagueState): Snapshot {
  return {
    league: league.slug,
    games: st.lastGames,
    fetchedAt: st.lastSuccessAt,
    fetchMs: st.lastFetchMs,
    lastSuccessAt: st.lastSuccessAt,
    ageMs: st.lastSuccessAt ? Date.now() - st.lastSuccessAt : -1,
    failures: st.failures,
    ...(st.failures > 0 && st.lastError ? { error: st.lastError } : {}),
  };
}

async function refreshNow(league: League, st: LeagueState): Promise<void> {
  const now = Date.now();
  try {
    const { games, fetchMs } = await fetchOdds(league);
    annotateChanges(st, games, now);
    st.lastGames = games;
    st.lastSuccessAt = Date.now();
    st.lastFetchMs = fetchMs;
    st.failures = 0;
    st.lastError = undefined;
    st.nextAttemptAt = 0;
  } catch (err) {
    st.failures += 1;
    st.lastError = err instanceof Error ? err.message : String(err);
    const delay = BACKOFF_MS[Math.min(st.failures - 1, BACKOFF_MS.length - 1)];
    st.nextAttemptAt = Date.now() + delay;
  }
}

/**
 * Return the current snapshot for one league, refetching if the cached one has
 * aged out. If DraftKings is unreachable we serve the last data
 */
export async function getSnapshot(
  league: League,
  opts: { force?: boolean } = {},
): Promise<Snapshot> {
  const st = stateFor(league);
  const now = Date.now();
  const age = now - st.lastSuccessAt;
  const backingOff = st.failures > 0 && now < st.nextAttemptAt;
  const threshold = opts.force ? FORCE_MIN_AGE_MS : CACHE_TTL_MS;
  const needsFetch = age > threshold && !backingOff;

  if (needsFetch) {
    if (!st.inFlight) {
      st.inFlight = refreshNow(league, st).finally(() => {
        st.inFlight = null;
      });
    }
    await st.inFlight;
  }

  return buildSnapshot(league, st);
}

export function fingerprint(snapshot: Snapshot): string {
  const parts: string[] = [];
  for (const game of snapshot.games) {
    for (const market of Object.values(game.markets)) {
      if (!market) continue;
      for (const side of market.sides) {
        parts.push(`${game.id}${market.kind}${side.label}${side.odds}${side.line ?? ""}`);
      }
    }
  }
  parts.push(`f${snapshot.failures}`);
  return parts.join("");
}
