// Part allocation: walks every open customer order in the order its build needs parts, and
// gives each one stock on hand plus inbound supply orders expected to have arrived by then.
// An order whose parts are all allocated is "covered"; otherwise it is "short" by the parts
// listed. This is recomputed on every read, so a newly placed supply order shows immediately.

import { q } from "./db";
import { AS_OF } from "./config";
import { addDays } from "./dates";
import { TRACTOR_MODELS } from "./catalog";
import { latestRuns } from "./models";

export type Shortfall = { sku: string; category: string; short: number };
export type Allocation = Map<number, { needDate: string; status: "covered" | "short"; shortfalls: Shortfall[] }>;

const BUILD_DAYS = Object.fromEntries(TRACTOR_MODELS.map((m) => [m.code, m.buildDays]));

export async function allocate(): Promise<Allocation> {
  const [orders, bom, onHand, inbound, runs] = await Promise.all([
    q<{ id: number; tractor_model: string; quantity: number; requested_date: string; scheduled_start: string | null }>(
      `SELECT o.id, o.tractor_model, o.quantity, o.requested_date, pp.scheduled_start
         FROM customer_orders o LEFT JOIN production_pipeline pp ON pp.customer_order_id = o.id
        WHERE o.status IN ('open','in_production')`,
    ),
    q<{ sku: string; tractor_model: string; category: string; qty_per_tractor: number }>(
      `SELECT sku, tractor_model, category, qty_per_tractor FROM parts`,
    ),
    q<{ sku: string; units: number }>(`SELECT sku, SUM(on_hand)::int AS units FROM inventory GROUP BY 1`),
    q<{ sku: string; supplier: string | null; quantity: number; status: string; date_ordered: string; promised_date: string | null }>(
      `SELECT sku, supplier, quantity, status, date_ordered, promised_date FROM supply_orders WHERE status IN ('queued','placed')`,
    ),
    latestRuns(),
  ]);

  const quarter = Math.floor((Number(AS_OF.slice(5, 7)) - 1) / 3);
  const delayBySupplier = new Map(
    (runs?.supplier_delay.output.suppliers ?? []).map((s) => [s.supplier, s.byQuarter[quarter]]),
  );
  const arrivals = new Map<string, { date: string; units: number }[]>();
  for (const s of inbound) {
    const date =
      s.status === "placed" && s.promised_date
        ? addDays(s.promised_date, Math.round(delayBySupplier.get(s.supplier ?? "") ?? 14))
        : addDays(s.date_ordered, 45);
    (arrivals.get(s.sku) ?? arrivals.set(s.sku, []).get(s.sku)!).push({ date, units: s.quantity });
  }
  for (const a of arrivals.values()) a.sort((x, y) => x.date.localeCompare(y.date));

  const bomByModel = new Map<string, typeof bom>();
  for (const b of bom) (bomByModel.get(b.tractor_model) ?? bomByModel.set(b.tractor_model, []).get(b.tractor_model)!).push(b);

  const need = orders
    .map((o) => ({ ...o, needDate: o.scheduled_start ?? addDays(o.requested_date, -(BUILD_DAYS[o.tractor_model] + 3)) }))
    .sort((a, b) => a.needDate.localeCompare(b.needDate) || a.id - b.id);

  const stock = new Map(onHand.map((o) => [o.sku, o.units]));
  const cursor = new Map<string, number>();
  const out: Allocation = new Map();
  for (const o of need) {
    const shortfalls: Shortfall[] = [];
    for (const b of bomByModel.get(o.tractor_model) ?? []) {
      const list = arrivals.get(b.sku) ?? [];
      let i = cursor.get(b.sku) ?? 0;
      let avail = stock.get(b.sku) ?? 0;
      while (i < list.length && list[i].date <= o.needDate) avail += list[i++].units;
      cursor.set(b.sku, i);
      const want = o.quantity * b.qty_per_tractor;
      if (avail >= want) {
        stock.set(b.sku, avail - want);
      } else {
        stock.set(b.sku, 0);
        shortfalls.push({ sku: b.sku, category: b.category, short: want - Math.max(0, avail) });
      }
    }
    out.set(o.id, { needDate: o.needDate, status: shortfalls.length ? "short" : "covered", shortfalls });
  }
  return out;
}
