// The fixed catalog: tractor models, their bill of materials, suppliers and warehouses.
// Model codes, supplier codes and warehouse codes are the ones in data/market_signals.csv.

export const TRACTOR_MODELS = [
  { code: "TX-100", name: "Compact utility", horsepower: 25, listPrice: 28_000, buildDays: 5 },
  { code: "TX-200", name: "Utility", horsepower: 60, listPrice: 58_000, buildDays: 7 },
  { code: "TX-300", name: "Mid row-crop", horsepower: 130, listPrice: 145_000, buildDays: 10 },
  { code: "TX-400", name: "Row-crop", horsepower: 230, listPrice: 265_000, buildDays: 14 },
  { code: "TX-500", name: "Four-wheel drive", horsepower: 420, listPrice: 480_000, buildDays: 18 },
] as const;

export type TractorCode = (typeof TRACTOR_MODELS)[number]["code"];
export const MODEL_CODES = TRACTOR_MODELS.map((m) => m.code) as TractorCode[];

export const SUPPLIERS = [
  { code: "Supplier A", slug: "a", name: "Supplier A" },
  { code: "Supplier B", slug: "b", name: "Supplier B" },
  { code: "Supplier C", slug: "c", name: "Supplier C" },
  { code: "Supplier D", slug: "d", name: "Supplier D" },
  { code: "Supplier E", slug: "e", name: "Supplier E" },
] as const;
export const SUPPLIER_CODES = SUPPLIERS.map((s) => s.code) as string[];

export const WAREHOUSES = [
  { code: "CA", name: "Fresno, CA" },
  { code: "FL", name: "Lakeland, FL" },
  { code: "IL", name: "Peoria, IL" },
  { code: "NY", name: "Syracuse, NY" },
  { code: "TX", name: "Amarillo, TX" },
] as const;
export const WAREHOUSE_CODES = WAREHOUSES.map((w) => w.code) as string[];

// Ten part categories per tractor. costShare is the share of the list price the part costs;
// suppliers lists who can make it; leadDays is the nominal lead time a supplier quotes.
export const PART_CATEGORIES = [
  { key: "ENG", name: "Engine", costShare: 0.16, suppliers: ["Supplier A", "Supplier B", "Supplier D"], leadDays: 35 },
  { key: "TRN", name: "Transmission", costShare: 0.1, suppliers: ["Supplier B", "Supplier C", "Supplier E"], leadDays: 30 },
  { key: "HYD", name: "Hydraulic pump", costShare: 0.035, suppliers: ["Supplier C", "Supplier E", "Supplier A"], leadDays: 21 },
  { key: "FAX", name: "Front axle", costShare: 0.04, suppliers: ["Supplier D", "Supplier A"], leadDays: 25 },
  { key: "RAX", name: "Rear axle", costShare: 0.05, suppliers: ["Supplier D", "Supplier B"], leadDays: 25 },
  { key: "CAB", name: "Cab and ROPS", costShare: 0.07, suppliers: ["Supplier E", "Supplier C"], leadDays: 28 },
  { key: "ECU", name: "Engine control unit", costShare: 0.015, suppliers: ["Supplier A", "Supplier C", "Supplier E"], leadDays: 18 },
  { key: "TIR", name: "Tire set", costShare: 0.025, suppliers: ["Supplier B", "Supplier D"], leadDays: 14 },
  { key: "PTO", name: "PTO assembly", costShare: 0.02, suppliers: ["Supplier C", "Supplier D"], leadDays: 21 },
  { key: "FUE", name: "Fuel system", costShare: 0.012, suppliers: ["Supplier E", "Supplier A", "Supplier B"], leadDays: 16 },
] as const;

// Supplier price positioning relative to standard cost.
export const SUPPLIER_PRICE_FACTOR: Record<string, number> = {
  "Supplier A": 1.0,
  "Supplier B": 1.07,
  "Supplier C": 0.99,
  "Supplier D": 0.95,
  "Supplier E": 0.97,
};

export function skuFor(categoryKey: string, model: string) {
  return `${categoryKey}-${model.replace("TX-", "")}`;
}

export function buildParts() {
  const parts: {
    sku: string;
    tractorModel: string;
    category: string;
    name: string;
    qtyPerTractor: number;
    standardCost: number;
  }[] = [];
  const partSuppliers: { sku: string; supplier: string; unitPrice: number; nominalLeadDays: number }[] = [];
  for (const m of TRACTOR_MODELS) {
    for (const c of PART_CATEGORIES) {
      const sku = skuFor(c.key, m.code);
      const standardCost = Math.round(m.listPrice * c.costShare);
      parts.push({ sku, tractorModel: m.code, category: c.name, name: `${c.name}, ${m.code}`, qtyPerTractor: 1, standardCost });
      c.suppliers.forEach((s, i) => {
        partSuppliers.push({
          sku,
          supplier: s,
          unitPrice: Math.round(standardCost * SUPPLIER_PRICE_FACTOR[s] * 100) / 100,
          nominalLeadDays: c.leadDays + i * 3,
        });
      });
    }
  }
  return { parts, partSuppliers };
}
