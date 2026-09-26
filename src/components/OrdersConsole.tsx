"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import NumberFlow from "@number-flow/react";
import { CaretRight, CaretDown, ShoppingCart, Warning, Package, X } from "@phosphor-icons/react";
import { Modal } from "./ui/Modal";
import type { OrdersData } from "@/lib/types";
import { STAGE_LABEL, dayShort, n0, usd } from "@/lib/format";
import { newIdempotencyKey } from "@/lib/idempotency";

type Data = OrdersData;
type Filters = { tab: "pipeline" | "backlog"; months: number; model?: string; warehouse?: string; parts?: "covered" | "short" };
type PlanLine = { sku: string; quantity: number; warehouse?: string; supplier?: string; unitPrice: number | null; note?: string; forOrders: number[] };
type Plan = { lines: PlanLine[]; covered: number; requested: number };

const MODELS = ["TX-100", "TX-200", "TX-300", "TX-400", "TX-500"];
const WAREHOUSES = ["CA", "FL", "IL", "NY", "TX"];

export function OrdersConsole({ initial }: { initial: Data }) {
  const [f, setF] = useState<Filters>({ tab: "pipeline", months: 3 });
  const [data, setData] = useState<Data>(initial);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const first = useRef(true);
  // One key per review: confirming twice, or retrying after an error, cannot queue the parts twice.
  const orderKey = useRef<string>("");
  const router = useRouter();

  const load = useCallback(async (next: Filters) => {
    setLoading(true);
    const p = new URLSearchParams({ tab: next.tab, months: String(next.months) });
    if (next.model) p.set("model", next.model);
    if (next.warehouse) p.set("warehouse", next.warehouse);
    if (next.parts) p.set("parts", next.parts);
    const res = await fetch(`/api/orders?${p}`);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    const onChange = () => load(f);
    window.addEventListener("orders-changed", onChange);
    return () => window.removeEventListener("orders-changed", onChange);
  }, [f, load]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    load(f);
  }, [f, load]);

  const set = (patch: Partial<Filters>) => {
    setSel(new Set());
    setF((cur) => ({ ...cur, ...patch }));
  };

  const shortParts = useMemo(() => {
    const m = new Map<string, { category: string; orders: number; units: number }>();
    for (const r of data.rows)
      for (const s of r.shortfalls) {
        const v = m.get(s.sku) ?? { category: s.category, orders: 0, units: 0 };
        v.orders++;
        v.units += s.short;
        m.set(s.sku, v);
      }
    return [...m.entries()].sort((a, b) => b[1].units - a[1].units);
  }, [data.rows]);

  const allSelected = data.rows.length > 0 && data.rows.every((r) => sel.has(r.id));
  const selectedShort = data.rows.filter((r) => sel.has(r.id) && r.parts === "short").length;

  async function previewOrder() {
    orderKey.current = newIdempotencyKey();
    setPlan(null);
    setReviewOpen(true);
    setPlanning(true);
    const res = await fetch("/api/supply-orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerOrderIds: [...sel], dryRun: true }),
    });
    setPlanning(false);
    if (res.ok) setPlan(await res.json());
  }

  async function placeOrder() {
    setPlacing(true);
    const res = await fetch("/api/supply-orders", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": orderKey.current },
      body: JSON.stringify({ customerOrderIds: [...sel], dryRun: false }),
    });
    const body = await res.json();
    setPlacing(false);
    setReviewOpen(false);
    setPlan(null);
    if (!res.ok) {
      setToast(`Nothing was queued: ${JSON.stringify(body.error)}`);
      return;
    }
    setToast(
      body.created.length
        ? `Queued ${body.created.length} supply order${body.created.length === 1 ? "" : "s"} for ${sel.size} customer orders. Suppliers are quoting them now.`
        : `All parts for the ${sel.size} selected orders are already covered. Nothing was ordered.`,
    );
    setSel(new Set());
    load(f);
    router.refresh();
  }

  const monthOptions = f.tab === "pipeline" ? [1, 2, 3] : [3, 6, 9, 12];

  return (
    <section aria-label="Customer orders">
      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="View">
          <button role="tab" aria-selected={f.tab === "pipeline"} onClick={() => set({ tab: "pipeline", months: 3 })}>
            Production pipeline
          </button>
          <button role="tab" aria-selected={f.tab === "backlog"} onClick={() => set({ tab: "backlog", months: 12 })}>
            12-month backlog
          </button>
        </div>
        <div className="chips" role="group" aria-label="Window">
          {monthOptions.map((m) => (
            <button key={m} className="chip" aria-pressed={f.months === m} onClick={() => set({ months: m })}>
              {m} mo
            </button>
          ))}
        </div>
        <div className="chips" role="group" aria-label="Parts status">
          <button className="chip" aria-pressed={f.parts === "covered"} onClick={() => set({ parts: f.parts === "covered" ? undefined : "covered" })}>
            Covered
            <span className="n">{data.facets.parts.covered?.orders ?? 0}</span>
          </button>
          <button className="chip" aria-pressed={f.parts === "short"} onClick={() => set({ parts: f.parts === "short" ? undefined : "short" })}>
            Short
            <span className="n">{data.facets.parts.short?.orders ?? 0}</span>
          </button>
        </div>
        <div className="toolbar-right">
          {sel.size > 0 && (
            <span className="dim" style={{ fontSize: 13 }}>
              <b className="mono" style={{ color: "var(--ink)" }}>{sel.size}</b> selected, {selectedShort} short
              <button className="btn ghost small" onClick={() => setSel(new Set())} style={{ marginLeft: 4 }}>
                Clear
              </button>
            </span>
          )}
          <button className="btn primary" disabled={!sel.size || planning} onClick={previewOrder} title="Order the parts the selected orders are short of">
            <ShoppingCart size={16} />
            {planning ? "Planning" : "Order all selected"}
          </button>
        </div>
      </div>
      <div className="toolbar sub">
        <div className="chips" role="group" aria-label="Tractor model">
          <button className="chip" aria-pressed={!f.model} onClick={() => set({ model: undefined })}>
            All models
          </button>
          {MODELS.map((m) => (
            <button key={m} className="chip" aria-pressed={f.model === m} onClick={() => set({ model: f.model === m ? undefined : m })}>
              {m}
              <span className="n">{data.facets.model[m]?.tractors ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="chips" role="group" aria-label="Warehouse">
          <button className="chip" aria-pressed={!f.warehouse} onClick={() => set({ warehouse: undefined })}>
            All warehouses
          </button>
          {WAREHOUSES.map((w) => (
            <button key={w} className="chip" aria-pressed={f.warehouse === w} onClick={() => set({ warehouse: f.warehouse === w ? undefined : w })}>
              {w}
              <span className="n">{data.facets.warehouse[w]?.orders ?? 0}</span>
            </button>
          ))}
        </div>
        <span className="toolbar-right mono dim" style={{ fontSize: 12 }}>
          {loading ? "Loading" : `${n0(data.totals.orders)} orders, ${n0(data.totals.tractors)} tractors, through ${dayShort(data.through)} ${data.through.slice(0, 4)}`}
        </span>
      </div>

      <div className="frame">
        <aside className="rail" aria-label="Short parts in this view">
          <h4>In this view</h4>
          <ul className="rail-list">
            <li>
              Orders
              <span className="v">
                <NumberFlow value={data.totals.orders} />
              </span>
            </li>
            <li>
              Tractors
              <span className="v">
                <NumberFlow value={data.totals.tractors} />
              </span>
            </li>
            <li>
              Short of parts
              <span className={`v ${data.totals.short ? "short" : ""}`}>
                <NumberFlow value={data.totals.short} />
              </span>
            </li>
          </ul>
          <h4>Parts short</h4>
          {shortParts.length ? (
            <ul className="rail-list">
              {shortParts.slice(0, 18).map(([sku, v]) => (
                <li key={sku} title={`${v.category}: ${v.units} units short across ${v.orders} orders`}>
                  <Package size={14} />
                  <span className="mono" style={{ fontSize: 12 }}>
                    {sku}
                  </span>
                  <span className="v short">{n0(v.units)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rail-note">Every order in this view is covered by stock on hand and inbound supply.</p>
          )}
          <p className="rail-note">
            Parts are allocated to orders in the order their builds start, from stock on hand plus supply orders expected to arrive by then.
          </p>
        </aside>

        <div className="track">
          <div className="grid-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th className="check">
                    <input
                      type="checkbox"
                      aria-label="Select all rows"
                      checked={allSelected}
                      onChange={() => setSel(allSelected ? new Set() : new Set(data.rows.map((r) => r.id)))}
                    />
                  </th>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Model</th>
                  <th className="num">Qty</th>
                  <th>WH</th>
                  <th>Requested</th>
                  <th>{f.tab === "pipeline" ? "Stage" : "Status"}</th>
                  <th>Build starts</th>
                  <th>Parts</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => {
                  const isOpen = open.has(r.id);
                  return (
                    <Fragment key={r.id}>
                      <tr className={sel.has(r.id) ? "sel" : ""}>
                        <td className="check">
                          <input
                            type="checkbox"
                            aria-label={`Select order ${r.id}`}
                            checked={sel.has(r.id)}
                            onChange={() =>
                              setSel((s) => {
                                const n = new Set(s);
                                if (n.has(r.id)) n.delete(r.id);
                                else n.add(r.id);
                                return n;
                              })
                            }
                          />
                        </td>
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
                        <td>{r.customer}</td>
                        <td className="code">{r.tractorModel}</td>
                        <td className="num">{r.quantity}</td>
                        <td className="code">{r.warehouse}</td>
                        <td className="code">{dayShort(r.requestedDate)}</td>
                        <td>{r.stage ? STAGE_LABEL[r.stage] : r.status === "in_production" ? "In production" : "Open"}</td>
                        <td className="code">{dayShort(r.needDate)}</td>
                        <td>
                          {r.parts === "covered" ? (
                            <span className="tag covered">covered</span>
                          ) : (
                            <span className="tag short" title={r.shortfalls.map((s) => `${s.sku} short ${s.short}`).join(", ")}>
                              short {r.shortfalls.length}
                            </span>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="open-row">
                          <td colSpan={10}>
                            <div style={{ display: "flex", gap: 32, flexWrap: "wrap", fontSize: 13 }}>
                              <div>
                                <div className="label">Ordered</div>
                                <div className="mono">{r.orderedAt}</div>
                              </div>
                              <div>
                                <div className="label">Promised</div>
                                <div className="mono">{r.promisedDate ?? "not yet"}</div>
                              </div>
                              <div>
                                <div className="label">Parts needed by</div>
                                <div className="mono">{r.needDate}</div>
                              </div>
                              <div style={{ minWidth: 280 }}>
                                <div className="label">Parts</div>
                                {r.shortfalls.length ? (
                                  <div>
                                    {r.shortfalls.map((s) => (
                                      <div key={s.sku}>
                                        <Warning size={12} className="ink-short" /> <span className="mono">{s.sku}</span> {s.category}, short{" "}
                                        <span className="mono">{s.short}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="ink-covered">All 10 parts allocated from stock and inbound supply.</div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {!data.rows.length && <div className="empty">No orders match these filters.</div>}
            {data.totals.orders > data.rows.length && (
              <div className="empty" style={{ padding: 16 }}>
                Showing the first {data.rows.length} of {n0(data.totals.orders)} orders. Narrow the view to see the rest.
              </div>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={reviewOpen}
        onOpenChange={(v) => {
          setReviewOpen(v);
          if (!v) setPlan(null);
        }}
        width={820}
        title="Review supply order"
        description={
          planning || !plan
            ? `Checking which parts the ${sel.size} selected orders are short of.`
            : plan.lines.length
              ? `${plan.requested - plan.covered} of the ${plan.requested} selected orders are short of parts. These supply orders cover the shortfall and the parts expected to fail. Each one goes out for quotes to every supplier that makes the part, and is placed with the lowest cost after expected failures and delays.`
              : `All ${plan.requested} selected orders are covered by stock on hand and supply already on the way. Nothing needs ordering.`
        }
        footer={
          <>
            {plan && plan.lines.length > 0 && (
              <span className="mono" style={{ marginRight: "auto", alignSelf: "center", fontSize: 12 }}>
                {plan.lines.length} supply orders, estimated {usd(plan.lines.reduce((a, l) => a + (l.unitPrice ?? 0) * l.quantity, 0))}
              </span>
            )}
            <button className="btn" onClick={() => setReviewOpen(false)}>
              {plan && !plan.lines.length ? "Close" : "Cancel"}
            </button>
            {plan && plan.lines.length > 0 && (
              <button className="btn primary" onClick={placeOrder} disabled={placing}>
                <ShoppingCart size={16} />
                {placing ? "Ordering" : "Confirm order"}
              </button>
            )}
          </>
        }
      >
        {planning || !plan ? (
          <div className="empty">Loading</div>
        ) : plan.lines.length > 0 ? (
          <table className="grid">
            <thead>
              <tr>
                <th>Part</th>
                <th className="num">Qty</th>
                <th>Warehouse</th>
                <th>Likely supplier</th>
                <th className="num">Unit price</th>
                <th className="num">Est. cost</th>
                <th>For orders</th>
              </tr>
            </thead>
            <tbody>
              {plan.lines.map((l) => (
                <tr key={`${l.sku}-${l.warehouse}`}>
                  <td className="code">{l.sku}</td>
                  <td className="num">{l.quantity}</td>
                  <td className="code">{l.warehouse}</td>
                  <td>{l.supplier ?? "-"}</td>
                  <td className="num">{l.unitPrice ? usd(l.unitPrice) : "-"}</td>
                  <td className="num">{l.unitPrice ? usd(l.unitPrice * l.quantity) : "-"}</td>
                  <td className="code">{l.forOrders.map((o) => `#${o}`).join(" ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Modal>

      {toast && (
        <div className="toast" role="status">
          <span>
            {toast} <a href="/supply">See supply orders</a>
          </span>
          <button className="btn ghost small" onClick={() => setToast(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}
    </section>
  );
}
