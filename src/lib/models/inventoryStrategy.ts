// Inventory strategy: for every part, whether to order now, how many, and from which supplier,
// so that builds are covered at a 95% service level without carrying excess.
//
// It combines the other three models. Demand sets how fast a part is used. The supplier delay
// model stretches each supplier's quoted lead time by how late that supplier really is, and
// its spread becomes lead-time uncertainty in the safety stock. The failure model inflates the
// quantity to cover parts that will break, and prices a supplier's broken parts into its cost.
// Inflation from the provided dataset raises the cost of holding stock.
//
//   safety stock  = z * sqrt(L * sd_demand^2 + demand^2 * sd_L^2)
//   reorder point = demand * L + safety stock
//   target        = reorder point + one month of demand
//   order when stock on hand + on order < reorder point; mark excess when it is above
//   target + two months of demand.

import { q } from "../db";
import { round, Z95 } from "../stats";
import type { DemandResult } from "./demand";
import type { SupplierDelayResult } from "./supplierDelay";
import type { FailureResult } from "./componentFailure";

export type StrategyInput = {
  asOf: string;
  parts: { sku: string; tractor_model: string; category: string; qty_per_tractor: number; standard_cost: number }[];
  partSuppliers: { sku: string; supplier: string; unit_price: number; nominal_lead_days: number }[];
  onHand: { sku: string; units: number }[];
  onOrder: { sku: string; units: number }[];
  inflation: number;
};

export const STRATEGY_SPEC = {
  predicts: "For every part: order now, hold, or excess; the quantity; and the supplier with the lowest effective cost.",
  dataSources: [
    "The demand, supplier delay and component failure forecasts",
    "Stock on hand and supply already ordered",
    "Each supplier's price and quoted lead time",
    "Market data: inflation, for the cost of holding stock",
  ],
  inputs: ["monthly demand and its spread", "lead time plus expected delay", "failure rate", "unit price", "inflation"],
  outputs: ["reorder point and target stock", "order quantity", "chosen supplier", "spend", "excess units and value"],
  method: "Order when stock plus supply on the way falls below the reorder point, set to cover 95% of lead times and demand swings. The supplier is the cheapest after pricing in its failures and delays.",
};

const REVIEW_MONTHS = 1;
const EXCESS_MONTHS = 2;
const BASE_HOLDING = 0.2; // warehouse, capital and obsolescence, per year
const DELAY_COST_PER_DAY = 0.001; // share of price lost per day late (line stoppage risk)

export async function loadStrategyInput(asOf: string): Promise<StrategyInput> {
  const parts = await q<StrategyInput["parts"][number]>(
    `SELECT sku, tractor_model, category, qty_per_tractor, standard_cost FROM parts ORDER BY sku`,
  );
  const partSuppliers = await q<StrategyInput["partSuppliers"][number]>(
    `SELECT sku, supplier, unit_price, nominal_lead_days FROM part_suppliers`,
  );
  const onHand = await q<{ sku: string; units: number }>(`SELECT sku, SUM(on_hand)::int AS units FROM inventory GROUP BY 1`);
  const onOrder = await q<{ sku: string; units: number }>(
    `SELECT sku, SUM(quantity)::int AS units FROM supply_orders WHERE status IN ('queued','placed') GROUP BY 1`,
  );
  const infl = await q<{ v: number }>(
    `SELECT AVG(inflation_rate)::float AS v FROM market_signals WHERE date >= ($1::date - interval '12 months') AND date < $1`,
    [asOf],
  );
  return { asOf, parts, partSuppliers, onHand, onOrder, inflation: infl[0]?.v ?? 3.75 };
}

