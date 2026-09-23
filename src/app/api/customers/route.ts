import { q } from "@/lib/db";

// GET /api/customers: the order form's customer list.
export async function GET() {
  const rows = await q(`SELECT id, name, state, segment FROM customers ORDER BY name`);
  return Response.json({ customers: rows });
}
