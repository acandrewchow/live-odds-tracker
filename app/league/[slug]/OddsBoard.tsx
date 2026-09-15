"use client";

import Link from "next/link";
import { useOdds } from "@/app/hooks/useOdds";
import type { Game, MarketKind, Side } from "@/lib/types";
import { movement } from "@/lib/movement";
import { LEAGUES, type League } from "@/lib/leagues";

// How long a price stays highlighted after moved
const FLASH_MS = 8000;

const fmtOdds = (n: number) => (n > 0 ? `+${n}` : `${n}`);

function Arrow({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      className="size-2 shrink-0 self-center text-fg"
      viewBox="0 0 10 10"
      aria-hidden
      focusable="false"
    >
      <path
        d={dir === "up" ? "M5 1.5 L9 8.5 L1 8.5 Z" : "M5 8.5 L1 1.5 L9 1.5 Z"}
        fill="currentColor"
      />
    </svg>
  );
}

const fmtLine = (kind: MarketKind, side: Side, index: number) => {
  if (side.line === undefined) return null;
  if (kind === "total") return `${index === 0 ? "O" : "U"} ${side.line}`;
  return side.line > 0 ? `+${side.line}` : `${side.line}`;
};

function leader(game: Game): "home" | "away" | null {
  if (!game.score) return null;
  const away = Number(game.score.away);
  const home = Number(game.score.home);
  if (!Number.isFinite(away) || !Number.isFinite(home) || away === home) return null;
  return away > home ? "away" : "home";
}

function TeamRow({
  name,
  score,
  leading,
}: {
  name: string;
  score?: string;
  leading: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 truncate">{name}</span>
      {score !== undefined && (
        <span
          className={`shrink-0 min-w-[1.5ch] text-right font-semibold tabular-nums ${
            leading ? "text-fg" : "text-muted"
          }`}
        >
          {score}
        </span>
      )}
    </div>
  );
}

function shortPeriod(period: string | undefined): string {
  if (!period) return "";
  return period.replace(/\s*(Quarter|Period|Inning)\b/i, "").trim();
}

