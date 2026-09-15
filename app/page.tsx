import { redirect } from "next/navigation";
import { LEAGUES } from "@/lib/leagues";

// Defaults to NFL
export default function Home() {
  redirect(`/league/${LEAGUES[0].slug}`);
}
