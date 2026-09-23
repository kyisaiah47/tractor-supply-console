import { z } from "zod";
import { q, one } from "@/lib/db";
import { AS_OF } from "@/lib/config";
import { MODEL_CODES, WAREHOUSE_CODES } from "@/lib/catalog";
import { listOrders } from "@/lib/queries";

// GET /api/orders: the customer order API. Powers both dashboard tabs.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const tab = u.searchParams.get("tab") === "backlog" ? "backlog" : "pipeline";
  const Query = z.object({
    months: z.coerce.number().int().min(1).max(12).default(tab === "pipeline" ? 3 : 12),
    model: z.enum(MODEL_CODES as [string, ...string[]]).optional(),
    warehouse: z.enum(WAREHOUSE_CODES as [string, ...string[]]).optional(),
    parts: z.enum(["covered", "short"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    offset: z.coerce.number().int().min(0).default(0),
  });
  const parsed = Query.safeParse(Object.fromEntries([...u.searchParams.entries()].filter(([, v]) => v !== "")));
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
  return Response.json(await listOrders({ tab, ...parsed.data }));
}

const NewOrder = z.object({
  customerId: z.number().int().positive(),
  tractorModel: z.enum(MODEL_CODES as [string, ...string[]]),
  quantity: z.number().int().min(1).max(50),
  warehouse: z.enum(WAREHOUSE_CODES as [string, ...string[]]).optional(),
  requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// POST /api/orders: the order form. Writes one customer order.
export async function POST(req: Request) {
  const parsed = NewOrder.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
  const o = parsed.data;
  if (o.requestedDate <= AS_OF) {
    return Response.json({ error: `requestedDate must be after the app's clock, ${AS_OF}` }, { status: 400 });
  }
  const c = await one<{ state: string }>(`SELECT state FROM customers WHERE id=$1`, [o.customerId]);
  if (!c) return Response.json({ error: `No customer ${o.customerId}` }, { status: 404 });
  const [row] = await q<{ id: number }>(
    `INSERT INTO customer_orders (customer_id, tractor_model, quantity, warehouse, ordered_at, requested_date, status)
     VALUES ($1,$2,$3,$4,$5,$6,'open') RETURNING id`,
    [o.customerId, o.tractorModel, o.quantity, o.warehouse ?? c.state, AS_OF, o.requestedDate],
  );
  return Response.json({ id: row.id, status: "open" }, { status: 201 });
}
