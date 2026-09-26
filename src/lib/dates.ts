// Date helpers on 'YYYY-MM-DD' strings in UTC, so no time zone can shift a day.

export function addDays(s: string, n: number): string {
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
