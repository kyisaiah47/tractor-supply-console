"use client";

import { Fragment, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CaretDown, CaretRight, ShoppingCart } from "@phosphor-icons/react";
import type { StrategyRow } from "@/lib/types";
import { n0, pct, usd } from "@/lib/format";
import { newIdempotencyKey } from "@/lib/idempotency";

type Row = StrategyRow;

export function StrategyView({ rows }: { rows: Row[] }) {
  const [action, setAction] = useState<"order" | "ok" | "excess" | "all">("order");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  // One key per Queue selected action. A retry after an error reuses it; a success starts a new one.
  const queueKey = useRef(newIdempotencyKey());
  const shown = rows.filter((r) => action === "all" || r.action === action);
  const counts = { order: 0, ok: 0, excess: 0 } as Record<string, number>;
  rows.forEach((r) => counts[r.action]++);
  const selRows = rows.filter((r) => sel.has(r.sku) && r.action === "order");

  async function queue() {
    setBusy(true);
    const res = await fetch("/api/supply-orders", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": queueKey.current },
      body: JSON.stringify({
        source: "recommendation",
        lines: selRows.map((r) => ({ sku: r.sku, quantity: r.quantity, supplier: r.supplier, note: r.reason })),
      }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) queueKey.current = newIdempotencyKey();
    setMsg(res.ok ? `Queued ${body.created.length} supply orders.` : `Nothing was queued: ${JSON.stringify(body.error)}`);
    setSel(new Set());
    router.refresh();
  }

  return (
    <div>
      <div className="ctl-row" style={{ borderBottom: "1px solid var(--line)" }}>
        <span className="label">Action</span>
        <div className="chips" role="group" aria-label="Recommended action">
          {(["order", "ok", "excess", "all"] as const).map((a) => (
            <button key={a} className="chip" aria-pressed={action === a} onClick={() => setAction(a)}>
              {a === "order" ? "Order now" : a === "ok" ? "Covered" : a === "excess" ? "Excess" : "All parts"}
              <span className="n">{a === "all" ? rows.length : counts[a]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="selbar">
        {selRows.length ? (
          <span>
            <b className="mono">{selRows.length}</b> selected for <b className="mono">{usd(selRows.reduce((a, r) => a + r.spend, 0))}</b>
          </span>
        ) : (
          <span className="dim">{msg ?? "Select recommendations to queue them as supply orders."}</span>
        )}
        <span className="right">
          <button className="btn primary" disabled={!selRows.length || busy} onClick={queue}>
            <ShoppingCart size={16} />
            {busy ? "Queueing" : "Queue selected"}
          </button>
        </span>
      </div>
      <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th className="check"></th>
              <th>Part</th>
              <th className="num">A month</th>
              <th className="num">On hand</th>
              <th className="num">On order</th>
              <th className="num">Reorder at</th>
              <th className="num">Days of stock</th>
              <th>Action</th>
              <th className="num">Qty</th>
              <th>Supplier</th>
              <th className="num">Spend</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const isOpen = open.has(r.sku);
              return (
                <Fragment key={r.sku}>
                  <tr className={sel.has(r.sku) ? "sel" : ""}>
                    <td className="check">
                      {r.action === "order" && (
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.sku}`}
                          checked={sel.has(r.sku)}
                          onChange={() =>
                            setSel((s) => {
                              const n = new Set(s);
                              if (n.has(r.sku)) n.delete(r.sku);
                              else n.add(r.sku);
                              return n;
                            })
                          }
                        />
                      )}
                    </td>
                    <td>
                      <button
                        className="rowbtn"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setOpen((s) => {
                            const n = new Set(s);
                            if (n.has(r.sku)) n.delete(r.sku);
                            else n.add(r.sku);
                            return n;
                          })
                        }
                      >
                        {isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}
                        {r.sku}
                      </button>{" "}
                      <span className="dim">{r.category}</span>
                    </td>
                    <td className="num">{n0(r.monthlyDemand)}</td>
                    <td className="num">{n0(r.onHand)}</td>
                    <td className="num">{n0(r.onOrder)}</td>
                    <td className="num">{n0(r.reorderPoint)}</td>
                    <td className="num">{r.daysOfCover ?? "-"}</td>
                    <td>
                      <span className={`tag ${r.action === "order" ? "watch" : r.action === "excess" ? "short" : "covered"}`}>
                        {r.action === "order" ? "order now" : r.action === "excess" ? "excess" : "covered"}
                      </span>
                    </td>
                    <td className="num">{r.quantity || "-"}</td>
                    <td>{r.supplier}</td>
                    <td className="num">{r.spend ? usd(r.spend) : "-"}</td>
                  </tr>
                  {isOpen && (
                    <tr className="open-row">
                      <td colSpan={11}>
                        <p style={{ margin: "0 0 10px", color: "var(--ink-2)" }}>
                          {r.reason} Target stock after ordering is {n0(r.target)}, with {n0(r.safetyStock)} held as safety stock.
                        </p>
                        <table className="grid" style={{ maxWidth: 760 }}>
                          <thead>
                            <tr>
                              <th>Supplier</th>
                              <th className="num">Unit price</th>
                              <th className="num">Quoted lead</th>
                              <th className="num">Expected delay</th>
                              <th className="num">Failure rate</th>
                              <th className="num">Effective cost</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.options.map((o, i) => (
                              <tr key={o.supplier}>
                                <td>
                                  <span className="with-tag">
                                    {o.supplier}
                                    {i === 0 && <span className="tag covered">lowest</span>}
                                  </span>
                                </td>
                                <td className="num">{usd(o.unitPrice)}</td>
                                <td className="num">{o.quotedLeadDays} days</td>
                                <td className="num">{o.expectedDelayDays} days</td>
                                <td className="num">{pct(o.failureRate)}</td>
                                <td className="num">{usd(o.effectiveCost)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!shown.length && <div className="empty">No part is in this state.</div>}
      </div>
    </div>
  );
}
