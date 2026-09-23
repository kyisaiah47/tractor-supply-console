import { z } from "zod";
import { q } from "@/lib/db";
import { SupplyLine, SupplySource, createSupplyOrders, linesForCustomerOrders } from "@/lib/supply";

// GET /api/supply-orders: supply orders with their queue job, newest first.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const status = u.searchParams.get("status");
  const source = u.searchParams.get("source");
  const limit = Math.min(500, Number(u.searchParams.get("limit") ?? 100));
  const where: string[] = ["1=1"];
  const params: unknown[] = [];
  if (status) {
    params.push(status);
    where.push(`s.status = $${params.length}`);
  }
  if (source === "app") where.push(`s.source <> 'history'`);
  params.push(limit);
  const rows = await q(
    `SELECT s.id, s.sku, p.category, p.tractor_model, s.supplier, s.warehouse, s.quantity, s.unit_price,
            s.date_ordered, s.promised_date, s.fulfilled_date, s.status, s.source, s.external_ref, s.note,
            j.id AS job_id, j.status AS job_status, j.attempts, j.last_error, j.log, j.updated_at
       FROM supply_orders s JOIN parts p USING (sku)
       LEFT JOIN supply_jobs j ON j.supply_order_id = s.id
      WHERE ${where.join(" AND ")}
      ORDER BY s.id DESC LIMIT $${params.length}`,
    params,
  );
  return Response.json({ supplyOrders: rows });
}

const Body = z.union([
  z.object({ lines: z.array(SupplyLine).min(1).max(200), source: SupplySource.default("api") }),
  z.object({
    customerOrderIds: z.array(z.number().int()).min(1).max(500),
    dryRun: z.boolean().default(false),
  }),
]);

// POST /api/supply-orders: the place supply/parts order API.
//   { lines: [...] }                        queue these lines
//   { customerOrderIds: [...], dryRun }     cover those orders' part shortfalls ("Order all selected")
// Orders are written as 'queued' and a worker places them with a supplier asynchronously.
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
  const b = parsed.data;
  try {
    if ("customerOrderIds" in b) {
      const plan = await linesForCustomerOrders(b.customerOrderIds);
      if (b.dryRun) return Response.json({ dryRun: true, ...plan });
      const created = await createSupplyOrders(
        plan.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, warehouse: l.warehouse, supplier: l.supplier, note: l.note, customerOrderId: l.forOrders[0] })),
        "selected_orders",
      );
      return Response.json({ created, covered: plan.covered, requested: plan.requested }, { status: 201 });
    }
    const created = await createSupplyOrders(b.lines, b.source);
    return Response.json({ created }, { status: 201 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
