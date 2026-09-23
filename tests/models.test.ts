// Model tests. They run against the seeded database (npm run db:setup) and check two things:
//   1. each model beats its simple baseline on data it did not see
//   2. each effect planted by the generator (src/lib/planted.ts) is recovered
// The second is the stronger test: the provided dataset has no signal of its own, so a model
// that passes has found something real in the operational history.
import "../scripts/_env";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/lib/db";
import { AS_OF } from "../src/lib/config";
import { runAllModels, type AllResults } from "../src/lib/models";
import { PLANTED } from "../src/lib/planted";

let r: AllResults;
const results = async () => (r ??= await runAllModels(AS_OF));
after(() => pool.end());

test("demand: the chosen forecast beats last year's average and the same month last year", async () => {
  const { demand } = await results();
  const b = demand.metrics.backtest;
  const chosen = b[demand.metrics.chosen];
  assert.ok(chosen.mape < b.trailing_mean.mape, `chosen ${chosen.mape} vs trailing ${b.trailing_mean.mape}`);
  assert.ok(chosen.mape < b.seasonal_naive.mape, `chosen ${chosen.mape} vs seasonal naive ${b.seasonal_naive.mape}`);
});

test("demand: recovers the planted spring peak (March-May above November-January)", async () => {
  const { demand } = await results();
  const total = (months: string[]) =>
    demand.output.perModel.reduce((a, m) => a + m.forecast.filter((f) => months.includes(f.ym.slice(5))).reduce((x, f) => x + f.units, 0), 0);
  const spring = total(["03", "04", "05"]);
  const winter = total(["01", "11", "12"]);
  const plantedRatio =
    (PLANTED.seasonal[2] + PLANTED.seasonal[3] + PLANTED.seasonal[4]) / (PLANTED.seasonal[0] + PLANTED.seasonal[10] + PLANTED.seasonal[11]);
  assert.ok(spring / winter > 1 + (plantedRatio - 1) * 0.6, `spring/winter ${spring / winter} vs planted ${plantedRatio}`);
});

test("demand: the provided market data carries no demand signal on its own", async () => {
  const { demand } = await results();
  assert.ok(Math.abs(demand.metrics.diagnostics.corrDemandVsTrendIndex) < 0.2);
  assert.ok(Math.abs(demand.metrics.diagnostics.corrDemandVsInflation) < 0.2);
});

test("supplier delay: beats both the overall mean and the dataset's per-supplier means", async () => {
  const { supplier_delay } = await results();
  const b = supplier_delay.metrics.backtest;
  assert.ok(b.model_mae < b.overall_mean_mae, JSON.stringify(b));
  assert.ok(b.model_mae < b.dataset_supplier_mean_mae, JSON.stringify(b));
});

test("supplier delay: recovers Supplier B as fastest and Supplier D's slow Q4", async () => {
  const { supplier_delay } = await results();
  const s = Object.fromEntries(supplier_delay.output.suppliers.map((x) => [x.supplier, x]));
  const fastest = [...supplier_delay.output.suppliers].sort((a, b) => a.meanDelay - b.meanDelay)[0];
  assert.equal(fastest.supplier, "Supplier B");
  const d = s["Supplier D"].byQuarter;
  const otherQuarters = (d[0] + d[1] + d[2]) / 3;
  assert.ok(d[3] > otherQuarters * 1.15, `Supplier D Q4 ${d[3]} vs Q1-Q3 ${otherQuarters}`);
});

test("component failure: beats the dataset rate on held-out lots", async () => {
  const { component_failure } = await results();
  const b = component_failure.metrics.backtest;
  assert.ok(b.model_mae_units < b.dataset_rate_mae_units, JSON.stringify(b));
});

test("component failure: flags Supplier E hydraulic pumps and TX-400 transmissions, and little else", async () => {
  const { component_failure } = await results();
  const flagged = component_failure.output.elevated.map((e) => `${e.sku}|${e.supplier}`);
  for (const m of ["100", "200", "300", "400", "500"]) assert.ok(flagged.includes(`HYD-${m}|Supplier E`), `HYD-${m} from Supplier E not flagged`);
  assert.ok(flagged.some((f) => f.startsWith("TRN-400|")), "TX-400 transmissions not flagged");
  const unplanted = flagged.filter((f) => !f.startsWith("HYD-") && !f.startsWith("TRN-400|"));
  assert.ok(unplanted.length <= 1, `unexpected flags: ${unplanted.join(", ")}`);
});

test("inventory strategy: never buys hydraulic pumps from Supplier E", async () => {
  const { inventory_strategy } = await results();
  for (const row of inventory_strategy.output.rows.filter((x) => x.sku.startsWith("HYD-"))) {
    assert.notEqual(row.supplier, "Supplier E", `${row.sku} chose Supplier E`);
  }
});

test("inventory strategy: every order recommendation brings stock back above its reorder point", async () => {
  const { inventory_strategy } = await results();
  for (const row of inventory_strategy.output.rows.filter((x) => x.action === "order")) {
    const fr = row.options.find((o) => o.supplier === row.supplier)!.failureRate;
    assert.ok(row.position + row.quantity * (1 - fr) >= row.reorderPoint, `${row.sku} still short after ordering`);
  }
});
