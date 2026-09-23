// Date helpers on 'YYYY-MM-DD' strings in UTC, so no timezone can shift a day.

export function parseDay(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00Z`);
}

export function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(s: string, n: number): string {
  const d = parseDay(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDay(d);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseDay(a).getTime() - parseDay(b).getTime()) / 86_400_000);
}

export function monthKey(s: string): string {
  return s.slice(0, 7);
}

export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function addMonthsDay(s: string, n: number): string {
  const ym = addMonths(s.slice(0, 7), n);
  const d = Math.min(Number(s.slice(8, 10)), daysInMonth(ym));
  return `${ym}-${String(d).padStart(2, "0")}`;
}

// Today in the machine's local time zone, as YYYY-MM-DD.
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function monthRange(fromYm: string, toYm: string): string[] {
  const out: string[] = [];
  for (let ym = fromYm; ym <= toYm; ym = addMonths(ym, 1)) out.push(ym);
  return out;
}

export function monthIndex(ym: string): number {
  return Number(ym.slice(5, 7)) - 1;
}

export function daysInMonth(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthLabel(ym: string): string {
  return `${MONTHS[monthIndex(ym)]} ${ym.slice(2, 4)}`;
}

export function dayLabel(s: string): string {
  const d = parseDay(s);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
