"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChatCircleText, Minus, PaperPlaneRight, CheckCircle, WarningCircle, ArrowCounterClockwise, CircleNotch } from "@phosphor-icons/react";
import { Markdown } from "./Markdown";
import { usd } from "@/lib/format";

type Proposal = {
  proposal: true;
  reason: string;
  lines: { sku: string; quantity: number; warehouse: string; supplier?: string; estUnitPrice: number; estCost: number; note?: string }[];
  estTotal: number;
};
type Part =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; ok?: boolean; result?: unknown }
  | { kind: "proposal"; id: string; data: Proposal; state: "open" | "placing" | "placed" | "dismissed"; created?: number };
type Msg = { role: "user" | "assistant"; parts: Part[]; error?: string };

const SUGGESTIONS = [
  "Which open supply orders will arrive after their part runs out?",
  "What should we order this week, and from which supplier?",
  "Which parts are failing more than expected, and from which supplier?",
  "How much of the next three months is already booked, by model?",
];

const TOOL_LABEL: Record<string, string> = {
  get_overview: "Read the headline numbers",
  list_customer_orders: "Looked up customer orders",
  get_demand_forecast: "Checked the demand forecast",
  get_supplier_delays: "Checked supplier delays",
  get_component_failures: "Checked component failures",
  get_inventory_recommendations: "Checked reorder recommendations",
  query_market_signals: "Looked up market data",
  get_weekly_brief: "Read the weekly brief",
  propose_supply_order: "Drafted a supply order",
};

const textOf = (m: Msg) => m.parts.filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text").map((p) => p.text).join("");

