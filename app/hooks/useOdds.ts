"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { computeAge } from "@/lib/age";
import type { League } from "@/lib/leagues";
import type { Snapshot } from "@/lib/types";

export type Connection = "connecting" | "live" | "reconnecting" | "polling";

const STALE_AFTER_MS = 10_000;
/** Consecutive stream drops before we give up on SSE and poll instead. */
const SSE_FAILURES_BEFORE_FALLBACK = 3;
const POLL_INTERVAL_MS = 2000;

type Received = { snapshot: Snapshot; receivedAt: number };

export function useOdds(league: League) {
  const [received, setReceived] = useState<Received | null>(null);
  const setSnapshot = useCallback(
    (snapshot: Snapshot) => {
      if (snapshot.league && snapshot.league !== league.slug) return;
      setReceived({ snapshot, receivedAt: Date.now() });
    },
    [league.slug],
  );
  const [connection, setConnection] = useState<Connection>("connecting");
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);

  const sseFailures = useRef(0);
  const fellBack = useRef(false);

  const [shownLeague, setShownLeague] = useState(league.slug);
  if (shownLeague !== league.slug) {
    setShownLeague(league.slug);
    setReceived(null);
    setConnection("connecting");
  }
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/odds?league=${league.slug}&force=1`, {
        cache: "no-store",
      });
      if (res.ok) setSnapshot(await res.json());
    } catch {
    } finally {
      setRefreshing(false);
    }
  }, [setSnapshot, league.slug]);

  useEffect(() => {
    let canceled = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    sseFailures.current = 0;
    fellBack.current = false;

    /** Last resort when SSE cannot hold: plain polling, slower but reliable. */
    const startPolling = () => {
      if (canceled || fellBack.current) return;
      fellBack.current = true;
      setConnection("polling");
      const poll = async () => {
        try {
          const res = await fetch(`/api/odds?league=${league.slug}`, {
            cache: "no-store",
          });
          if (res.ok && !canceled) setSnapshot(await res.json());
        } catch {
        }
      };
      void poll();
      pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    };

    const connect = () => {
      if (canceled) return;
      source = new EventSource(`/api/stream?league=${league.slug}`);

      source.onopen = () => {
        if (canceled) return;
        sseFailures.current = 0;
        setConnection("live");
      };

      source.addEventListener("odds", (ev) => {
        if (canceled) return;
        try {
          setSnapshot(JSON.parse((ev as MessageEvent).data));
          setConnection("live");
        } catch {
          
        }
      });

      source.addEventListener("fault", () => {
        source?.close();
        handleDrop();
      });

      source.onerror = () => {
        if (canceled) return;
        setConnection("reconnecting");
        handleDrop();
      };
    };

    const handleDrop = () => {
      sseFailures.current += 1;
      if (sseFailures.current >= SSE_FAILURES_BEFORE_FALLBACK) {
        source?.close();
        startPolling();
      }
    };

    connect();

    return () => {
      canceled = true;
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [setSnapshot, league.slug]);

  const snapshot = received?.snapshot ?? null;

  const ageMs = computeAge(received?.snapshot.ageMs, received?.receivedAt, now);

  const stale = !snapshot || ageMs > STALE_AFTER_MS || (snapshot.failures ?? 0) > 0;

  return { snapshot, connection, stale, ageMs, now, refresh, refreshing };
}
