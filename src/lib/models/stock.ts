// When each part runs out if nothing new arrives: on-hand stock consumed by the production
// pipeline in scheduled-start order. This is the need-by date for open supply orders.

import { q } from "../db";

export async function loadStockout() {
  const onHand = await q<{ sku: string; units: number }>(`SELECT sku, SUM(on_hand)::int AS units FROM inventory GROUP BY 1`);
  const demand = await q<{ sku: string; scheduled_start: string; units: number }>(
    `SELECT p.sku, pp.scheduled_start, (o.quantity * p.qty_per_tractor)::int AS units
       FROM production_pipeline pp
       JOIN customer_orders o ON o.id = pp.customer_order_id
       JOIN parts p ON p.tractor_model = o.tractor_model
      ORDER BY p.sku, pp.scheduled_start, o.id`,
  );
  return computeStockout(onHand, demand);
}

export function computeStockout(
  onHand: { sku: string; units: number }[],
  demand: { sku: string; scheduled_start: string; units: number }[],
) {
  const stock = new Map(onHand.map((o) => [o.sku, o.units]));
  const used = new Map<string, number>();
  const out = new Map<string, string | null>();
  for (const s of stock.keys()) out.set(s, null);
  for (const d of demand) {
    if (out.get(d.sku)) continue;
    const u = (used.get(d.sku) ?? 0) + d.units;
    used.set(d.sku, u);
    if (u > (stock.get(d.sku) ?? 0)) out.set(d.sku, d.scheduled_start);
  }
  return [...out.entries()].map(([sku, date]) => ({ sku, date }));
}
