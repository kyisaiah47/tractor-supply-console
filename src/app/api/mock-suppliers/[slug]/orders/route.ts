import { z } from "zod";
import { placeOrder, SupplierUnavailable } from "@/lib/mockSuppliers";

const Body = z.object({ sku: z.string(), quantity: z.number().int().positive() });

// POST /api/mock-suppliers/:slug/orders : place an order with a supplier.
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
  try {
    const r = await placeOrder(slug, parsed.data.sku, parsed.data.quantity);
    if (!r) return Response.json({ error: `Supplier ${slug} does not make ${parsed.data.sku}` }, { status: 404 });
    return Response.json(r, { status: 201 });
  } catch (e) {
    if (e instanceof SupplierUnavailable) return Response.json({ error: e.message }, { status: 503 });
    throw e;
  }
}
