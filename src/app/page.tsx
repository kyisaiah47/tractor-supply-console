import { api, apiOrNull } from "@/lib/api";
import type { Brief, OrdersData, Overview } from "@/lib/types";
import { OrdersConsole } from "@/components/OrdersConsole";
import { n0, stamp } from "@/lib/format";

export const dynamic = "force-dynamic";

function briefSections(body: string) {
  const heads = ["Demand", "Suppliers", "Failures", "Inventory"];
  const out: { head: string; text: string }[] = [];
  for (const para of body.split(/\n+/).filter((l) => l.trim())) {
    const m = para.match(/^\s*\**\s*(Demand|Suppliers|Failures|Inventory)\s*\**\s*:\s*\**\s*/i);
    if (m) out.push({ head: heads.find((h) => h.toLowerCase() === m[1].toLowerCase())!, text: para.slice(m[0].length).trim() });
    else if (out.length) out[out.length - 1].text += `\n${para.trim()}`;
  }
  return out.length ? out : [{ head: "Brief", text: body }];
}

export default async function Home() {
  const [o, brief, initial] = await Promise.all([
    api<Overview>("/api/overview"),
    apiOrNull<Brief>("/api/brief"),
    api<OrdersData>("/api/orders?tab=pipeline&months=3"),
  ]);

  return (
    <>
      <div className="folio" aria-label="Headline counts">
        <div>
          <b>{n0(o.backlogTractors)}</b> tractors booked in the next 12 months
        </div>
        <div>
          <b>{n0(o.forecast12)}</b> forecast
        </div>
        <div>
          <b>{n0(o.pipelineOrders)}</b> orders in the 0-3 month pipeline
        </div>
        <div>
          <b>{n0(o.supplyPlaced + o.supplyQueued)}</b> supply orders in flight
        </div>
        <div className={o.lateRisk ? "short" : ""}>
          <b>{n0(o.lateRisk)}</b> likely to land after the part runs out
        </div>
        <div className={o.partsToOrder ? "watch" : ""}>
          <b>{n0(o.partsToOrder)}</b> parts to reorder
        </div>
        <div className={o.elevatedFailures ? "watch" : ""}>
          <b>{n0(o.elevatedFailures)}</b> part and supplier pairs failing high
        </div>
      </div>

      {brief && (
        <details className="brief-toggle">
          <summary>
            <span className="label">Weekly brief</span>
            <span className="dim">
              updated {stamp(brief.generated_at)}
            </span>
          </summary>
          <div className="brief">
            {briefSections(brief.body).map((s) => (
              <div key={s.head}>
                <h3>{s.head}</h3>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
        </details>
      )}

      <OrdersConsole initial={initial} />
    </>
  );
}
