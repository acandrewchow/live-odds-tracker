import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findLeague, LEAGUES } from "@/lib/leagues";
import OddsBoard from "./OddsBoard";

export function generateStaticParams() {
  return LEAGUES.map((l) => ({ slug: l.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const league = findLeague((await params).slug);
  if (!league) return { title: "Unknown league" };
  return {
    title: `DraftKings ${league.name} Live Odds`,
    description: `Live ${league.name} moneyline, ${league.spreadLabel.toLowerCase()} and total odds from DraftKings.`,
  };
}

export default async function LeaguePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const league = findLeague((await params).slug);

  if (!league) notFound();

  return <OddsBoard league={league} />;
}
