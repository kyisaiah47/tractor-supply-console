"use client";

import { useState } from "react";
import type { DemandResult } from "@/lib/types";
import { ym } from "@/lib/format";

type PerModel = DemandResult["output"]["perModel"];

export function DemandView({ perModel }: { perModel: PerModel }) {
  const [model, setModel] = useState<string>("all");
  const series = model === "all" ? sumAll(perModel) : perModel.find((m) => m.model === model)!;

  const W = 900;
  const H = 260;
  const P = { l: 44, r: 12, t: 12, b: 26 };
  const hist = series.history;
  const fc = series.forecast;
  const n = hist.length + fc.length;
  const max = Math.max(...hist.map((h) => h.units), ...fc.map((f) => f.hi)) * 1.08;
  const x = (i: number) => P.l + (i / (n - 1)) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - (v / max) * (H - P.t - P.b);
  const bw = ((W - P.l - P.r) / n) * 0.55;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round((max * t) / 10) * 10);
  const histPath = hist.map((h, i) => `${i ? "L" : "M"}${x(i)},${y(h.units)}`).join("");
  const fcPath = [`M${x(hist.length - 1)},${y(hist[hist.length - 1].units)}`, ...fc.map((f, i) => `L${x(hist.length + i)},${y(f.units)}`)].join("");
  const band =
    fc.map((f, i) => `${i ? "L" : "M"}${x(hist.length + i)},${y(f.hi)}`).join("") +
    [...fc].reverse().map((f, i) => `L${x(hist.length + fc.length - 1 - i)},${y(f.lo)}`).join("") +
    "Z";

  return (
    <div>
      <div className="ctl-row" style={{ borderBottom: "1px solid var(--line)" }}>
        <span className="label">Model</span>
        <div className="chips" role="group" aria-label="Tractor model">
          {["all", ...perModel.map((m) => m.model)].map((m) => (
            <button key={m} className="chip" aria-pressed={model === m} onClick={() => setModel(m)}>
              {m === "all" ? "All models" : m}
            </button>
          ))}
        </div>
      </div>
      <div className="chart">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Tractors ordered per month for ${model === "all" ? "all models" : model}: 24 months of history and a 12-month forecast`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="#232a31" />
              <text x={P.l - 8} y={y(t) + 4} fill="#7b8691" fontSize="11" textAnchor="end" fontFamily="var(--mono)">
                {t}
              </text>
            </g>
          ))}
          <line x1={x(hist.length - 0.5)} x2={x(hist.length - 0.5)} y1={P.t} y2={H - P.b} stroke="#313a43" strokeDasharray="3 4" />
          <text x={x(hist.length - 0.5) + 6} y={P.t + 10} fill="#7b8691" fontSize="11" fontFamily="var(--mono)">
            forecast
          </text>
          {fc.map((f, i) => (
            <rect key={f.ym} x={x(hist.length + i) - bw / 2} y={y(f.booked)} width={bw} height={H - P.b - y(f.booked)} fill="rgba(124,196,255,0.18)" />
          ))}
          <path d={band} fill="rgba(240,181,76,0.12)" />
          <path d={histPath} fill="none" stroke="#e6ebef" strokeWidth="1.8" />
          <path d={fcPath} fill="none" stroke="#f0b54c" strokeWidth="1.8" strokeDasharray="5 4" />
          {[...hist.map((h) => h.ym), ...fc.map((f) => f.ym)].map((m, i) =>
            i % 3 === 0 ? (
              <text key={m} x={x(i)} y={H - 8} fill="#7b8691" fontSize="11" textAnchor="middle" fontFamily="var(--mono)">
                {ym(m)}
              </text>
            ) : null,
          )}
        </svg>
      </div>
      <div className="legend">
        <span>
          <i style={{ background: "#e6ebef" }} />
          Ordered, by requested month
        </span>
        <span>
          <i style={{ background: "#f0b54c" }} />
          Forecast and likely range
        </span>
        <span>
          <i style={{ background: "rgba(124,196,255,0.45)", height: 8 }} />
          Already booked
        </span>
      </div>
      <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Month</th>
              {fc.map((f) => (
                <th key={f.ym} className="num">
                  {ym(f.ym)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Forecast</td>
              {fc.map((f) => (
                <td key={f.ym} className="num">
                  {f.units}
                </td>
              ))}
            </tr>
            <tr>
              <td>Likely range</td>
              {fc.map((f) => (
                <td key={f.ym} className="num dim">
                  {f.lo}-{f.hi}
                </td>
              ))}
            </tr>
            <tr>
              <td>Booked</td>
              {fc.map((f) => (
                <td key={f.ym} className="num">
                  {f.booked}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function sumAll(perModel: PerModel) {
  const first = perModel[0];
  return {
    model: "all",
    history: first.history.map((h, i) => ({ ym: h.ym, units: perModel.reduce((a, m) => a + m.history[i].units, 0) })),
    forecast: first.forecast.map((f, i) => ({
      ym: f.ym,
      units: perModel.reduce((a, m) => a + m.forecast[i].units, 0),
      lo: perModel.reduce((a, m) => a + m.forecast[i].lo, 0),
      hi: perModel.reduce((a, m) => a + m.forecast[i].hi, 0),
      booked: perModel.reduce((a, m) => a + m.forecast[i].booked, 0),
      unbooked: perModel.reduce((a, m) => a + m.forecast[i].unbooked, 0),
    })),
  };
}