function kickoff(iso: string): { top: string; bottom: string } {
  const d = new Date(iso);
  return {
    top: d.toLocaleDateString(undefined, { weekday: "short" }),
    bottom: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

function Cell({
  game,
  kind,
  now,
}: {
  game: Game;
  kind: MarketKind;
  now: number;
}) {
  const market = game.markets[kind];
  if (!market) {
    return (
      <td className="px-3.5 py-3 align-middle">
        <span className="text-muted">—</span>
      </td>
    );
  }

  return (
    <td className="px-3.5 py-3 align-middle">
      {market.sides.map((side, i) => {
        const recentlyMoved =
          side.changedAt !== undefined && now - side.changedAt < FLASH_MS;
        const dir = movement(side);
        const line = fmtLine(kind, side, i);
        const showMove = recentlyMoved && dir !== null;

        return (
          <div
            key={`${side.label}-${i}`}
            className={`-mx-[7px] -my-[3px] flex items-baseline gap-[7px] rounded-md px-[7px] py-[3px] tabular-nums transition-colors duration-700 not-first:mt-[5px] ${
              showMove ? "bg-moved-bg shadow-[inset_2px_0_0_var(--moved-accent)]" : ""
            }`}
          >
            {line && <span className="min-w-[46px] font-medium text-fg">{line}</span>}
            <span className="inline-flex items-baseline gap-1">
              {showMove && <Arrow dir={dir} />}
              <span className={showMove ? "font-semibold text-fg" : "text-muted"}>
                {fmtOdds(side.odds)}
              </span>
            </span>
            {showMove && side.prevOdds !== undefined && (
              <span className="text-[0.76rem] text-muted line-through opacity-70" title="previous price">
                {fmtOdds(side.prevOdds)}
              </span>
            )}
            {showMove && (
              <span className="sr-only">
                {` moved ${dir} from ${
                  side.prevOdds !== undefined ? fmtOdds(side.prevOdds) : "previous line"
                }`}
              </span>
            )}
          </div>
        );
      })}
    </td>
  );
}

export default function OddsBoard({ league }: { league: League }) {
  const { snapshot, connection, stale, ageMs, now, refresh, refreshing } =
    useOdds(league);

  const statusLabel =
    connection === "live"
      ? "live"
      : connection === "polling"
        ? "polling (stream unavailable)"
        : connection === "reconnecting"
          ? "reconnecting…"
          : "connecting…";

  return (
    <main className="mx-auto max-w-[1040px] px-5 pt-8 pb-16">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-[1.45rem] font-semibold tracking-tight">DraftKings Live Odds</h1>
          <div className="mt-3 inline-flex gap-0.5 rounded-lg border border-line bg-surface p-0.5" role="tablist" aria-label="League">
            {LEAGUES.map((l) => (
              <Link
                key={l.slug}
                href={`/league/${l.slug}`}
                role="tab"
                aria-selected={l.slug === league.slug}
                aria-current={l.slug === league.slug ? "page" : undefined}
                className={`rounded-md px-4 py-[5px] text-sm font-medium transition-colors ${
                  l.slug === league.slug
                    ? "bg-bg text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]"
                    : "text-muted hover:text-fg"
                }`}
              >
                {l.name}
              </Link>
            ))}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-[7px]">
            <span
              className={`size-2 shrink-0 rounded-full ${
                connection === "live" && !stale
                  ? "dot-live bg-good"
                  : "bg-warn"
              }`}
              aria-hidden
            />
            <span className="text-sm tabular-nums text-fg">{statusLabel}</span>
          </div>

          <div className="text-xs tabular-nums text-muted">
            {snapshot?.lastSuccessAt ? (
              <>
                updated {(ageMs / 1000).toFixed(1)}s ago
                {snapshot.fetchMs ? ` · ${snapshot.fetchMs}ms upstream` : ""}
              </>
            ) : (
              "waiting for first snapshot"
            )}
          </div>

          <button
            className="mt-0.5 cursor-pointer rounded-[7px] border border-line bg-surface px-3.5 py-1.5 text-sm font-medium text-fg transition-colors hover:not-disabled:border-line-strong hover:not-disabled:bg-surface-hover disabled:cursor-default disabled:opacity-55"
            onClick={refresh}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {stale && snapshot && (
        <div className="mb-4 rounded-lg border border-warn-line bg-warn-bg px-3.5 py-2.5 text-[0.83rem] leading-relaxed text-warn-fg" role="status">
          <strong>Showing last known prices</strong>{" "}
          {snapshot.error
            ? `DraftKings is not responding (${snapshot.error}).`
            : "No fresh data from DraftKings."}{" "}
          These numbers are {(ageMs / 1000).toFixed(0)}s old. Lines may have moved
        </div>
      )}

      {!snapshot ? (
        <p className="py-10 text-center text-sm text-muted">Loading odds…</p>
      ) : snapshot.games.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">
          DraftKings is not offering any {league.name} games right now.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[10px] border border-line">
          <table className="w-full min-w-[720px] border-collapse text-[0.87rem] [&_tbody_tr+tr_td]:border-t [&_tbody_tr+tr_td]:border-line [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:border-b [&_thead_th]:border-line [&_thead_th]:bg-surface [&_thead_th]:px-3.5 [&_thead_th]:py-2.5 [&_thead_th]:text-left [&_thead_th]:text-[0.7rem] [&_thead_th]:font-semibold [&_thead_th]:tracking-wider [&_thead_th]:uppercase [&_thead_th]:text-muted">
            <thead>
              <tr>
                <th className="w-2/5">Game</th>
                <th>{league.spreadLabel}</th>
                <th>Total</th>
                <th>Moneyline</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.games.map((game) => (
                <tr key={game.id}>
                  <td className="flex items-center gap-3.5 px-3.5 py-3">
                    <div className="flex w-[70px] shrink-0 flex-col gap-[5px] text-[0.72rem]/[1.25] tabular-nums">
                      {game.live ? (
                        <>
                          <span className="font-bold tracking-wide text-good">LIVE</span>
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted" title={game.period}>
                            {shortPeriod(game.period)}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted">
                            {kickoff(game.startsAt).top}
                          </span>
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted">
                            {kickoff(game.startsAt).bottom}
                          </span>
                        </>
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-[5px] font-medium">
                      <TeamRow
                        name={game.away}
                        score={game.score?.away}
                        leading={leader(game) === "away"}
                      />
                      <TeamRow
                        name={game.home}
                        score={game.score?.home}
                        leading={leader(game) === "home"}
                      />
                    </div>
                  </td>
                  <Cell game={game} kind="spread" now={now} />
                  <Cell game={game} kind="total" now={now} />
                  <Cell game={game} kind="moneyline" now={now} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="mt-4 text-[0.74rem]/[1.6] text-muted">
        Server polls DraftKings once per second and pushes changes over SSE.
        Highlighted prices moved in the last {FLASH_MS / 1000}s.
      </footer>
    </main>
  );
}
