import { quote, SupplierUnavailable } from "@/lib/mockSuppliers";

// GET /api/mock-suppliers/:slug/quote?sku=&qty= : a supplier's price, stock and lead time.
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const u = new URL(req.url);
  const sku = u.searchParams.get("sku") ?? "";
  const qty = Number(u.searchParams.get("qty") ?? 0);
  if (!sku || !(qty > 0)) return Response.json({ error: "sku and qty are required" }, { status: 400 });
  try {
    const r = await quote(slug, sku, qty, u.searchParams.get("attempt") ?? "");
    if (!r) return Response.json({ error: `Supplier ${slug} does not make ${sku}` }, { status: 404 });
    return Response.json(r);
  } catch (e) {
    if (e instanceof SupplierUnavailable) return Response.json({ error: e.message }, { status: 503 });
    throw e;
  }
}
