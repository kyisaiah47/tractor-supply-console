// Shapes of the JSON the Python API returns. The API is the source of truth; these types only
// describe the fields the UI reads.

export type Shortfall = { sku: string; category: string; short: number };

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
  shortfalls: Shortfall[];
};

type Facet = Record<string, { orders: number; tractors: number }>;

export type OrdersData = {
  tab: "pipeline" | "backlog";
  months: number;
  asOf: string;
  through: string;
  totals: { orders: number; tractors: number; short: number };
  facets: { model: Facet; warehouse: Facet; parts: Facet };
  rows: OrderRow[];
};

export type Overview = {
  asOf: string;
  backlogOrders: number;
  backlogTractors: number;
  pipelineOrders: number;
  pipelineTractors: number;
  supplyPlaced: number;
  supplyQueued: number;
  jobsPending: number;
  workerSeen: string | null;
  lateRisk: number;
  partsToOrder: number;
  elevatedFailures: number;
  forecast12: number;
  modelsRanAt: string | null;
  lastOrderAt: string | null;
};

export type Brief = { as_of: string; generated_at: string; author: string; body: string };

export type ForecastMonth = { ym: string; units: number; lo: number; hi: number; booked: number; unbooked: number };
export type DemandPerModel = { model: string; sigma: number; history: { ym: string; units: number }[]; forecast: ForecastMonth[] };

export type DemandResult = {
  metrics: {
    chosen: string;
    backtest: Record<string, { mae: number; mape: number }>;
    diagnostics: { corrDemandVsTrendIndex: number; corrDemandVsInflation: number };
  };
  output: { horizon: string[]; perModel: DemandPerModel[]; total12: number; booked12: number };
};

export type SupplierDelayResult = {
  metrics: {
    backtest: { model_mae: number; overall_mean_mae: number; dataset_supplier_mean_mae: number; test_orders: number };
    overallMeanDelay: number;
  };
  output: {
    suppliers: {
      supplier: string;
      orders: number;
      meanDelay: number;
      p90Delay: number;
      onTimeRate: number;
      datasetMeanDelay: number;
      byQuarter: number[];
    }[];
    openOrders: {
      id: number;
      sku: string;
      supplier: string;
      quantity: number;
      promised: string;
      expectedArrival: string;
      p90Arrival: string;
      needBy: string | null;
      lateRisk: number;
    }[];
    atRisk: number;
  };
};

export type FailureResult = {
  metrics: { backtest: { model_mae_units: number; dataset_rate_mae_units: number; test_pairs: number } };
  output: {
    rows: {
      sku: string;
      category: string;
      supplier: string;
      units: number;
      broken: number;
      stages: { receiving: number; assembly: number; field: number };
      rate: number;
      lo: number;
      hi: number;
      prior: number;
      elevated: boolean;
    }[];
    expectedBrokenInPipeline: number;
  };
};

export type StrategyRow = {
  sku: string;
  tractorModel: string;
  category: string;
  monthlyDemand: number;
  onHand: number;
  onOrder: number;
  position: number;
  safetyStock: number;
  reorderPoint: number;
  target: number;
  daysOfCover: number | null;
  action: "order" | "ok" | "excess";
  quantity: number;
  supplier: string;
  unitPrice: number;
  spend: number;
  excessUnits: number;
  excessValue: number;
  reason: string;
  options: { supplier: string; unitPrice: number; quotedLeadDays: number; expectedDelayDays: number; failureRate: number; effectiveCost: number }[];
};

export type StrategyResult = {
  metrics: { inflation: number };
  output: { rows: StrategyRow[]; toOrder: number; spend: number; excess: number; excessValue: number };
};

export type ModelSpec = { title: string; predicts: string; dataSources: string[]; inputs: string[]; outputs: string[]; method: string };
export type ModelName = "demand" | "supplier_delay" | "component_failure" | "inventory_strategy";

export type ModelsData = {
  specs: Record<ModelName, ModelSpec>;
  asOf: string;
  ranAt: string;
  demand: DemandResult;
  supplier_delay: SupplierDelayResult;
  component_failure: FailureResult;
  inventory_strategy: StrategyResult;
};

export type SupplySummary = { console: Record<string, number>; history: { placed: number; fulfilled: number } };

export type LlmUsage = {
  provider: string;
  model: string;
  totals: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    avg_latency_ms: number;
    avg_tool_rounds: number;
    errors: number;
  };
};
