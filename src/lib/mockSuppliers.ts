// Stand-ins for the suppliers' own ordering APIs (the whiteboard's "Home Depot API").
// Each supplier answers a quote with price, stock and lead time, and accepts an order.
// Answers are deterministic per supplier, part and day, and about 1 call in 12 fails with a
// 503 so the worker's retry path is exercised.

import { q, one } from "./db";
import { AS_OF } from "./config";
import { addDays } from "./dates";
import { SUPPLIERS } from "./catalog";

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function supplierBySlug(slug: string) {
  return SUPPLIERS.find((s) => s.slug === slug.toLowerCase()) ?? null;
}

export type Quote = {
  supplier: string;
  sku: string;
  quantity: number;
  available: number;
  unitPrice: number;
  leadDays: number;
  promisedDate: string;
  canFill: boolean;
};

export class SupplierUnavailable extends Error {}

export async function quote(slug: string, sku: string, quantity: number, attemptSalt = ""): Promise<Quote | null> {
  const s = supplierBySlug(slug);
  if (!s) return null;
  if (hash(`${slug}|${sku}|${attemptSalt}|${Date.now() >> 12}`) < 0.08) throw new SupplierUnavailable(`${s.code} API returned 503`);
  const row = await one<{ unit_price: number; nominal_lead_days: number }>(
    `SELECT unit_price, nominal_lead_days FROM part_suppliers WHERE sku=$1 AND supplier=$2`,
    [sku, s.code],
  );
  if (!row) return null;
  const r = hash(`${slug}|${sku}|stock`);
  const available = Math.round(80 + r * 900);
  const leadDays = row.nominal_lead_days + (available >= quantity ? 0 : 14);
  return {
    supplier: s.code,
    sku,
    quantity,
    available,
    unitPrice: Math.round(row.unit_price * (0.97 + hash(`${slug}|${sku}|px`) * 0.06) * 100) / 100,
    leadDays,
    promisedDate: addDays(AS_OF, leadDays),
    canFill: available >= quantity,
  };
}

export async function placeOrder(slug: string, sku: string, quantity: number) {
  const qt = await quote(slug, sku, quantity, "order");
  if (!qt) return null;
  const ref = `${slug.toUpperCase()}-${Math.floor(hash(`${slug}|${sku}|${quantity}|${Date.now()}`) * 1e8)
    .toString()
    .padStart(8, "0")}`;
  return { ...qt, externalRef: ref, accepted: true };
}

export async function supplierSlugsForSku(sku: string) {
  const rows = await q<{ supplier: string }>(`SELECT supplier FROM part_suppliers WHERE sku=$1`, [sku]);
  return rows.map((r) => SUPPLIERS.find((s) => s.code === r.supplier)!.slug);
}
