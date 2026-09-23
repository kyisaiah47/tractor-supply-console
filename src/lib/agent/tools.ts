// The chatbot's tools. Each one reads the same data and model output the dashboard reads,
// so the chatbot and the screen can never disagree. Only propose_supply_order touches
// supply orders, and it does not write: it returns a proposal the user confirms in the UI.

import { z } from "zod";
import { q } from "../db";
import { AS_OF } from "../config";
import { MODEL_CODES, SUPPLIER_CODES, WAREHOUSE_CODES } from "../catalog";
import { latestRuns } from "../models";
import { latestBrief } from "../weekly";
import { listOrders, overview } from "../queries";
import { linesForCustomerOrders } from "../supply";

const Model = z.enum(MODEL_CODES as [string, ...string[]]);
const Supplier = z.enum(SUPPLIER_CODES as [string, ...string[]]);
const Warehouse = z.enum(WAREHOUSE_CODES as [string, ...string[]]);

export type ToolDef = {
  name: string;
  description: string;
  schema: z.ZodType;
  jsonSchema: Record<string, unknown>;
  run: (input: never) => Promise<unknown>;
};

function tool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (input: z.infer<S>) => Promise<unknown>,
): ToolDef {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  return { name, description, schema, jsonSchema: js, run: run as (input: never) => Promise<unknown> };
}

async function runs() {
  const r = await latestRuns();
  if (!r) throw new Error("No model runs yet. Run the weekly job first.");
  return r;
}

