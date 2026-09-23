// Component failure: the share of each part, from each supplier, that breaks at receiving,
// during assembly or in the field.
//
// Each part-and-supplier rate is a Beta posterior. The prior is the provided dataset's own
// Component_Failure_Rate for that tractor model, weighted like 400 observed units, so a
// supplier with few lots stays near the dataset rate and one with thousands of units speaks
// for itself. A rate is flagged when the low end of its 90% interval sits 25% above the prior.
//
// Only lots received at least 120 days before the as-of date are used, because a part
// received last week has not had time to fail yet.

import { q } from "../db";
import { addDays } from "../dates";
import { betaInterval, mean, round } from "../stats";

export type LotAgg = {
  sku: string;
  tractor_model: string;
  category: string;
  supplier: string;
  units: number;
  broken: number;
  receiving: number;
  assembly: number;
  field: number;
};
export type FailureInput = {
  asOf: string;
  lots: LotAgg[];
  lotsTrain: LotAgg[];
  lotsTest: LotAgg[];
  priors: { model: string; rate: number }[];
  pipelineUnits: { tractor_model: string; units: number }[];
};

export const FAILURE_SPEC = {
  predicts: "Failure rate for every part from every supplier, and how many parts in the next three months of builds will break.",
  dataSources: [
    "Received parts: how many broke, when, and whether at receiving, assembly or in the field",
    "Market data: component failure rate per tractor model, as the starting point",
    "The production schedule: tractors to be built in the next three months",
  ],
  inputs: ["part", "supplier", "units received", "units broken", "market failure rate for the model"],
  outputs: ["failure rate with a likely range", "parts failing above the market rate", "expected broken parts in the next three months"],
  method: "Starts from the market rate and moves toward each supplier's own record as parts are received. Flagged when even the low end of the likely range is 25% above the market rate.",
};

const PRIOR_STRENGTH = 400;
const LIFT_FLAG = 1.25;
const MATURITY_DAYS = 120;

const LOT_SQL = `
  SELECT l.sku, p.tractor_model, p.category, l.supplier,
         SUM(l.quantity)::int AS units, SUM(l.broken_quantity)::int AS broken,
         SUM(CASE WHEN l.broken_stage='receiving' THEN l.broken_quantity ELSE 0 END)::int AS receiving,
         SUM(CASE WHEN l.broken_stage='assembly'  THEN l.broken_quantity ELSE 0 END)::int AS assembly,
         SUM(CASE WHEN l.broken_stage='field'     THEN l.broken_quantity ELSE 0 END)::int AS field
    FROM inventory_parts l JOIN parts p USING (sku)
   WHERE l.received_date >= $1 AND l.received_date < $2
   GROUP BY 1,2,3,4`;

export async function loadFailureInput(asOf: string): Promise<FailureInput> {
  const cutoff = addDays(asOf, -MATURITY_DAYS);
  const lots = await q<LotAgg>(LOT_SQL, ["1900-01-01", cutoff]);
  const split = addDays(asOf, -365);
  const lotsTrain = await q<LotAgg>(LOT_SQL, ["1900-01-01", addDays(split, -MATURITY_DAYS)]);
  const lotsTest = await q<LotAgg>(LOT_SQL, [split, cutoff]);
  const priors = await q<{ model: string; rate: number }>(
    `SELECT tractor_model AS model, AVG(component_failure_rate)::float AS rate FROM market_signals WHERE date < $1 GROUP BY 1`,
    [asOf],
  );
  const pipelineUnits = await q<{ tractor_model: string; units: number }>(
    `SELECT o.tractor_model, SUM(o.quantity)::int AS units
       FROM production_pipeline pp JOIN customer_orders o ON o.id = pp.customer_order_id GROUP BY 1`,
  );
  return { asOf, lots, lotsTrain, lotsTest, priors, pipelineUnits };
}

function posterior(l: LotAgg, prior: number) {
  const a = prior * PRIOR_STRENGTH + l.broken;
  const b = (1 - prior) * PRIOR_STRENGTH + (l.units - l.broken);
  return betaInterval(a, b);
}

export function runComponentFailure(input: FailureInput) {
  const prior = new Map(input.priors.map((p) => [p.model, p.rate]));
  const priorFor = (m: string) => prior.get(m) ?? 0.05;

  // Backtest: fit on lots received before the last year, predict broken units in the last year's lots.
  const fitted = new Map(input.lotsTrain.map((l) => [`${l.sku}|${l.supplier}`, posterior(l, priorFor(l.tractor_model)).mean]));
  const err = (pred: (l: LotAgg) => number) => mean(input.lotsTest.map((l) => Math.abs(l.broken - pred(l) * l.units)));
  const backtest = {
    model_mae_units: round(err((l) => fitted.get(`${l.sku}|${l.supplier}`) ?? priorFor(l.tractor_model)), 2),
    dataset_rate_mae_units: round(err((l) => priorFor(l.tractor_model)), 2),
    test_pairs: input.lotsTest.length,
  };

  const rows = input.lots
    .map((l) => {
      const p = priorFor(l.tractor_model);
      const post = posterior(l, p);
      return {
        sku: l.sku,
        tractorModel: l.tractor_model,
        category: l.category,
        supplier: l.supplier,
        units: l.units,
        broken: l.broken,
        stages: { receiving: l.receiving, assembly: l.assembly, field: l.field },
        rate: round(post.mean, 4),
        lo: round(post.lo, 4),
        hi: round(post.hi, 4),
        prior: round(p, 4),
        lift: round(post.mean / p, 2),
        elevated: post.lo > p * LIFT_FLAG,
      };
    })
    .sort((a, b) => b.lift - a.lift);

  const pipeline = new Map(input.pipelineUnits.map((p) => [p.tractor_model, p.units]));
  const bySku = new Map<string, typeof rows>();
  for (const r of rows) (bySku.get(r.sku) ?? bySku.set(r.sku, []).get(r.sku)!).push(r);
  const pipelineExposure = [...bySku.entries()]
    .map(([sku, rs]) => {
      const units = pipeline.get(rs[0].tractorModel) ?? 0;
      const weighted = rs.reduce((a, r) => a + r.rate * r.units, 0) / rs.reduce((a, r) => a + r.units, 0);
      return { sku, tractorModel: rs[0].tractorModel, category: rs[0].category, pipelineUnits: units, expectedBroken: round(units * weighted, 1) };
    })
    .sort((a, b) => b.expectedBroken - a.expectedBroken);

  return {
    metrics: { backtest, priorStrength: PRIOR_STRENGTH, liftFlag: LIFT_FLAG, maturityDays: MATURITY_DAYS },
    output: {
      rows,
      elevated: rows.filter((r) => r.elevated),
      pipelineExposure,
      expectedBrokenInPipeline: round(pipelineExposure.reduce((a, p) => a + p.expectedBroken, 0)),
    },
  };
}

export type FailureResult = ReturnType<typeof runComponentFailure>;
