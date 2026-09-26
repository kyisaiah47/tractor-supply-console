import { api } from "@/lib/api";
import type { SupplySummary } from "@/lib/types";
import { SupplyQueue } from "@/components/SupplyQueue";

export const dynamic = "force-dynamic";

export default async function SupplyPage() {
  const { console: c, history } = await api<SupplySummary>("/api/supply-orders/summary");
  return (
    <>
      <div className="pagebar">
        <h1>Supply orders</h1>
        <span className="meta">
          {c.queued ?? 0} awaiting quotes, {c.placed ?? 0} placed, {c.failed ?? 0} failed. Before the planning date: {history.fulfilled.toLocaleString()}{" "}
          delivered and {history.placed} on the way.
        </span>
      </div>
      <SupplyQueue />
    </>
  );
}
