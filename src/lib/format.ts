export const n0 = (x: number | null | undefined) => (x == null ? "-" : Math.round(x).toLocaleString("en-US"));
export const usd = (x: number | null | undefined) => (x == null ? "-" : `$${Math.round(x).toLocaleString("en-US")}`);
export const pct = (x: number | null | undefined, d = 1) => (x == null ? "-" : `${(x * 100).toFixed(d)}%`);

// The API's error is a message, or a list of validation issues. Either way, one readable line.
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (Array.isArray(e)) return e.map((i) => [i?.loc?.at(-1), i?.msg].filter(Boolean).join(": ")).join("; ");
  return "the server did not say why. Try again.";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function day(s: string | null | undefined) {
  if (!s) return "-";
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function dayShort(s: string | null | undefined) {
  if (!s) return "-";
  const [, m, d] = s.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export function ym(s: string) {
  const [y, m] = s.split("-").map(Number);
  return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
}

export function stamp(iso: string | null | undefined) {
  if (!iso) return "never";
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const CANDIDATE_LABEL: Record<string, string> = {
  trailing_mean: "Last 12 months' average",
  seasonal_naive: "Same month last year",
  trend_seasonal: "Trend and season",
  trend_seasonal_market: "Trend, season and market data",
};

export const STAGE_LABEL: Record<string, string> = {
  awaiting_parts: "Awaiting parts",
  scheduled: "Scheduled",
  assembly: "Assembly",
  qa: "QA",
  ready: "Ready",
};
