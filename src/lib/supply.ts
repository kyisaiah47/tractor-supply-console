// Creating supply orders. Every path (the dashboard's "Order all selected", a recommendation,
// the chatbot after the user confirms, a direct API call) ends here: rows are written as
// 'queued' with a job each, and the worker places them with a supplier asynchronously.

import { z } from "zod";
import { q, tx } from "./db";
import { AS_OF } from "./config";
import { allocate } from "./allocation";
import { latestRuns } from "./models";

export const SupplyLine = z.object({
  sku: z.string().min(3),
  quantity: z.number().int().positive().max(100_000),
  warehouse: z.string().length(2).optional(),
  supplier: z.string().optional(),
  customerOrderId: z.number().int().optional(),
  note: z.string().max(500).optional(),
});
export type SupplyLine = z.infer<typeof SupplyLine>;

export const SupplySource = z.enum(["order_form", "selected_orders", "recommendation", "chatbot", "api"]);
const SOURCE_LABEL: Record<z.infer<typeof SupplySource>, string> = {
  order_form: "the order form",
  selected_orders: "Order all selected",
  recommendation: "a reorder recommendation",
  chatbot: "the planning assistant",
  api: "an integration",
};

// Supply lines that would cover the part shortfalls of the given customer orders.
export async function linesForCustomerOrders(ids: number[]) {
  const [alloc, orders, runs] = await Promise.all([
    allocate(),
    q<{ id: number; warehouse: string }>(`SELECT id, warehouse FROM customer_orders WHERE id = ANY($1)`, [ids]),
    latestRuns(),
  ]);
  const pick = new Map((runs?.inventory_strategy.output.rows ?? []).map((r) => [r.sku, r]));
  const whOf = new Map(orders.map((o) => [o.id, o.warehouse]));
  const merged = new Map<string, SupplyLine & { forOrders: number[] }>();
  let covered = 0;
  for (const id of ids) {
    const a = alloc.get(id);
    if (!a) continue;
    if (!a.shortfalls.length) covered++;
    for (const s of a.shortfalls) {
      const wh = whOf.get(id) ?? "IL";
      const key = `${s.sku}|${wh}`;
      const cur = merged.get(key) ?? { sku: s.sku, quantity: 0, warehouse: wh, supplier: pick.get(s.sku)?.supplier, forOrders: [] };
      cur.quantity += s.short;
      cur.forOrders.push(id);
      merged.set(key, cur);
    }
  }
  const lines = [...merged.values()].map((l) => {
    const rec = pick.get(l.sku);
    const fr = rec?.options.find((o) => o.supplier === l.supplier)?.failureRate ?? 0.05;
    return {
      ...l,
      quantity: Math.ceil(l.quantity / (1 - fr)),
      unitPrice: rec?.unitPrice ?? null,
      note: `Covers shortfall for customer order${l.forOrders.length > 1 ? "s" : ""} ${l.forOrders.join(", ")}, plus ${(fr * 100).toFixed(1)}% for expected failures.`,
    };
  });
  return { lines, covered, requested: ids.length };
}

export async function createSupplyOrders(lines: SupplyLine[], source: z.infer<typeof SupplySource>) {
  if (!lines.length) return [];
  return tx(async (c) => {
    const created: { id: number; jobId: number; sku: string; quantity: number }[] = [];
    for (const l of lines) {
      const part = await c.query(`SELECT 1 FROM parts WHERE sku = $1`, [l.sku]);
      if (!part.rowCount) throw new Error(`Unknown part ${l.sku}`);
      const so = await c.query<{ id: number }>(
        `INSERT INTO supply_orders (sku, supplier, warehouse, quantity, customer_order_id, date_ordered, status, source, note)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8) RETURNING id`,
        [l.sku, null, l.warehouse ?? "IL", l.quantity, l.customerOrderId ?? null, AS_OF, source, l.note ?? (l.supplier ? `Preferred supplier: ${l.supplier}` : null)],
      );
      const job = await c.query<{ id: number }>(
        `INSERT INTO supply_jobs (supply_order_id, log) VALUES ($1, $2) RETURNING id`,
        [so.rows[0].id, JSON.stringify([{ at: new Date().toISOString(), msg: `Ordered from ${SOURCE_LABEL[source]}. Asking suppliers for quotes.` }])],
      );
      created.push({ id: so.rows[0].id, jobId: job.rows[0].id, sku: l.sku, quantity: l.quantity });
    }
    return created;
  });
}
