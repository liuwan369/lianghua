/** Beijing calendar day used by account-level daily risk accounting. */
export function accountDayKey(unix: number): string {
  if (!Number.isFinite(unix)) throw new Error("invalid account timestamp");
  return new Date(unix * 1000 + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
