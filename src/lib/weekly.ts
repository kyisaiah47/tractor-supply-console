// The weekly job: run the four models, store their output, and write the dashboard's brief.
// The brief is written by the configured LLM from a fixed set of facts, or by a template
// when no LLM is configured. Either way every number in it comes from `facts`.

import { q } from "./db";
import { AS_OF } from "./config";
import { runAllModels, saveRuns, type AllResults } from "./models";
import { completeText } from "./llm";
import { monthLabel } from "./dates";

export function briefFacts(r: AllResults) {
  const d = r.demand;
  const next3 = d.output.perModel.map((m) => ({
    model: m.model,
    forecast: m.forecast.slice(0, 3).reduce((a, f) => a + f.units, 0),
    booked: m.forecast.slice(0, 3).reduce((a, f) => a + f.booked, 0),
  }));
  const suppliers = [...r.supplier_delay.output.suppliers].sort((a, b) => b.meanDelay - a.meanDelay);
  const toOrder = r.inventory_strategy.output.rows
    .filter((x) => x.action === "order")
    .sort((a, b) => (a.daysOfCover ?? 0) - (b.daysOfCover ?? 0));
  return {
    horizon: `${monthLabel(d.output.horizon[0])} to ${monthLabel(d.output.horizon[11])}`,
    demand: {
      chosenModel: d.metrics.chosen,
      backtestMape: d.metrics.backtest[d.metrics.chosen].mape,
      forecast12: d.output.total12,
      booked12: d.output.booked12,
      next3,
    },
    suppliers: {
      slowest: suppliers[0],
      fastest: suppliers[suppliers.length - 1],
      openAtRisk: r.supplier_delay.output.atRisk,
      openTotal: r.supplier_delay.output.openOrders.length,
    },
    failures: {
      elevated: r.component_failure.output.elevated.slice(0, 4).map((e) => ({
        sku: e.sku,
        category: e.category,
        supplier: e.supplier,
        rate: e.rate,
        prior: e.prior,
      })),
      expectedBrokenInPipeline: r.component_failure.output.expectedBrokenInPipeline,
    },
    inventory: {
      toOrder: r.inventory_strategy.output.toOrder,
      spend: r.inventory_strategy.output.spend,
      excess: r.inventory_strategy.output.excess,
      excessValue: r.inventory_strategy.output.excessValue,
      mostUrgent: toOrder.slice(0, 3).map((x) => ({ sku: x.sku, daysOfCover: x.daysOfCover, supplier: x.supplier, quantity: x.quantity })),
    },
  };
}

export type BriefFacts = ReturnType<typeof briefFacts>;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

export function templateBrief(f: BriefFacts) {
  const lines: string[] = [];
  lines.push(
    `Demand: the forecast for ${f.horizon} is ${f.demand.forecast12.toLocaleString()} tractors, and ${f.demand.booked12.toLocaleString()} are already booked. Tested on the last two years, the forecast was off by ${pct(f.demand.backtestMape)} a month on average.`,
  );
  lines.push(
    `Suppliers: ${f.suppliers.slowest.supplier} is the slowest at ${f.suppliers.slowest.meanDelay} days late on average, and ${f.suppliers.fastest.supplier} is the fastest at ${f.suppliers.fastest.meanDelay}. ${f.suppliers.openAtRisk} of ${f.suppliers.openTotal} open supply orders will probably arrive after their part runs out.`,
  );
  if (f.failures.elevated.length) {
    const e = f.failures.elevated
      .map((x) => `${x.category} ${x.sku} from ${x.supplier} fails ${pct(x.rate)} against ${pct(x.prior)} expected`)
      .join("; ");
    lines.push(`Failures: ${e}. About ${f.failures.expectedBrokenInPipeline.toLocaleString()} parts in the next three months of builds will break.`);
  }
  const urgent = f.inventory.mostUrgent[0];
  lines.push(
    `Inventory: ${f.inventory.toOrder} parts need an order now, for ${usd(f.inventory.spend)} in total. ` +
      (f.inventory.excess
        ? `${f.inventory.excess} parts hold more than two months of stock above target, worth ${usd(f.inventory.excessValue)}. `
        : "No part holds more than two months of stock above target. ") +
      (urgent ? `Order ${urgent.quantity} ${urgent.sku} from ${urgent.supplier} first: ${urgent.daysOfCover} days of stock are left.` : ""),
  );
  return lines.join("\n\n");
}