export const TOOLS: ToolDef[] = [
  tool(
    "get_overview",
    "Headline numbers: open orders and tractors in the 12-month backlog and the 0-3 month production pipeline, supply orders in flight, parts to order, elevated failure pairs, when the models last ran.",
    z.object({}),
    async () => overview(),
  ),
  tool(
    "list_customer_orders",
    "Customer orders from the dashboard table. tab 'pipeline' is orders scheduled for production in the next 1-3 months; tab 'backlog' is all open orders requested in the next 1-12 months. Each row says whether its parts are covered by stock and inbound supply, and which parts are short.",
    z.object({
      tab: z.enum(["pipeline", "backlog"]),
      months: z.number().int().min(1).max(12).describe("Horizon in months: 1-3 for pipeline, 1-12 for backlog"),
      tractor_model: Model.optional(),
      warehouse: Warehouse.optional(),
      parts: z.enum(["covered", "short"]).optional(),
      limit: z.number().int().min(1).max(50).default(15),
    }),
    async (i) => {
      const r = await listOrders({ tab: i.tab, months: i.months, model: i.tractor_model, warehouse: i.warehouse, parts: i.parts, limit: i.limit });
      return { totals: r.totals, through: r.through, facets: r.facets, rows: r.rows };
    },
  ),
  tool(
    "get_demand_forecast",
    "The demand model: forecast tractors per month for the next 12 months with an 80% interval and how many are already booked, plus which candidate model won the backtest and its error.",
    z.object({ tractor_model: Model.optional() }),
    async (i) => {
      const r = await runs();
      const per = r.demand.output.perModel.filter((m) => !i.tractor_model || m.model === i.tractor_model);
      return {
        chosenModel: r.demand.metrics.chosen,
        backtest: Object.fromEntries(Object.entries(r.demand.metrics.backtest).map(([k, v]) => [k, { mae: v.mae, mape: v.mape }])),
        datasetDiagnostics: r.demand.metrics.diagnostics,
        perModel: per.map((m) => ({ model: m.model, forecast: m.forecast })),
      };
    },
  ),
  tool(
    "get_supplier_delays",
    "The supplier delay model: mean and 90th-percentile days late per supplier and quarter, on-time rate, the dataset's own mean delay for comparison, and open supply orders with their late-risk (chance of arriving after the part runs out).",
    z.object({ supplier: Supplier.optional(), only_at_risk: z.boolean().default(true) }),
    async (i) => {
      const r = await runs();
      const open = r.supplier_delay.output.openOrders
        .filter((o) => (!i.supplier || o.supplier === i.supplier) && (!i.only_at_risk || o.lateRisk >= 0.5))
        .sort((a, b) => b.lateRisk - a.lateRisk)
        .slice(0, 20);
      return {
        backtest: r.supplier_delay.metrics.backtest,
        suppliers: r.supplier_delay.output.suppliers.filter((s) => !i.supplier || s.supplier === i.supplier),
        openOrders: open,
        openAtRisk: r.supplier_delay.output.atRisk,
      };
    },
  ),
  tool(
    "get_component_failures",
    "The component failure model: failure rate with a 90% interval for each part and supplier, against the dataset's rate for that tractor model, where failures were found (receiving, assembly, field), and expected broken parts in the next three months of builds.",
    z.object({ tractor_model: Model.optional(), only_elevated: z.boolean().default(true), supplier: Supplier.optional() }),
    async (i) => {
      const r = await runs();
      const rows = r.component_failure.output.rows
        .filter((x) => (!i.only_elevated || x.elevated) && (!i.tractor_model || x.tractorModel === i.tractor_model) && (!i.supplier || x.supplier === i.supplier))
        .slice(0, 25);
      return {
        backtest: r.component_failure.metrics.backtest,
        rows,
        expectedBrokenInPipeline: r.component_failure.output.expectedBrokenInPipeline,
      };
    },
  ),
  tool(
    "get_inventory_recommendations",
    "The inventory strategy model: for each part, order / ok / excess, the quantity, the supplier with the lowest cost after failures and delay, spend, reorder point, target, stock on hand and on order, and the reason.",
    z.object({ action: z.enum(["order", "ok", "excess", "all"]).default("order"), tractor_model: Model.optional() }),
    async (i) => {
      const r = await runs();
      const rows = r.inventory_strategy.output.rows
        .filter((x) => (i.action === "all" || x.action === i.action) && (!i.tractor_model || x.tractorModel === i.tractor_model))
        .map(({ options, ...x }) => ({ ...x, alternatives: options.slice(1) }));
      return { metrics: r.inventory_strategy.metrics, summary: { toOrder: r.inventory_strategy.output.toOrder, spend: r.inventory_strategy.output.spend, excess: r.inventory_strategy.output.excess }, rows };
    },
  ),
  tool(
    "query_market_signals",
    "Aggregates over the market data (10,000 rows covering the four years up to yesterday): demand units, supplier delay days, failure rate, inventory levels, inflation and market trend index, grouped one way and optionally filtered.",
    z.object({
      group_by: z.enum(["month", "year", "tractor_model", "supplier", "warehouse"]),
      tractor_model: Model.optional(),
      supplier: Supplier.optional(),
      warehouse: Warehouse.optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    async (i) => {
      const col = {
        month: "to_char(date,'YYYY-MM')",
        year: "to_char(date,'YYYY')",
        tractor_model: "tractor_model",
        supplier: "supplier",
        warehouse: "warehouse_location",
      }[i.group_by];
      const where = ["1=1"];
      const params: unknown[] = [];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (i.tractor_model) add("tractor_model = ?", i.tractor_model);
      if (i.supplier) add("supplier = ?", i.supplier);
      if (i.warehouse) add("warehouse_location = ?", i.warehouse);
      if (i.from) add("date >= ?", i.from);
      if (i.to) add("date <= ?", i.to);
      const rows = await q(
        `SELECT ${col} AS key, COUNT(*)::int AS rows, SUM(demand_units)::int AS demand_units,
                ROUND(AVG(supplier_delay_days)::numeric,2)::float AS avg_delay_days,
                ROUND(AVG(component_failure_rate)::numeric,4)::float AS avg_failure_rate,
                ROUND(AVG(inventory_levels)::numeric,0)::int AS avg_inventory,
                ROUND(AVG(inflation_rate)::numeric,2)::float AS avg_inflation,
                ROUND(AVG(market_trend_index)::numeric,3)::float AS avg_trend_index
           FROM market_signals WHERE ${where.join(" AND ")} GROUP BY 1 ORDER BY 1 LIMIT 60`,
        params,
      );
      return { rows };
    },
  ),
  tool(
    "get_weekly_brief",
    "The latest weekly brief written by the weekly job, with the facts it was written from.",
    z.object({}),
    async () => latestBrief(),
  ),
  tool(
    "propose_supply_order",
    "Draft supply orders for the user to confirm. It does NOT place anything: the chat shows a confirm button. Either pass lines (sku and quantity, optional warehouse and supplier), or pass customer_order_ids to cover those orders' part shortfalls. Use get_inventory_recommendations first to pick quantities and suppliers.",
    z.object({
      lines: z
        .array(
          z.object({
            sku: z.string(),
            quantity: z.number().int().positive(),
            warehouse: Warehouse.optional(),
            supplier: Supplier.optional(),
          }),
        )
        .optional(),
      customer_order_ids: z.array(z.number().int()).optional(),
      reason: z.string().describe("One sentence the user will see explaining why"),
    }),
    async (i) => {
      let lines: { sku: string; quantity: number; warehouse?: string; supplier?: string; note?: string }[] = i.lines ?? [];
      if (i.customer_order_ids?.length) {
        const r = await linesForCustomerOrders(i.customer_order_ids);
        lines = [...lines, ...r.lines];
      }
      const skus = await q<{ sku: string; unit_price: number; supplier: string }>(
        `SELECT sku, supplier, unit_price FROM part_suppliers WHERE sku = ANY($1)`,
        [lines.map((l) => l.sku)],
      );
      const unknown = lines.filter((l) => !skus.some((s) => s.sku === l.sku)).map((l) => l.sku);
      if (unknown.length) return { error: `Unknown SKUs: ${unknown.join(", ")}` };
      const priced = lines.map((l) => {
        const opts = skus.filter((s) => s.sku === l.sku);
        const p = opts.find((s) => s.supplier === l.supplier) ?? opts.sort((a, b) => a.unit_price - b.unit_price)[0];
        return { ...l, warehouse: l.warehouse ?? "IL", estUnitPrice: p.unit_price, estCost: Math.round(p.unit_price * l.quantity) };
      });
      return {
        proposal: true,
        asOf: AS_OF,
        reason: i.reason,
        lines: priced,
        estTotal: priced.reduce((a, l) => a + l.estCost, 0),
        note: "Not placed. The user must press Confirm in the chat to queue these orders.",
      };
    },
  ),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export async function executeTool(name: string, rawInput: unknown) {
  const t = TOOL_MAP.get(name);
  if (!t) return { ok: false as const, result: { error: `No tool named ${name}` } };
  const parsed = t.schema.safeParse(rawInput ?? {});
  if (!parsed.success) return { ok: false as const, result: { error: `Invalid input: ${parsed.error.message}` } };
  try {
    return { ok: true as const, result: await (t.run as (i: unknown) => Promise<unknown>)(parsed.data) };
  } catch (e) {
    return { ok: false as const, result: { error: e instanceof Error ? e.message : String(e) } };
  }
}
