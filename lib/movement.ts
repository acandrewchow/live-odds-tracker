import type { Side } from "./types";

export function movement(side: Side): "up" | "down" | null {
  if (side.prevOdds !== undefined && side.odds !== side.prevOdds) {
    return side.odds > side.prevOdds ? "up" : "down";
  }
  if (
    side.prevLine !== undefined &&
    side.line !== undefined &&
    side.line !== side.prevLine
  ) {
    return side.line > side.prevLine ? "up" : "down";
  }
  return null;
}

export function toDecimal(american: number): number {
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}
