/**
 * How old the numbers on screen are, in milliseconds.
 */
export function computeAge(
  snapshotAgeMs: number | undefined,
  receivedAt: number | undefined,
  now: number,
): number {
  if (snapshotAgeMs === undefined || receivedAt === undefined) return Infinity;
  if (snapshotAgeMs < 0) return Infinity;
  return snapshotAgeMs + Math.max(0, now - receivedAt);
}
