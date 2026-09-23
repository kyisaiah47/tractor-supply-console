// Supply order worker. Claims queued jobs from Postgres (FOR UPDATE SKIP LOCKED, so several
// workers can run at once), asks every supplier that makes the part for a quote over HTTP,
// picks the lowest cost after the failure and delay models' adjustments, places the order,
// and records every step in the job's log. Failures retry with exponential backoff.
import "./_env";
import os from "node:os";
import { pool, q, one } from "../src/lib/db";
import { APP_URL, AS_OF } from "../src/lib/config";
import { latestRuns } from "../src/lib/models";
import { supplierSlugsForSku, type Quote } from "../src/lib/mockSuppliers";
import { dayLabel } from "../src/lib/dates";

const WORKER = `${os.hostname()}:${process.pid}`;
const MAX_ATTEMPTS = 5;
const POLL_MS = 1500;
const DELAY_COST_PER_DAY = 0.001;
let processed = 0;
let stopping = false;

type Job = { id: number; supply_order_id: number; attempts: number };
type Log = { at: string; msg: string; [k: string]: unknown };

async function claim(): Promise<Job | null> {
  return one<Job>(
    `UPDATE supply_jobs SET status='running', attempts=attempts+1, updated_at=now()
      WHERE id = (SELECT id FROM supply_jobs WHERE status='pending' AND run_after <= now()
                   ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, supply_order_id, attempts`,
  );
}

async function appendLog(jobId: number, entry: Omit<Log, "at">) {
  await q(`UPDATE supply_jobs SET log = log || $2::jsonb, updated_at=now() WHERE id=$1`, [
    jobId,
    JSON.stringify([{ at: new Date().toISOString(), ...entry }]),
  ]);
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${(body as { error?: string }).error ?? res.statusText}`);
  return body as T;
}

async function processJob(job: Job) {
  const so = await one<{ sku: string; quantity: number; warehouse: string; note: string | null }>(
    `SELECT sku, quantity, warehouse, note FROM supply_orders WHERE id=$1`,
    [job.supply_order_id],
  );
  if (!so) throw new Error(`supply order ${job.supply_order_id} is missing`);
  const runs = await latestRuns();
  const quarter = Math.floor((Number(AS_OF.slice(5, 7)) - 1) / 3);
  const delay = new Map((runs?.supplier_delay.output.suppliers ?? []).map((s) => [s.supplier, s.byQuarter[quarter]]));
  const fail = new Map((runs?.component_failure.output.rows ?? []).map((r) => [`${r.sku}|${r.supplier}`, r.rate]));

  const slugs = await supplierSlugsForSku(so.sku);
  const settled = await Promise.allSettled(
    slugs.map((s) => http<Quote>(`${APP_URL}/api/mock-suppliers/${s}/quote?sku=${so.sku}&qty=${so.quantity}&attempt=${job.attempts}`)),
  );
  const quotes = settled.flatMap((r, i) => (r.status === "fulfilled" ? [{ slug: slugs[i], ...r.value }] : []));
  const errors = settled.flatMap((r, i) => (r.status === "rejected" ? [`${slugs[i]}: ${(r.reason as Error).message}`] : []));
  if (!quotes.length) throw new Error(`no supplier answered: ${errors.join("; ")}`);

  const scored = quotes
    .map((qt) => {
      const fr = fail.get(`${so.sku}|${qt.supplier}`) ?? 0.05;
      const d = delay.get(qt.supplier) ?? 14;
      const effective = (qt.unitPrice / (1 - fr)) * (1 + DELAY_COST_PER_DAY * (d + (qt.canFill ? 0 : 14)));
      return { ...qt, failureRate: fr, expectedDelay: d, effective: Math.round(effective * 100) / 100 };
    })
    .sort((a, b) => a.effective - b.effective);
  const best = scored[0];
  await appendLog(job.id, {
    msg: `${quotes.length} of ${slugs.length} suppliers quoted. ${best.supplier} has the lowest cost after expected failures and delay.`,
    quotes: scored.map((s) => ({ supplier: s.supplier, unitPrice: s.unitPrice, canFill: s.canFill, leadDays: s.leadDays, failureRate: s.failureRate, expectedDelay: s.expectedDelay, effective: s.effective })),
    errors,
  });

  const placed = await http<{ externalRef: string; promisedDate: string; unitPrice: number }>(
    `${APP_URL}/api/mock-suppliers/${best.slug}/orders`,
    { method: "POST", body: JSON.stringify({ sku: so.sku, quantity: so.quantity }) },
  );
  await q(
    `UPDATE supply_orders SET supplier=$2, unit_price=$3, promised_date=$4, external_ref=$5, status='placed' WHERE id=$1`,
    [job.supply_order_id, best.supplier, placed.unitPrice, placed.promisedDate, placed.externalRef],
  );
  await q(`UPDATE supply_jobs SET status='done', last_error=NULL, updated_at=now() WHERE id=$1`, [job.id]);
  await appendLog(job.id, { msg: `Placed with ${best.supplier}, reference ${placed.externalRef}, promised ${dayLabel(placed.promisedDate)}.` });
}

async function fail(job: Job, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (job.attempts >= MAX_ATTEMPTS) {
    await q(`UPDATE supply_jobs SET status='failed', last_error=$2, updated_at=now() WHERE id=$1`, [job.id, message]);
    await q(`UPDATE supply_orders SET status='failed' WHERE id=$1`, [job.supply_order_id]);
    await appendLog(job.id, { msg: `Could not place the order after ${job.attempts} tries: ${message}` });
  } else {
    const backoff = 2 ** job.attempts;
    await q(
      `UPDATE supply_jobs SET status='pending', last_error=$2, run_after=now() + ($3 || ' seconds')::interval, updated_at=now() WHERE id=$1`,
      [job.id, message, String(backoff)],
    );
    await appendLog(job.id, { msg: `Try ${job.attempts} failed (${message}). Trying again in ${backoff} seconds.` });
  }
}

async function heartbeat() {
  await q(
    `INSERT INTO worker_heartbeats (worker, seen_at, processed) VALUES ($1, now(), $2)
     ON CONFLICT (worker) DO UPDATE SET seen_at = now(), processed = $2`,
    [WORKER, processed],
  );
}

async function loop() {
  console.log(`[worker] ${WORKER} polling supply_jobs every ${POLL_MS}ms, suppliers at ${APP_URL}`);
  while (!stopping) {
    try {
      await heartbeat();
      let job: Job | null;
      while (!stopping && (job = await claim())) {
        try {
          await processJob(job);
          processed++;
          console.log(`[worker] job ${job.id} done (supply order ${job.supply_order_id})`);
        } catch (e) {
          await fail(job, e);
          console.log(`[worker] job ${job.id} attempt ${job.attempts} failed: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      console.error("[worker] poll error", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await q(`DELETE FROM worker_heartbeats WHERE worker=$1`, [WORKER]).catch(() => {});
  await pool.end();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));
loop();
