// Demand forecast: tractors ordered per model per month, 12 months ahead.
//
// Four candidate models are fitted and scored on the last two years before the planning date,
// each forecast 12 months ahead from the end of the year before. The candidate with the lowest
// mean absolute percentage error is used for the live forecast.
//
// Exogenous market inputs are not known for future months, so in the backtest and in the
// forecast they are held at their trailing 12-month mean. A candidate that only helps when
// it is given the future's market data would be cheating the backtest.

import { q } from "../db";
import { addMonths, monthIndex, monthRange } from "../dates";
import { MODEL_CODES } from "../catalog";
import { mae, mape, mean, ols, dot, pearson, rmse, round, Z80 } from "../stats";

export type DemandInput = {
  asOf: string;
  history: { model: string; ym: string; units: number }[];
  market: { model: string; ym: string; demand: number; trend: number; inflation: number }[];
  booked: { model: string; ym: string; units: number }[];
};

export const CANDIDATES = ["trailing_mean", "seasonal_naive", "trend_seasonal", "trend_seasonal_market"] as const;
export type Candidate = (typeof CANDIDATES)[number];

export const DEMAND_SPEC = {
  predicts: "Tractors ordered per model per month for the next 12 months, with a likely range.",
  dataSources: [
    "Customer order history, the last four years",
    "Market data: market demand, market trend index and inflation by month",
    "Open orders for the next 12 months, to show how much of each month is already booked",
  ],
  inputs: ["tractor model", "calendar month", "trend over time", "market demand, trend index and inflation"],
  outputs: ["forecast tractors per model per month", "likely range", "booked and not yet booked tractors", "accuracy of each method"],
  method:
    "Four candidate forecasts: last year's average, the same month last year, trend plus month of year, and trend plus month plus market inputs. Each is tested on the last two years and the most accurate is used.",
};

export async function loadDemandInput(asOf: string): Promise<DemandInput> {
  const history = await q<{ model: string; ym: string; units: number }>(
    `SELECT tractor_model AS model, to_char(requested_date,'YYYY-MM') AS ym, SUM(quantity)::int AS units
       FROM customer_orders WHERE requested_date < $1 AND status <> 'cancelled' GROUP BY 1,2`,
    [asOf],
  );
  const market = await q<{ model: string; ym: string; demand: number; trend: number; inflation: number }>(
    `SELECT tractor_model AS model, to_char(date,'YYYY-MM') AS ym, SUM(demand_units)::float AS demand,
            AVG(market_trend_index)::float AS trend, AVG(inflation_rate)::float AS inflation
       FROM market_signals WHERE date < $1 GROUP BY 1,2`,
    [asOf],
  );
  const booked = await q<{ model: string; ym: string; units: number }>(
    `SELECT tractor_model AS model, to_char(requested_date,'YYYY-MM') AS ym, SUM(quantity)::int AS units
       FROM customer_orders WHERE requested_date >= date_trunc('month', $1::date) AND status <> 'cancelled' GROUP BY 1,2`,
    [asOf],
  );
  return { asOf, history, market, booked };
}

type Series = { ym: string; units: number; demand: number; trend: number; inflation: number }[];

function features(ym: string, t: number, exog?: { demand: number; trend: number; inflation: number }) {
  const m = monthIndex(ym);
  const dummies = Array.from({ length: 11 }, (_, i) => (m === i + 1 ? 1 : 0));
  const base = [1, t / 12, ...dummies];
  return exog ? [...base, exog.demand / 1000, exog.trend, exog.inflation] : base;
}

function tIndex(ym: string) {
  return (Number(ym.slice(0, 4)) - 2020) * 12 + monthIndex(ym);
}

// Fit one candidate on `train` and predict `horizon` months.
export function predict(candidate: Candidate, train: Series, horizon: string[]): number[] {
  const last12 = train.slice(-12);
  if (candidate === "trailing_mean") {
    const m = mean(last12.map((r) => r.units));
    return horizon.map(() => m);
  }
  if (candidate === "seasonal_naive") {
    const byMonth = new Map(last12.map((r) => [monthIndex(r.ym), r.units]));
    return horizon.map((ym) => byMonth.get(monthIndex(ym)) ?? mean(last12.map((r) => r.units)));
  }
  const withMarket = candidate === "trend_seasonal_market";
  const X = train.map((r) => features(r.ym, tIndex(r.ym), withMarket ? r : undefined));
  const beta = ols(X, train.map((r) => r.units), 1e-4);
  const exogHold = {
    demand: mean(last12.map((r) => r.demand)),
    trend: mean(last12.map((r) => r.trend)),
    inflation: mean(last12.map((r) => r.inflation)),
  };
  return horizon.map((ym) => Math.max(0, dot(beta, features(ym, tIndex(ym), withMarket ? exogHold : undefined))));
}

