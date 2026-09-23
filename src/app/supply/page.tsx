import { q } from "@/lib/db";
import { SupplyQueue } from "@/components/SupplyQueue";

export const dynamic = "force-dynamic";

export default async function SupplyPage() {
  const [counts, history] = await Promise.all([
    q<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM supply_orders WHERE source <> 'history' GROUP BY 1`),
    q<{ placed: number; fulfilled: number }>(
      `SELECT COUNT(*) FILTER (WHERE status='placed')::int AS placed, COUNT(*) FILTER (WHERE status='fulfilled')::int AS fulfilled
         FROM supply_orders WHERE source = 'history'`,
    ),
  ]);
  const c = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  return (
    <>
      <div className="pagebar">
        <h1>Supply orders</h1>
        <span className="meta">
          {c.queued ?? 0} awaiting quotes, {c.placed ?? 0} placed, {c.failed ?? 0} failed. Before the planning date: {history[0]?.fulfilled.toLocaleString()}{" "}
          delivered and {history[0]?.placed} on the way.
        </span>
      </div>
      <SupplyQueue />
    </>
  );
}