export function runInventoryStrategy(
  input: StrategyInput,
  demand: DemandResult,
  delay: SupplierDelayResult,
  failure: FailureResult,
) {
  const holdingRate = BASE_HOLDING + input.inflation / 100;
  const quarter = Math.floor((Number(input.asOf.slice(5, 7)) - 1) / 3);
  const onHand = new Map(input.onHand.map((o) => [o.sku, o.units]));
  const onOrder = new Map(input.onOrder.map((o) => [o.sku, o.units]));
  const supplierStats = new Map(delay.output.suppliers.map((s) => [s.supplier, s]));
  const failRate = new Map(failure.output.rows.map((r) => [`${r.sku}|${r.supplier}`, r.rate]));
  const perModel = new Map(demand.output.perModel.map((m) => [m.model as string, m]));

  const rows = input.parts.map((p) => {
    const dm = perModel.get(p.tractor_model)!;
    const next3 = dm.forecast.slice(0, 3);
    const monthly = (next3.reduce((a, f) => a + Math.max(f.units, f.booked), 0) / 3) * p.qty_per_tractor;
    const sdMonthly = dm.sigma * p.qty_per_tractor;

    const options = input.partSuppliers
      .filter((s) => s.sku === p.sku)
      .map((s) => {
        const st = supplierStats.get(s.supplier);
        const expDelay = st ? st.byQuarter[quarter] : 15;
        const spread = st ? Math.max(1, (st.p90Delay - st.meanDelay) / 1.2816) : 8;
        const fr = failRate.get(`${p.sku}|${s.supplier}`) ?? 0.05;
        const effectiveCost = (s.unit_price / (1 - fr)) * (1 + DELAY_COST_PER_DAY * expDelay);
        return {
          supplier: s.supplier,
          unitPrice: s.unit_price,
          quotedLeadDays: s.nominal_lead_days,
          expectedDelayDays: round(expDelay, 1),
          leadMonths: (s.nominal_lead_days + expDelay) / 30,
          sdLeadMonths: spread / 30,
          failureRate: fr,
          effectiveCost: round(effectiveCost, 2),
        };
      })
      .sort((a, b) => a.effectiveCost - b.effectiveCost);
    const best = options[0];

    const safety = Z95 * Math.sqrt(best.leadMonths * sdMonthly ** 2 + monthly ** 2 * best.sdLeadMonths ** 2);
    const reorderPoint = monthly * best.leadMonths + safety;
    const target = reorderPoint + monthly * REVIEW_MONTHS;
    const have = onHand.get(p.sku) ?? 0;
    const coming = onOrder.get(p.sku) ?? 0;
    const position = have + coming;

    let action: "order" | "ok" | "excess" = "ok";
    let quantity = 0;
    if (position < reorderPoint) {
      action = "order";
      const annual = monthly * 12;
      const eoq = Math.sqrt((2 * annual * 400) / (best.unitPrice * holdingRate));
      quantity = Math.ceil(Math.max(target - position, Math.min(eoq, monthly)) / (1 - best.failureRate));
    } else if (position > target + monthly * EXCESS_MONTHS) {
      action = "excess";
    }
    const excessUnits = action === "excess" ? Math.round(position - target) : 0;
    const reason =
      action === "order"
        ? `${have} on hand and ${coming} on order is below the reorder point of ${Math.round(reorderPoint)}. ${best.supplier} has the lowest cost after failures (${(best.failureRate * 100).toFixed(1)}%) and delay (${best.expectedDelayDays} days).`
        : action === "excess"
          ? `${position} on hand and on order is ${excessUnits} above the target of ${Math.round(target)}. Holding the excess costs about $${Math.round((excessUnits * best.unitPrice * holdingRate) / 12).toLocaleString()} a month.`
          : `${position} on hand and on order covers the reorder point of ${Math.round(reorderPoint)}.`;

    return {
      sku: p.sku,
      tractorModel: p.tractor_model,
      category: p.category,
      monthlyDemand: round(monthly),
      onHand: have,
      onOrder: coming,
      position,
      safetyStock: round(safety),
      reorderPoint: round(reorderPoint),
      target: round(target),
      daysOfCover: monthly > 0 ? round((have / monthly) * 30) : null,
      action,
      quantity,
      supplier: best.supplier,
      unitPrice: best.unitPrice,
      spend: round(quantity * best.unitPrice),
      excessUnits,
      excessValue: round(excessUnits * best.unitPrice),
      reason,
      options: options.map((o) => ({
        supplier: o.supplier,
        unitPrice: o.unitPrice,
        quotedLeadDays: o.quotedLeadDays,
        expectedDelayDays: o.expectedDelayDays,
        failureRate: round(o.failureRate, 4),
        effectiveCost: o.effectiveCost,
      })),
    };
  });

  const toOrder = rows.filter((r) => r.action === "order");
  const excess = rows.filter((r) => r.action === "excess");
  return {
    metrics: { serviceLevel: 0.95, holdingRate: round(holdingRate, 4), inflation: round(input.inflation, 2), reviewMonths: REVIEW_MONTHS },
    output: {
      rows,
      toOrder: toOrder.length,
      spend: round(toOrder.reduce((a, r) => a + r.spend, 0)),
      excess: excess.length,
      excessValue: round(excess.reduce((a, r) => a + r.excessValue, 0)),
    },
  };
}

export type StrategyResult = ReturnType<typeof runInventoryStrategy>;
