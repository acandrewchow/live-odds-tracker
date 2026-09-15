import { NextRequest } from "next/server";
import { findLeague, LEAGUES } from "@/lib/leagues";
import { getSnapshot } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Point-in-time snapshot for one league. Used as the target of the Refresh
 * button (`?force=1`) and as the fallback when SSE is unavailable.
 */
export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("league");
  const league = findLeague(slug);

  if (!league) {
    return Response.json(
      {
        error: slug ? `Unknown league "${slug}"` : "Missing required ?league=",
        supported: LEAGUES.map((l) => l.slug),
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const force = req.nextUrl.searchParams.get("force") === "1";
  const snapshot = await getSnapshot(league, { force });

  return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
