// Offline mode: no API key configured. A keyword router picks the tool a question needs and
// writes the answer from its result. It uses the same tools as the LLM path, so every number
// is real; it just cannot reason across several tools the way a model can.

import { MODEL_CODES } from "../catalog";
import { executeTool } from "./tools";
import type { AgentEvent, ChatTurn } from "./run";

type Emit = (e: AgentEvent) => void;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

async function call(emit: Emit, name: string, input: Record<string, unknown>) {
  const id = `offline_${name}_${Date.now()}`;
  emit({ type: "tool_call", id, name, input });
  const r = await executeTool(name, input);
  emit({ type: "tool_result", id, name, ok: r.ok, result: r.result });
  if (!r.ok) throw new Error((r.result as { error: string }).error);
  return r.result as never;
}

async function say(emit: Emit, text: string) {
  for (const part of text.match(/.{1,24}(\s|$)|\S+/gs) ?? [text]) {
    emit({ type: "text", text: part });
    await new Promise((r) => setTimeout(r, 12));
  }
}

export async function runOffline(history: ChatTurn[], emit: Emit) {
  const text = history.filter((h) => h.role === "user").at(-1)?.content ?? "";
  const t = text.toLowerCase();
  const model = MODEL_CODES.find((m) => t.includes(m.toLowerCase()));
  const supplierLetter = t.match(/supplier\s+([a-e])\b/)?.[1];
  const supplier = supplierLetter ? `Supplier ${supplierLetter.toUpperCase()}` : undefined;

  if (/forecast|demand|how many tractors|next (year|month|quarter)/.test(t)) {
    const r: { chosenModel: string; backtest: Record<string, { mape: number }>; perModel: { model: string; forecast: { ym: string; units: number; lo: number; hi: number; booked: number }[] }[] } =
      await call(emit, "get_demand_forecast", model ? { tractor_model: model } : {});
    const rows = r.perModel.map((m) => {
      const q = m.forecast.slice(0, 3);
      return `| ${m.model} | ${q.reduce((a, f) => a + f.units, 0)} | ${q.reduce((a, f) => a + f.booked, 0)} | ${m.forecast.reduce((a, f) => a + f.units, 0)} |`;
    });
    await say(
      emit,
      `Tested on the last two years, the forecast was off by ${pct(r.backtest[r.chosenModel].mape)} a month on average.\n\n| Model | Next 3 months | Booked | Next 12 months |\n|---|---|---|---|\n${rows.join("\n")}`,
    );
    return;
  }
  if (/supplier|delay|late|on.time|arriv/.test(t)) {
    const r: { suppliers: { supplier: string; meanDelay: number; p90Delay: number; onTimeRate: number; datasetMeanDelay: number; byQuarter: number[] }[]; openAtRisk: number; openOrders: { id: number; sku: string; supplier: string; lateRisk: number; needBy: string; expectedArrival: string }[] } =
      await call(emit, "get_supplier_delays", supplier ? { supplier } : {});
    const rows = r.suppliers.map((s) => `| ${s.supplier} | ${s.meanDelay} | ${s.p90Delay} | ${s.byQuarter.join(" / ")} | ${s.datasetMeanDelay} |`);
    const risk = r.openOrders
      .slice(0, 5)
      .map((o) => `Supply order ${o.id} (${o.sku}, ${o.supplier}) should arrive ${o.expectedArrival}, and the part runs out ${o.needBy}. Late-risk ${pct(o.lateRisk)}.`)
      .join("\n");
    await say(
      emit,
      `| Supplier | Average days late | Worst 10% | By quarter | Market average |\n|---|---|---|---|---|\n${rows.join("\n")}\n\n${r.openAtRisk} open supply orders will probably arrive after their part runs out.${risk ? `\n\n${risk}` : ""}`,
    );
    return;
  }
  if (/fail|broken|defect|quality|break/.test(t)) {
    const r: { rows: { sku: string; category: string; supplier: string; rate: number; prior: number; units: number }[]; expectedBrokenInPipeline: number } =
      await call(emit, "get_component_failures", { ...(model ? { tractor_model: model } : {}), ...(supplier ? { supplier } : {}) });
    const rows = r.rows.slice(0, 8).map((x) => `| ${x.sku} | ${x.category} | ${x.supplier} | ${pct(x.rate)} | ${pct(x.prior)} | ${x.units} |`);
    await say(
      emit,
      rows.length
        ? `These parts fail well above the market rate:\n\n| Part | Category | Supplier | Rate | Expected | Units seen |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n\nAbout ${r.expectedBrokenInPipeline} parts in the next three months of builds will break.`
        : `No part is failing above the market rate for that filter.`,
    );
    return;
  }
  if (/order|reorder|inventory|stock|buy|excess|short/.test(t) && !/customer/.test(t)) {
    const r: { summary: { toOrder: number; spend: number }; rows: { sku: string; quantity: number; supplier: string; spend: number; daysOfCover: number | null; reason: string }[] } =
      await call(emit, "get_inventory_recommendations", { action: /excess/.test(t) ? "excess" : "order", ...(model ? { tractor_model: model } : {}) });
    const rows = r.rows.slice(0, 10).map((x) => `| ${x.sku} | ${x.quantity} | ${x.supplier} | ${usd(x.spend)} | ${x.daysOfCover ?? "-"} |`);
    await say(
      emit,
      rows.length
        ? `${r.summary.toOrder} parts need an order now, for ${usd(r.summary.spend)} in total.\n\n| Part | Quantity | Supplier | Spend | Days of stock |\n|---|---|---|---|---|\n${rows.join("\n")}`
        : "Nothing matches that filter.",
    );
    if (/place|draft|propose|go ahead|do it/.test(t) && r.rows.length) {
      await call(emit, "propose_supply_order", {
        lines: r.rows.slice(0, 10).map((x) => ({ sku: x.sku, quantity: x.quantity, supplier: x.supplier })),
        reason: "Parts below their reorder point, from the inventory strategy model.",
      });
      await say(emit, "\n\nI drafted these orders. Press Confirm to queue them.");
    }
    return;
  }
  if (/pipeline|backlog|customer|orders?/.test(t)) {
    const tab = /backlog|12|year/.test(t) ? "backlog" : "pipeline";
    const r: { totals: { orders: number; tractors: number; short: number } } = await call(emit, "list_customer_orders", {
      tab,
      months: tab === "pipeline" ? 3 : 12,
      ...(model ? { tractor_model: model } : {}),
      limit: 5,
    });
    await say(
      emit,
      `The ${tab === "pipeline" ? "0-3 month production pipeline" : "12-month backlog"} holds ${r.totals.orders} orders for ${r.totals.tractors} tractors${model ? ` of ${model}` : ""}. ${r.totals.short} of them are short of at least one part.`,
    );
    return;
  }
  if (/brief|summary|week|overview|status|what.*(happen|going)/.test(t)) {
    const r = (await call(emit, "get_weekly_brief", {})) as { body: string } | null;
    await say(emit, r?.body ?? "No weekly brief yet.");
    return;
  }
  const o: { backlogTractors: number; pipelineTractors: number; partsToOrder: number; lateRisk: number; elevatedFailures: number } = await call(emit, "get_overview", {});
  await say(
    emit,
    `The 12-month backlog holds ${o.backlogTractors} tractors and the 0-3 month pipeline ${o.pipelineTractors}. ${o.partsToOrder} parts need an order, ${o.lateRisk} open supply orders are at risk of arriving late, and ${o.elevatedFailures} part and supplier pairs fail above normal.\n\nAsk about the demand forecast, supplier delays, component failures, what to reorder, or the production pipeline.`,
  );
}