// What the LLM sees: every figure already formatted, every field named for what it means.
function llmFacts(f: BriefFacts) {
  const n = (x: number) => Math.round(x).toLocaleString("en-US");
  return {
    period: f.horizon,
    demand: {
      tractorsForecast: n(f.demand.forecast12),
      tractorsAlreadyBooked: n(f.demand.booked12),
      forecastAverageMissOnTheLastTwoYears: pct(f.demand.backtestMape),
    },
    suppliers: {
      slowest: { name: f.suppliers.slowest.supplier, averageDaysLate: f.suppliers.slowest.meanDelay, daysLateInQ4: f.suppliers.slowest.byQuarter[3] },
      fastest: { name: f.suppliers.fastest.supplier, averageDaysLate: f.suppliers.fastest.meanDelay },
      openSupplyOrders: f.suppliers.openTotal,
      openSupplyOrdersLikelyToArriveAfterThePartRunsOut: f.suppliers.openAtRisk,
    },
    failures: {
      partsFailingAboveTheMarketRate: f.failures.elevated.map((e) => ({
        part: `${e.category} ${e.sku}`,
        supplier: e.supplier,
        failureRate: pct(e.rate),
        marketRate: pct(e.prior),
      })),
      partsExpectedToBreakInTheNextThreeMonthsOfBuilds: n(f.failures.expectedBrokenInPipeline),
    },
    inventory: {
      partsToOrderNow: f.inventory.toOrder,
      totalCostOfThoseOrders: usd(f.inventory.spend),
      partsWithExcessStock: f.inventory.excess,
      mostUrgent: f.inventory.mostUrgent.map((u) => ({
        part: u.sku,
        daysOfStockLeft: u.daysOfCover,
        orderQuantity: u.quantity,
        supplier: u.supplier,
      })),
    },
  };
}

const BRIEF_SYSTEM = `You write the weekly supply-chain brief for a tractor manufacturer's planning team.
Use only the facts in the JSON. Copy every number exactly as written, with its % or $ sign. Never invent a number.
Never name a database table, field, model id or statistical method. Write for a supply planner.
Write four paragraphs headed Demand, Suppliers, Failures, Inventory, each starting with its heading and a colon.
Each paragraph has at most three sentences. One fact per sentence. Plain sentences, no metaphors, no filler, no bullet points.
End the Inventory paragraph with the single most urgent action: which part to order, how many, and from which supplier.`;

export async function runWeeklyJob(opts: { useLlm: boolean; asOf?: string } = { useLlm: true }) {
  const asOf = opts.asOf ?? AS_OF;
  const results = await runAllModels(asOf);
  await saveRuns(asOf, results);
  const facts = briefFacts(results);
  let body = templateBrief(facts);
  let author = "template";
  if (opts.useLlm) {
    try {
      const out = await completeText(BRIEF_SYSTEM, JSON.stringify(llmFacts(facts), null, 2));
      if (out?.text.trim()) {
        body = out.text.trim();
        author = out.author;
      } else if (out) {
        console.error(`weekly brief: ${out.author} returned no text, kept the template brief`);
      }
    } catch (e) {
      console.error("weekly brief: LLM call failed, kept the template brief", e);
    }
  }
  await q(`INSERT INTO weekly_briefs (as_of, author, body, facts) VALUES ($1,$2,$3,$4)`, [asOf, author, body, JSON.stringify(facts)]);
  return { asOf, author, body, facts };
}

export async function latestBrief() {
  const rows = await q<{ as_of: string; generated_at: Date; author: string; body: string; facts: BriefFacts }>(
    `SELECT as_of, generated_at, author, body, facts FROM weekly_briefs ORDER BY generated_at DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}