export function ChatDock(props: { minimized: boolean; onToggle: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [msgs]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setInput("");
    const history = [...msgs, { role: "user" as const, parts: [{ kind: "text" as const, text: q }] }];
    setMsgs([...history, { role: "assistant", parts: [] }]);
    setBusy(true);
    const update = (fn: (m: Msg) => Msg) =>
      setMsgs((all) => {
        const copy = [...all];
        copy[copy.length - 1] = fn(copy[copy.length - 1]);
        return copy;
      });
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.map((m) => ({ role: m.role, content: textOf(m) })).filter((m) => m.content) }),
      });
      if (!res.ok || !res.body) throw new Error(`Chat API returned ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "text") {
            update((m) => {
              const parts = [...m.parts];
              const last = parts[parts.length - 1];
              if (last?.kind === "text") parts[parts.length - 1] = { ...last, text: last.text + ev.text };
              else parts.push({ kind: "text", text: ev.text });
              return { ...m, parts };
            });
          } else if (ev.type === "tool_call") {
            update((m) => ({ ...m, parts: [...m.parts, { kind: "tool", id: ev.id, name: ev.name, input: ev.input }] }));
          } else if (ev.type === "tool_result") {
            update((m) => {
              const parts: Part[] = m.parts.map((p) => (p.kind === "tool" && p.id === ev.id ? { ...p, ok: ev.ok, result: ev.result } : p));
              if (ev.name === "propose_supply_order" && ev.ok && (ev.result as Proposal)?.proposal) {
                parts.push({ kind: "proposal", id: ev.id, data: ev.result as Proposal, state: "open" });
              }
              return { ...m, parts };
            });
          } else if (ev.type === "error") {
            update((m) => ({ ...m, error: ev.message }));
          }
        }
      }
    } catch (e) {
      update((m) => ({ ...m, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(msgIndex: number, id: string, data: Proposal) {
    const set = (state: "placing" | "placed" | "open", created?: number) =>
      setMsgs((all) =>
        all.map((m, i) =>
          i !== msgIndex ? m : { ...m, parts: m.parts.map((p) => (p.kind === "proposal" && p.id === id ? { ...p, state, created } : p)) },
        ),
      );
    set("placing");
    const res = await fetch("/api/supply-orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "chatbot",
        lines: data.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, warehouse: l.warehouse, supplier: l.supplier, note: l.note ?? data.reason })),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      set("open");
      alert("The order could not be placed. Try again.");
      return;
    }
    set("placed", body.created?.length ?? 0);
    router.refresh();
  }

  function dismiss(msgIndex: number, id: string) {
    setMsgs((all) =>
      all.map((m, i) => (i !== msgIndex ? m : { ...m, parts: m.parts.map((p) => (p.kind === "proposal" && p.id === id ? { ...p, state: "dismissed" } : p)) })),
    );
  }

  if (props.minimized) {
    return (
      <aside className="dock" aria-label="Planning assistant, minimized">
        <button className="dock-rail" onClick={props.onToggle} aria-label="Open the planning assistant">
          <ChatCircleText size={18} />
          Planning assistant
        </button>
      </aside>
    );
  }

  return (
    <aside className="dock" aria-label="Planning assistant">
      <div className="dock-head">
        <ChatCircleText size={18} />
        <span className="title">Planning assistant</span>
        {msgs.length > 0 && (
          <button className="btn ghost small" onClick={() => setMsgs([])} disabled={busy} aria-label="Start a new conversation" style={{ marginLeft: "auto" }}>
            <ArrowCounterClockwise size={14} />
          </button>
        )}
        <button className="btn ghost small" onClick={props.onToggle} aria-label="Minimize the planning assistant" style={msgs.length ? { marginLeft: 0 } : undefined}>
          <Minus size={14} />
        </button>
      </div>
      <div className="msgs" ref={scroller}>
        {msgs.length === 0 && (
          <>
            <div className="msg assistant">
              <p>
                I work from the same forecasts and orders as the console. I can explain a forecast, find late supply orders, compare suppliers, and draft supply orders for you to confirm.
              </p>
            </div>
            <div className="suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
        {msgs.map((m, mi) =>
          m.role === "user" ? (
            <div key={mi} className="msg user">
              {textOf(m)}
            </div>
          ) : (
            <div key={mi} className="msg assistant" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {m.parts.map((p, pi) =>
                p.kind === "text" ? (
                  <div key={pi}>
                    <Markdown text={p.text} />
                  </div>
                ) : p.kind === "tool" ? (
                  <div key={pi} className="toolcall">
                    {p.ok === undefined ? <CircleNotch size={12} className="spin" /> : p.ok ? <CheckCircle size={12} className="ink-covered" /> : <WarningCircle size={12} className="ink-short" />}
                    {TOOL_LABEL[p.name] ?? p.name}
                  </div>
                ) : (
                  <div key={pi} className="proposal">
                    <div className="p-head">
                      <b>Draft supply order.</b> {p.data.reason}
                    </div>
                    <div className="md-table" style={{ margin: 0, border: 0, borderRadius: 0 }}>
                      <table>
                        <thead>
                          <tr>
                            <th>Part</th>
                            <th>Qty</th>
                            <th>WH</th>
                            <th>Supplier</th>
                            <th>Est. cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.data.lines.map((l, li) => (
                            <tr key={li}>
                              <td className="mono">{l.sku}</td>
                              <td className="mono">{l.quantity}</td>
                              <td className="mono">{l.warehouse}</td>
                              <td>{l.supplier ?? "Best quote"}</td>
                              <td className="mono">{usd(l.estCost)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="p-foot">
                      {p.state === "placed" ? (
                        <span className="ink-covered">
                          Ordered {p.created} part{p.created === 1 ? "" : "s"}. Suppliers are quoting now.{" "}
                          <a href="/supply" style={{ color: "var(--accent)" }}>
                            See supply orders
                          </a>
                        </span>
                      ) : p.state === "dismissed" ? (
                        <span className="dim">Dismissed. Nothing was ordered.</span>
                      ) : (
                        <>
                          <span className="mono" style={{ fontSize: 12 }}>
                            Total {usd(p.data.estTotal)}
                          </span>
                          <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                            <button className="btn small" onClick={() => dismiss(mi, p.id)} disabled={p.state === "placing"}>
                              Dismiss
                            </button>
                            <button className="btn primary small" onClick={() => confirm(mi, p.id, p.data)} disabled={p.state === "placing"}>
                              {p.state === "placing" ? "Ordering" : "Confirm order"}
                            </button>
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                ),
              )}
              {busy && mi === msgs.length - 1 && !m.parts.some((p) => p.kind === "text") && (
                <span className="typing" aria-label="Thinking">
                  <i />
                  <i />
                  <i />
                </span>
              )}
              {m.error && <p className="ink-short">Error: {m.error}</p>}
            </div>
          ),
        )}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          value={input}
          rows={2}
          placeholder="Ask about demand, suppliers, failures or what to order"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          aria-label="Message the planning assistant"
        />
        <button className="btn primary" type="submit" disabled={busy || !input.trim()} aria-label="Send">
          <PaperPlaneRight size={16} />
        </button>
      </form>
    </aside>
  );
}
