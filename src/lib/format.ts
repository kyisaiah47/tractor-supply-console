export const n0 = (x: number | null | undefined) => (x == null ? "-" : Math.round(x).toLocaleString("en-US"));
export const usd = (x: number | null | undefined) => (x == null ? "-" : `$${Math.round(x).toLocaleString("en-US")}`);
export const usdShort = (x: number) =>
  x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${Math.round(x)}`;
export const pct = (x: number | null | undefined, d = 1) => (x == null ? "-" : `${(x * 100).toFixed(d)}%`);

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
