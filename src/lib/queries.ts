import { q, one } from "./db";
import { AS_OF } from "./config";
import { addMonthsDay } from "./dates";
import { allocate } from "./allocation";
import { latestRuns } from "./models";

export type OrdersTab = "pipeline" | "backlog";

export type OrdersQuery = {
  tab: OrdersTab;
  months: number; // pipeline: 1..3, backlog: 1..12
  model?: string;
  warehouse?: string;
  parts?: "covered" | "short";
  limit?: number;
  offset?: number;
};

export type OrderRow = {
  id: number;
  customer: string;
  customerId: number;
  tractorModel: string;
  quantity: number;
  warehouse: string;
  orderedAt: string;
  requestedDate: string;
  promisedDate: string | null;
  status: string;
  stage: string | null;
  scheduledStart: string | null;
  needDate: string;
  parts: "covered" | "short";
  shortfalls: { sku: string; category: string; short: number }[];
};

export function horizonEnd(months: number) {
  return addMonthsDay(AS_OF, months);
}

export async function listOrders(opts: OrdersQuery) {
  const months = Math.max(1, Math.min(opts.tab === "pipeline" ? 3 : 12, opts.months));
  const end = horizonEnd(months);
  const where = [`o.status IN ('open','in_production')`, `o.requested_date >= $1`, `o.requested_date < $2`];
  const params: unknown[] = [AS_OF, end];
  if (opts.tab === "pipeline") where.push(`pp.customer_order_id IS NOT NULL`);
  const base = `FROM customer_orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN production_pipeline pp ON pp.customer_order_id = o.id
     WHERE ${where.join(" AND ")}`;

  const [rows, alloc] = await Promise.all([
    q<{
      id: number;
      customer: string;
      customer_id: number;
      tractor_model: string;
      quantity: number;
      warehouse: string;
      ordered_at: string;
      requested_date: string;
      promised_date: string | null;
      status: string;
      stage: string | null;
      scheduled_start: string | null;
    }>(
      `SELECT o.id, c.name AS customer, c.id AS customer_id, o.tractor_model, o.quantity, o.warehouse, o.ordered_at,
              o.requested_date, o.promised_date, o.status, pp.stage, pp.scheduled_start
         ${base} ORDER BY o.requested_date, o.id`,
      params,
    ),
    allocate(),
  ]);

  const all: OrderRow[] = rows.map((r) => {
    const a = alloc.get(r.id);
    return {
      id: r.id,
      customer: r.customer,
      customerId: r.customer_id,
      tractorModel: r.tractor_model,
      quantity: r.quantity,
      warehouse: r.warehouse,
      orderedAt: r.ordered_at,
      requestedDate: r.requested_date,
      promisedDate: r.promised_date,
      status: r.status,
      stage: r.stage,
      scheduledStart: r.scheduled_start,
      needDate: a?.needDate ?? r.requested_date,
      parts: a?.status ?? "covered",
      shortfalls: a?.shortfalls ?? [],
    };
  });

  // Facets are counted before the chip filters so every chip shows what pressing it would give.
  const facet = (key: "tractorModel" | "warehouse" | "parts", rowsIn: OrderRow[]) => {
    const m = new Map<string, { orders: number; tractors: number }>();
    for (const r of rowsIn) {
      const k = String(r[key]);
      const v = m.get(k) ?? { orders: 0, tractors: 0 };
      v.orders++;
      v.tractors += r.quantity;
      m.set(k, v);
    }
    return Object.fromEntries([...m.entries()].sort());
  };
  const byModel = all.filter((r) => (!opts.warehouse || r.warehouse === opts.warehouse) && (!opts.parts || r.parts === opts.parts));
  const byWarehouse = all.filter((r) => (!opts.model || r.tractorModel === opts.model) && (!opts.parts || r.parts === opts.parts));
  const byParts = all.filter((r) => (!opts.model || r.tractorModel === opts.model) && (!opts.warehouse || r.warehouse === opts.warehouse));
  const filtered = byParts.filter((r) => !opts.parts || r.parts === opts.parts);

  const limit = Math.min(500, opts.limit ?? 200);
  const offset = opts.offset ?? 0;
  return {
    tab: opts.tab,
    months,
    asOf: AS_OF,
    through: end,
    totals: {
      orders: filtered.length,
      tractors: filtered.reduce((a, r) => a + r.quantity, 0),
      short: filtered.filter((r) => r.parts === "short").length,
    },
    facets: { model: facet("tractorModel", byModel), warehouse: facet("warehouse", byWarehouse), parts: facet("parts", byParts) },
    rows: filtered.slice(offset, offset + limit),
  };
}

export async function overview() {
  const [book, pipeline, supply, jobs, runs, lastOrder] = await Promise.all([
    one<{ orders: number; tractors: number }>(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(quantity),0)::int AS tractors FROM customer_orders
        WHERE status IN ('open','in_production') AND requested_date >= $1 AND requested_date < $2`,
      [AS_OF, horizonEnd(12)],
    ),
    one<{ orders: number; tractors: number }>(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(o.quantity),0)::int AS tractors
         FROM production_pipeline pp JOIN customer_orders o ON o.id = pp.customer_order_id`,
    ),
    one<{ placed: number; queued: number }>(
      `SELECT COUNT(*) FILTER (WHERE status='placed')::int AS placed, COUNT(*) FILTER (WHERE status='queued')::int AS queued FROM supply_orders`,
    ),
    one<{ pending: number; worker_seen: Date | null }>(
      `SELECT (SELECT COUNT(*) FROM supply_jobs WHERE status IN ('pending','running'))::int AS pending,
              (SELECT MAX(seen_at) FROM worker_heartbeats) AS worker_seen`,
    ),
    latestRuns(),
    one<{ at: string }>(`SELECT MAX(ordered_at)::text AS at FROM customer_orders`),
  ]);
  return {
    asOf: AS_OF,
    backlogOrders: book?.orders ?? 0,
    backlogTractors: book?.tractors ?? 0,
    pipelineOrders: pipeline?.orders ?? 0,
    pipelineTractors: pipeline?.tractors ?? 0,
    supplyPlaced: supply?.placed ?? 0,
    supplyQueued: supply?.queued ?? 0,
    jobsPending: jobs?.pending ?? 0,
    workerSeen: jobs?.worker_seen ? jobs.worker_seen.toISOString() : null,
    lateRisk: runs?.supplier_delay.output.atRisk ?? 0,
    partsToOrder: runs?.inventory_strategy.output.toOrder ?? 0,
    elevatedFailures: runs?.component_failure.output.elevated.length ?? 0,
    forecast12: runs?.demand.output.total12 ?? 0,
    modelsRanAt: runs?.ranAt ?? null,
    lastOrderAt: lastOrder?.at ?? null,
  };
}

export async function marketSummary() {
  return one<{ rows: number; first: string; last: string }>(
    `SELECT COUNT(*)::int AS rows, MIN(date)::text AS first, MAX(date)::text AS last FROM market_signals`,
  );
}
