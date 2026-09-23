"use client";

import { Fragment, useEffect, useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { dayShort, usd } from "@/lib/format";
import { useNow } from "@/lib/useNow";

type Row = {
  id: number;
  sku: string;
  category: string;
  tractor_model: string;
  supplier: string | null;
  warehouse: string;
  quantity: number;
  unit_price: number | null;
  date_ordered: string;
  promised_date: string | null;
  status: string;
  source: string;
  external_ref: string | null;
  note: string | null;
  job_id: number | null;
  job_status: string | null;
  attempts: number | null;
  last_error: string | null;
  log: { at: string; msg: string; quotes?: { supplier: string; unitPrice: number; canFill: boolean; leadDays: number; failureRate: number; expectedDelay: number; effective: number }[]; errors?: string[] }[] | null;
};

const TAG: Record<string, string> = { queued: "watch", placed: "covered", failed: "short", fulfilled: "covered" };
const STATUS: Record<string, string> = { queued: "awaiting quotes", placed: "placed", failed: "failed", fulfilled: "delivered" };
const SOURCE: Record<string, string> = {
  selected_orders: "Order all selected",
  recommendation: "Recommendation",
  chatbot: "Assistant",
  api: "Integration",
  order_form: "Order form",
};

export function SupplyQueue() {
  const [rows, setRows] = useState<Row[]>([]);
  const [workers, setWorkers] = useState<{ worker: string; seen_at: string; processed: number }[]>([]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const [a, b] = await Promise.all([
        fetch("/api/supply-orders?source=app&limit=200").then((r) => r.json()),
        fetch("/api/queue").then((r) => r.json()),
      ]);
      if (!alive) return;
      setRows(a.supplyOrders);
      setWorkers(b.workers);
      setLoaded(true);
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const now = useNow(2_000);
  const online = workers.filter((w) => now - new Date(w.seen_at).getTime() < 30_000);

  return (
    <section>
      <div className="sechead">
        <span className="label">Queue</span>
        <span className="title">Supply orders placed from the console</span>
        <span className="right" style={{ fontSize: 12 }}>
          <i className={`dot ${online.length ? "" : "off"}`} />
          <span className="mono dim">
            {online.length ? "Supplier ordering is running. This list updates live." : "Supplier ordering is paused. New orders wait until it resumes."}
          </span>
        </span>
      </div>
      <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Supply order</th>
              <th>Part</th>
              <th className="num">Qty</th>
              <th>WH</th>
              <th>From</th>
              <th>Status</th>
              <th>Supplier</th>
              <th className="num">Unit price</th>
              <th>Promised</th>
              <th>Supplier ref</th>
              <th className="num">Attempts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isOpen = open.has(r.id);
              return (
                <Fragment key={r.id}>
                  <tr>
                    <td>
                      <button
                        className="rowbtn"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setOpen((s) => {
                            const n = new Set(s);
                            if (n.has(r.id)) n.delete(r.id);
                            else n.add(r.id);
                            return n;
                          })
                        }
                      >
                        {isOpen ? <CaretDown size={12} /> : <CaretRight size={12} />}#{r.id}
                      </button>
                    </td>
                    <td>
                      <span className="mono" style={{ fontSize: 12 }}>
                        {r.sku}
                      </span>{" "}
                      <span className="dim">{r.category}</span>
                    </td>
                    <td className="num">{r.quantity}</td>
                    <td className="code">{r.warehouse}</td>
                    <td className="dim">{SOURCE[r.source] ?? r.source}</td>
                    <td>
                      <span className={`tag ${TAG[r.status] ?? ""}`}>{STATUS[r.status] ?? r.status}</span>
                    </td>
                    <td>{r.supplier ?? "-"}</td>
                    <td className="num">{r.unit_price ? usd(r.unit_price) : "-"}</td>
                    <td className="code">{r.promised_date ? dayShort(r.promised_date) : "-"}</td>
                    <td className="code dim">{r.external_ref ?? "-"}</td>
                    <td className="num">{r.attempts ?? 0}</td>
                  </tr>
                  {isOpen && (
                    <tr className="open-row">
                      <td colSpan={11}>
                        {r.note && <p style={{ margin: "0 0 10px", color: "var(--ink-2)" }}>{r.note}</p>}
                        {(r.log ?? []).map((l, i) => (
                          <div key={i} style={{ marginBottom: 10 }}>
                            <div className="mono" style={{ fontSize: 12 }}>
                              <span className="dim">{new Date(l.at).toLocaleTimeString()}</span> {l.msg}
                            </div>
                            {l.quotes && (
                              <table className="grid" style={{ maxWidth: 820, marginTop: 6 }}>
                                <thead>
                                  <tr>
                                    <th>Supplier</th>
                                    <th className="num">Quote</th>
                                    <th>Can fill</th>
                                    <th className="num">Lead</th>
                                    <th className="num">Failure rate</th>
                                    <th className="num">Expected delay</th>
                                    <th className="num">Effective cost</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {l.quotes.map((qt, qi) => (
                                    <tr key={qt.supplier}>
                                      <td>
                                        <span className="with-tag">
                                          {qt.supplier}
                                          {qi === 0 && <span className="tag covered">chosen</span>}
                                        </span>
                                      </td>
                                      <td className="num">{usd(qt.unitPrice)}</td>
                                      <td>{qt.canFill ? "yes" : "no, +14 days"}</td>
                                      <td className="num">{qt.leadDays} days</td>
                                      <td className="num">{(qt.failureRate * 100).toFixed(1)}%</td>
                                      <td className="num">{qt.expectedDelay} days</td>
                                      <td className="num">{usd(qt.effective)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                            {l.errors?.length ? <div className="ink-watch mono" style={{ fontSize: 11 }}>{l.errors.join("; ")}</div> : null}
                          </div>
                        ))}
                        {r.last_error && <div className="ink-short mono" style={{ fontSize: 12 }}>Last error: {r.last_error}</div>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {loaded && !rows.length && (
          <div className="empty">
            No supply orders yet. Select orders on the Orders page and press Order all selected, order a recommendation on the Models
            page, or ask the assistant to draft one.
          </div>
        )}
      </div>
    </section>
  );
}
