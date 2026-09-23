// Supplier delay: how many days after the promised date each supplier's parts arrive, and
// which open supply orders are likely to land after the part runs out.
//
// Delay = fulfilled_date - promised_date on every fulfilled supply order. Each supplier's mean
// is shrunk toward the overall mean, and each supplier-by-quarter mean toward its supplier's,
// so a quarter with few orders cannot swing the estimate. The backtest trains on orders
// promised more than a year before the planning date and scores the last year against two
// baselines: the overall mean, and the provided dataset's own per-supplier Supplier_Delay_Days.

import { q } from "../db";
import { addDays, diffDays } from "../dates";
import { SUPPLIER_CODES } from "../catalog";
import { mae, mean, quantile, round } from "../stats";

export type DelayRow = { supplier: string; promised: string; fulfilled: string; ordered: string };
export type OpenSupplyOrder = {
  id: number;
  sku: string;
  tractor_model: string;
  supplier: string;
  quantity: number;
  date_ordered: string;
  promised_date: string;
};
export type SupplierDelayInput = {
  asOf: string;
  history: DelayRow[];
  datasetMeans: { supplier: string; mean: number }[];
  open: OpenSupplyOrder[];
  stockout: { sku: string; date: string | null }[];
};

export const SUPPLIER_DELAY_SPEC = {
  predicts: "How many days late each supplier delivers by quarter, and the chance each open supply order arrives after its part runs out.",
  dataSources: [
    "Supply order history: promised date against delivery date",
    "Market data: supplier delay days, as the baseline to beat",
    "Stock on hand and the production schedule: the date each part runs out",
  ],
  inputs: ["supplier", "quarter the order was placed", "promised date", "need-by date"],
  outputs: ["average and worst-case delay per supplier and quarter", "on-time rate", "chance each open supply order is late"],
  method: "Average delay per supplier and quarter, pulled toward the supplier's overall average when a quarter has few orders. Risk comes from each supplier's real spread of delays.",
};

const K_SUPPLIER = 20;
const K_QUARTER = 15;
const ON_TIME_DAYS = 3;
const quarterOf = (d: string) => Math.floor((Number(d.slice(5, 7)) - 1) / 3);

export async function loadSupplierDelayInput(asOf: string, stockout: { sku: string; date: string | null }[]) {
  const history = await q<DelayRow>(
    `SELECT supplier, promised_date AS promised, fulfilled_date AS fulfilled, date_ordered AS ordered
       FROM supply_orders WHERE status='fulfilled' AND fulfilled_date < $1 AND promised_date IS NOT NULL`,
    [asOf],
  );
  const datasetMeans = await q<{ supplier: string; mean: number }>(
    `SELECT supplier, AVG(supplier_delay_days)::float AS mean FROM market_signals WHERE date < $1 GROUP BY 1`,
    [asOf],
  );
  const open = await q<OpenSupplyOrder>(
    `SELECT s.id, s.sku, p.tractor_model, s.supplier, s.quantity, s.date_ordered, s.promised_date
       FROM supply_orders s JOIN parts p USING (sku)
      WHERE s.status='placed' AND s.supplier IS NOT NULL ORDER BY s.promised_date`,
  );
  return { asOf, history, datasetMeans, open, stockout } satisfies SupplierDelayInput;
}

function fit(rows: DelayRow[]) {
  const delays = rows.map((r) => diffDays(r.fulfilled, r.promised));
  const overall = mean(delays);
  const bySupplier = new Map<string, number[]>();
  const byQuarter = new Map<string, number[]>();
  rows.forEach((r, i) => {
    (bySupplier.get(r.supplier) ?? bySupplier.set(r.supplier, []).get(r.supplier)!).push(delays[i]);
    const k = `${r.supplier}|${quarterOf(r.ordered)}`;
    (byQuarter.get(k) ?? byQuarter.set(k, []).get(k)!).push(delays[i]);
  });
  const supplierMean = (s: string) => {
    const d = bySupplier.get(s) ?? [];
    return (d.length * mean(d) + K_SUPPLIER * overall) / (d.length + K_SUPPLIER);
  };
  const quarterMean = (s: string, qtr: number) => {
    const d = byQuarter.get(`${s}|${qtr}`) ?? [];
    const sm = supplierMean(s);
    return (d.length * (d.length ? mean(d) : 0) + K_QUARTER * sm) / (d.length + K_QUARTER);
  };
  return { overall, bySupplier, supplierMean, quarterMean };
}

export function runSupplierDelay(input: SupplierDelayInput) {
  // Backtest: train on everything promised before the last year, score the last year.
  const split = addDays(input.asOf, -365);
  const train = input.history.filter((r) => r.promised < split);
  const test = input.history.filter((r) => r.promised >= split);
  const f0 = fit(train);
  const actual = test.map((r) => diffDays(r.fulfilled, r.promised));
  const dsMean = new Map(input.datasetMeans.map((d) => [d.supplier, d.mean]));
  const backtest = {
    model_mae: round(mae(actual, test.map((r) => f0.quarterMean(r.supplier, quarterOf(r.ordered)))), 2),
    overall_mean_mae: round(mae(actual, test.map(() => f0.overall)), 2),
    dataset_supplier_mean_mae: round(mae(actual, test.map((r) => dsMean.get(r.supplier) ?? f0.overall)), 2),
    test_orders: test.length,
  };

  const f = fit(input.history);
  const suppliers = SUPPLIER_CODES.map((s) => {
    const d = f.bySupplier.get(s) ?? [];
    return {
      supplier: s,
      orders: d.length,
      meanDelay: round(f.supplierMean(s), 1),
      p90Delay: round(quantile(d, 0.9), 0),
      onTimeRate: round(d.filter((x) => x <= ON_TIME_DAYS).length / Math.max(1, d.length), 3),
      datasetMeanDelay: round(dsMean.get(s) ?? 0, 1),
      byQuarter: [0, 1, 2, 3].map((qtr) => round(f.quarterMean(s, qtr), 1)),
    };
  });

  const stockout = new Map(input.stockout.map((s) => [s.sku, s.date]));
  const openOrders = input.open.map((o) => {
    const expected = f.quarterMean(o.supplier, quarterOf(o.date_ordered));
    const dist = f.bySupplier.get(o.supplier) ?? [];
    const shift = expected - mean(dist);
    const needBy = stockout.get(o.sku) ?? null;
    let lateRisk = 0;
    if (needBy) {
      const slack = diffDays(needBy, o.promised_date);
      lateRisk = dist.filter((d) => d + shift > slack).length / Math.max(1, dist.length);
    }
    return {
      id: o.id,
      sku: o.sku,
      tractorModel: o.tractor_model,
      supplier: o.supplier,
      quantity: o.quantity,
      promised: o.promised_date,
      expectedArrival: addDays(o.promised_date, Math.round(expected)),
      p90Arrival: addDays(o.promised_date, Math.round(quantile(dist, 0.9) + shift)),
      needBy,
      lateRisk: round(lateRisk, 2),
    };
  });

  return {
    metrics: { backtest, onTimeThresholdDays: ON_TIME_DAYS, overallMeanDelay: round(f.overall, 1) },
    output: {
      suppliers,
      openOrders,
      atRisk: openOrders.filter((o) => o.lateRisk >= 0.5).length,
    },
  };
}

export type SupplierDelayResult = ReturnType<typeof runSupplierDelay>;
