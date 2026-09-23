import { q } from "@/lib/db";

// GET /api/queue: worker status and the most recent supply jobs.
export async function GET() {
  const [workers, counts, jobs] = await Promise.all([
    q(`SELECT worker, seen_at, processed FROM worker_heartbeats ORDER BY seen_at DESC`),
    q(`SELECT status, COUNT(*)::int AS n FROM supply_jobs GROUP BY 1`),
    q(
      `SELECT j.id, j.supply_order_id, j.status, j.attempts, j.last_error, j.log, j.created_at, j.updated_at,
              s.sku, s.quantity, s.supplier, s.status AS order_status
         FROM supply_jobs j JOIN supply_orders s ON s.id = j.supply_order_id
        ORDER BY j.id DESC LIMIT 50`,
    ),
  ]);
  return Response.json({ workers, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), jobs });
}