function seriesFor(input: DemandInput, model: string): Series {
  const hist = new Map(input.history.filter((h) => h.model === model).map((h) => [h.ym, h.units]));
  const mkt = new Map(input.market.filter((h) => h.model === model).map((h) => [h.ym, h]));
  const lastYm = addMonths(input.asOf.slice(0, 7), -1);
  const firstYm = input.history.reduce((a, h) => (h.ym < a ? h.ym : a), lastYm);
  return monthRange(firstYm, lastYm).map((ym) => ({
    ym,
    units: hist.get(ym) ?? 0,
    demand: mkt.get(ym)?.demand ?? 0,
    trend: mkt.get(ym)?.trend ?? 0.5,
    inflation: mkt.get(ym)?.inflation ?? 3.75,
  }));
}

export function runDemand(input: DemandInput) {
  const asOfYm = input.asOf.slice(0, 7);
  const folds = [
    { trainTo: addMonths(asOfYm, -25), test: monthRange(addMonths(asOfYm, -24), addMonths(asOfYm, -13)) },
    { trainTo: addMonths(asOfYm, -13), test: monthRange(addMonths(asOfYm, -12), addMonths(asOfYm, -1)) },
  ];

  const backtest: Record<Candidate, { mae: number; mape: number; rmseByModel: Record<string, number> }> = {} as never;
  for (const c of CANDIDATES) {
    const maes: number[] = [];
    const mapes: number[] = [];
    const rmseByModel: Record<string, number> = {};
    for (const model of MODEL_CODES) {
      const s = seriesFor(input, model);
      const errs: number[] = [];
      for (const f of folds) {
        const train = s.filter((r) => r.ym <= f.trainTo);
        const test = s.filter((r) => f.test.includes(r.ym));
        const pred = predict(c, train, f.test);
        const act = test.map((r) => r.units);
        maes.push(mae(act, pred));
        mapes.push(mape(act, pred));
        errs.push(rmse(act, pred));
      }
      rmseByModel[model] = mean(errs);
    }
    backtest[c] = { mae: round(mean(maes), 1), mape: round(mean(mapes), 4), rmseByModel };
  }
  const chosen = [...CANDIDATES].sort((a, b) => backtest[a].mape - backtest[b].mape)[0];

  const horizon = monthRange(asOfYm, addMonths(asOfYm, 11));
  const booked = new Map(input.booked.map((b) => [`${b.model}|${b.ym}`, b.units]));
  const perModel = MODEL_CODES.map((model) => {
    const s = seriesFor(input, model);
    const pred = predict(chosen, s, horizon);
    const sigma = backtest[chosen].rmseByModel[model];
    return {
      model,
      sigma: round(sigma, 1),
      history: s.slice(-24).map((r) => ({ ym: r.ym, units: r.units })),
      forecast: horizon.map((ym, i) => {
        const b = booked.get(`${model}|${ym}`) ?? 0;
        const widen = Math.sqrt(1 + i / 12);
        return {
          ym,
          units: round(pred[i]),
          lo: Math.max(0, round(pred[i] - Z80 * sigma * widen)),
          hi: round(pred[i] + Z80 * sigma * widen),
          booked: b,
          unbooked: Math.max(0, round(pred[i]) - b),
        };
      }),
    };
  });

  // Does the provided dataset carry demand signal on its own? Row-level correlations.
  const allMarket = input.market;
  const diagnostics = {
    corrDemandVsTrendIndex: round(pearson(allMarket.map((m) => m.demand), allMarket.map((m) => m.trend)), 3),
    corrDemandVsInflation: round(pearson(allMarket.map((m) => m.demand), allMarket.map((m) => m.inflation)), 3),
  };

  const total12 = perModel.reduce((a, m) => a + m.forecast.reduce((x, f) => x + f.units, 0), 0);
  const booked12 = perModel.reduce((a, m) => a + m.forecast.reduce((x, f) => x + f.booked, 0), 0);
  return {
    metrics: { chosen, backtest, diagnostics, folds: folds.map((f) => `${f.test[0]}..${f.test[11]}`) },
    output: { horizon, perModel, total12, booked12 },
  };
}

export type DemandResult = ReturnType<typeof runDemand>;
