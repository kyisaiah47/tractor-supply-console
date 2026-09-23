import Link from "next/link";
import { latestRuns, MODEL_SPECS, type ModelName } from "@/lib/models";
import { AS_OF } from "@/lib/config";
import { DemandView } from "@/components/models/DemandView";
import { StrategyView } from "@/components/models/StrategyView";
import { RunWeeklyButton } from "@/components/models/RunWeeklyButton";
import { CANDIDATE_LABEL, day, dayShort, n0, pct, stamp } from "@/lib/format";

export const dynamic = "force-dynamic";

function Spec({ name, children }: { name: ModelName; children?: React.ReactNode }) {
  const s = MODEL_SPECS[name];
  return (
    <div className="spec">
      <div className="kv">
        <div>Predicts</div>
        <div>{s.predicts}</div>
        <div>Data sources</div>
        <div>
          <ul>
            {s.dataSources.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        </div>
        <div>Inputs</div>
        <div>{s.inputs.join(", ")}</div>
        <div>Outputs</div>
        <div>{s.outputs.join(", ")}</div>
        <div>Method</div>
        <div>{s.method}</div>
        {children}
      </div>
    </div>
  );
}

const TABS = [
  { key: "demand", label: "Demand" },
  { key: "supplier-delay", label: "Supplier delays" },
  { key: "component-failure", label: "Component failures" },
  { key: "inventory-strategy", label: "Reorder plan" },
] as const;

export default async function ModelsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: tabParam } = await searchParams;
  const tab = TABS.some((t) => t.key === tabParam) ? tabParam : "demand";
  const runs = await latestRuns();
  if (!runs) {
    return (
      <div className="empty">
        No model runs yet. <RunWeeklyButton />
      </div>
    );
  }
  const d = runs.demand;
  const sd = runs.supplier_delay;
  const cf = runs.component_failure;
  const inv = runs.inventory_strategy;
  const atRisk = sd.output.openOrders.filter((o) => o.lateRisk >= 0.5).sort((a, b) => b.lateRisk - a.lateRisk);

  return (
    <>
      <div className="toolbar">
        <nav className="tabs" role="tablist" aria-label="Models">
          {TABS.map((t) => (
            <Link key={t.key} href={`/models?tab=${t.key}`} role="tab" aria-selected={tab === t.key} scroll={false}>
              {t.label}
            </Link>
          ))}
        </nav>
        <span className="meta mono dim" style={{ fontSize: 12 }}>
          updated {stamp(runs.ranAt)}, planning date {day(AS_OF)}
        </span>
        <span className="toolbar-right">
          <RunWeeklyButton />
        </span>
      </div>

      {tab === "demand" && (
      <section className="model-band" id="demand">
        <div className="sechead">
          <span className="label">Model 1</span>
          <span className="title">Demand fluctuations</span>
          <span className="right mono dim" style={{ fontSize: 12 }}>
            {CANDIDATE_LABEL[d.metrics.chosen]} was the most accurate
          </span>
        </div>
        <div className="model-grid">
          <Spec name="demand">
            <div>Market data check</div>
            <div>
              Monthly market demand correlates {d.metrics.diagnostics.corrDemandVsTrendIndex} with the market trend index and{" "}
              {d.metrics.diagnostics.corrDemandVsInflation} with inflation. Neither predicts demand on its own.
            </div>
          </Spec>
          <div className="model-body">
            <DemandView perModel={d.output.perModel} />
            <div className="sechead" style={{ borderTop: "1px solid var(--line)" }}>
              <span className="label">Accuracy</span>
              <span className="title">Each method forecast each of the last two years a year ahead, then was checked against real orders</span>
            </div>
            <div className="grid-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Forecast method</th>
                    <th className="num">Average miss, tractors a month</th>
                    <th className="num">Average miss</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(d.metrics.backtest)
                    .sort((a, b) => a[1].mape - b[1].mape)
                    .map(([k, v]) => (
                      <tr key={k}>
                        <td>{CANDIDATE_LABEL[k]}</td>
                        <td className="num">{v.mae}</td>
                        <td className="num">{pct(v.mape)}</td>
                        <td>{k === d.metrics.chosen && <span className="tag covered">in use</span>}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
      )}

      {tab === "supplier-delay" && (
      <section className="model-band" id="supplier-delay">
        <div className="sechead">
          <span className="label">Model 2</span>
          <span className="title">Supplier delays</span>
          <span className="right mono dim" style={{ fontSize: 12 }}>
            off by {sd.metrics.backtest.model_mae} days on average, against {sd.metrics.backtest.dataset_supplier_mean_mae} for the market averages
          </span>
        </div>
        <div className="model-grid">
          <Spec name="supplier_delay">
            <div>Accuracy</div>
            <div>
              Checked on {n0(sd.metrics.backtest.test_orders)} supply orders promised in the last year. The forecast misses by {sd.metrics.backtest.model_mae}{" "}
              days on average. The overall average misses by {sd.metrics.backtest.overall_mean_mae} and the market data&apos;s per-supplier average by{" "}
              {sd.metrics.backtest.dataset_supplier_mean_mae}.
            </div>
          </Spec>
          <div className="model-body">
            <div className="grid-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Supplier</th>
                    <th className="num">Orders</th>
                    <th className="num">Mean days late</th>
                    <th className="num">Worst 10%</th>
                    <th className="num">On time</th>
                    <th>Q1 / Q2 / Q3 / Q4</th>
                    <th className="num">Market average</th>
                  </tr>
                </thead>
                <tbody>
                  {sd.output.suppliers.map((s) => (
                    <tr key={s.supplier}>
                      <td>{s.supplier}</td>
                      <td className="num">{s.orders}</td>
                      <td className="num">{s.meanDelay}</td>
                      <td className="num">{s.p90Delay}</td>
                      <td className="num">{pct(s.onTimeRate, 0)}</td>
                      <td className="code">
                        {s.byQuarter.map((q, i) => (
                          <span key={i} className={q > sd.metrics.overallMeanDelay * 1.2 ? "ink-watch" : ""}>
                            {i > 0 ? " / " : ""}
                            {q}
                          </span>
                        ))}
                      </td>
                      <td className="num dim">{s.datasetMeanDelay}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sechead" style={{ borderTop: "1px solid var(--line)" }}>
              <span className="label">At risk</span>
              <span className="title">Open supply orders likely to arrive after their part runs out</span>
              <span className="right mono dim" style={{ fontSize: 12 }}>
                {atRisk.length} of {sd.output.openOrders.length}
              </span>
            </div>
            <div className="grid-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Supply order</th>
                    <th>Part</th>
                    <th>Supplier</th>
                    <th className="num">Qty</th>
                    <th>Promised</th>
                    <th>Expected</th>
                    <th>Latest likely</th>
                    <th>Runs out</th>
                    <th className="num">Chance late</th>
                  </tr>
                </thead>
                <tbody>
                  {atRisk.slice(0, 15).map((o) => (
                    <tr key={o.id}>
                      <td className="code">#{o.id}</td>
                      <td className="code">{o.sku}</td>
                      <td>{o.supplier}</td>
                      <td className="num">{o.quantity}</td>
                      <td className="code">{dayShort(o.promised)}</td>
                      <td className="code">{dayShort(o.expectedArrival)}</td>
                      <td className="code">{dayShort(o.p90Arrival)}</td>
                      <td className="code ink-short">{dayShort(o.needBy)}</td>
                      <td className="num">
                        <span className={`tag ${o.lateRisk >= 0.8 ? "short" : "watch"}`}>{pct(o.lateRisk, 0)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
      )}

      {tab === "component-failure" && (
      <section className="model-band" id="component-failure">
        <div className="sechead">
          <span className="label">Model 3</span>
          <span className="title">Component failures</span>
          <span className="right mono dim" style={{ fontSize: 12 }}>
            off by {cf.metrics.backtest.model_mae_units} broken parts per part and supplier, against {cf.metrics.backtest.dataset_rate_mae_units} for the market rate
          </span>
        </div>
        <div className="model-grid">
          <Spec name="component_failure">
            <div>In the pipeline</div>
            <div>About {n0(cf.output.expectedBrokenInPipeline)} parts in the next three months of builds will break.</div>
          </Spec>
          <div className="model-body">
            <div className="grid-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th>Part</th>
                    <th>Supplier</th>
                    <th className="num">Units</th>
                    <th className="num">Broken</th>
                    <th className="num">Rate</th>
                    <th>Likely range against the market rate</th>
                    <th>Found at</th>
                  </tr>
                </thead>
                <tbody>
                  {cf.output.rows.slice(0, 14).map((r) => {
                    const scale = (x: number) => `${Math.min(100, (x / 0.16) * 100)}%`;
                    return (
                      <tr key={`${r.sku}-${r.supplier}`}>
                        <td>
                          <span className="mono" style={{ fontSize: 12 }}>
                            {r.sku}
                          </span>{" "}
                          <span className="dim">{r.category}</span>
                        </td>
                        <td>{r.supplier}</td>
                        <td className="num">{n0(r.units)}</td>
                        <td className="num">{n0(r.broken)}</td>
                        <td className={`num ${r.elevated ? "ink-watch" : ""}`}>{pct(r.rate)}</td>
                        <td style={{ minWidth: 180, verticalAlign: "middle" }}>
                          <div className="bar" title={`${pct(r.lo)} to ${pct(r.hi)}; market rate ${pct(r.prior)}`}>
                            <div
                              className="fill"
                              style={{
                                left: scale(r.lo),
                                width: `calc(${scale(r.hi)} - ${scale(r.lo)})`,
                                background: r.elevated ? "var(--watch)" : "var(--ink-3)",
                              }}
                            />
                            <div className="tick" style={{ left: scale(r.prior) }} />
                          </div>
                        </td>
                        <td className="code dim">
                          {r.stages.receiving} / {r.stages.assembly} / {r.stages.field}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="rail-note">
              The bar shows the likely range of the failure rate on a 0 to 16 percent scale. The tick is the market rate for that tractor model.
              Found at counts receiving / assembly / field.
            </p>
          </div>
        </div>
      </section>
      )}

      {tab === "inventory-strategy" && (
      <section className="model-band" id="inventory-strategy">
        <div className="sechead">
          <span className="label">Model 4</span>
          <span className="title">Cost-effective inventory strategy</span>
          <span className="right mono dim" style={{ fontSize: 12 }}>
            {inv.output.toOrder} parts to order, {inv.output.excess} in excess
          </span>
        </div>
        <div className="model-grid">
          <Spec name="inventory_strategy">
            <div>Holding cost</div>
            <div>
              Holding a part for a year is charged at 20 percent of its price plus the last 12 months of inflation, {inv.metrics.inflation} percent.
            </div>
          </Spec>
          <div className="model-body">
            <StrategyView rows={inv.output.rows} />
          </div>
        </div>
      </section>
      )}
    </>
  );
}
