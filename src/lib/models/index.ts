import { q } from "../db";
import { loadDemandInput, runDemand, DEMAND_SPEC, type DemandResult } from "./demand";
import { loadSupplierDelayInput, runSupplierDelay, SUPPLIER_DELAY_SPEC, type SupplierDelayResult } from "./supplierDelay";
import { loadFailureInput, runComponentFailure, FAILURE_SPEC, type FailureResult } from "./componentFailure";
import { loadStrategyInput, runInventoryStrategy, STRATEGY_SPEC, type StrategyResult } from "./inventoryStrategy";
import { loadStockout } from "./stock";

export const MODEL_SPECS = {
  demand: { title: "Demand fluctuations", ...DEMAND_SPEC },
  supplier_delay: { title: "Supplier delays", ...SUPPLIER_DELAY_SPEC },
  component_failure: { title: "Component failures", ...FAILURE_SPEC },
  inventory_strategy: { title: "Cost-effective inventory strategy", ...STRATEGY_SPEC },
} as const;

export type ModelName = keyof typeof MODEL_SPECS;
export const MODEL_NAMES = Object.keys(MODEL_SPECS) as ModelName[];

export type AllResults = {
  demand: DemandResult;
  supplier_delay: SupplierDelayResult;
  component_failure: FailureResult;
  inventory_strategy: StrategyResult;
};

export async function runAllModels(asOf: string): Promise<AllResults> {
  const demand = runDemand(await loadDemandInput(asOf));
  const component_failure = runComponentFailure(await loadFailureInput(asOf));
  const stockout = await loadStockout();
  const supplier_delay = runSupplierDelay(await loadSupplierDelayInput(asOf, stockout));
  const inventory_strategy = runInventoryStrategy(await loadStrategyInput(asOf), demand, supplier_delay, component_failure);
  return { demand, supplier_delay, component_failure, inventory_strategy };
}

export async function saveRuns(asOf: string, results: AllResults) {
  for (const name of MODEL_NAMES) {
    const r = results[name];
    await q(`INSERT INTO model_runs (model, as_of, metrics, output) VALUES ($1,$2,$3,$4)`, [
      name,
      asOf,
      JSON.stringify(r.metrics),
      JSON.stringify(r.output),
    ]);
  }
}

export async function latestRuns(): Promise<(AllResults & { ranAt: string }) | null> {
  const rows = await q<{ model: ModelName; metrics: unknown; output: unknown; ran_at: Date }>(
    `SELECT DISTINCT ON (model) model, metrics, output, ran_at FROM model_runs ORDER BY model, ran_at DESC`,
  );
  if (rows.length < MODEL_NAMES.length) return null;
  const out = Object.fromEntries(rows.map((r) => [r.model, { metrics: r.metrics, output: r.output }])) as unknown as AllResults;
  const ranAt = rows.map((r) => r.ran_at).sort((a, b) => b.getTime() - a.getTime())[0].toISOString();
  return { ...out, ranAt };
}
