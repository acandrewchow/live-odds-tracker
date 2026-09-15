import { findLeague, LEAGUES } from "@/lib/leagues";
import { fingerprint, getSnapshot } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const POLL_MS = Number(process.env.DK_POLL_MS) || 1000;
const HEARTBEAT_MS = 15_000;

/**
 * Server-sent events. The server polls DraftKings once per second and pushes a
 * frame only when a number actually changed, so an idle page costs one comment
 * line every 15s rather than a snapshot every second.
 */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("league");
  const league = findLeague(slug);
  if (!league) {
    return Response.json(
      {
        error: slug ? `Unknown league "${slug}"` : "Missing required ?league=",
        supported: LEAGUES.map((l) => l.slug),
      },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const poll: { timer?: ReturnType<typeof setInterval> } = {};
      let lastPrint = "";
      let lastHeartbeat = Date.now();

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (poll.timer) clearInterval(poll.timer);
        try {
          controller.close();
        } catch {
        }
      };

      // The client aborts the fetch on navigate/reload; stop polling when it does.
      request.signal.addEventListener("abort", close);

      const tick = async () => {
        if (closed) return;
        try {
          const snapshot = await getSnapshot(league);
          const print = fingerprint(snapshot);
          if (print !== lastPrint) {
            lastPrint = print;
            send("odds", snapshot);
            lastHeartbeat = Date.now();
          } else if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
            if (!closed) controller.enqueue(encoder.encode(`: keep-alive\n\n`));
            lastHeartbeat = Date.now();
          }
        } catch (err) {
          send("fault", { message: err instanceof Error ? err.message : "stream error" });
          close();
        }
      };

      poll.timer = setInterval(tick, POLL_MS);
      await tick();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
