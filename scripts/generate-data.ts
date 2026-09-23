// Generates the operational dataset from the provided market dataset.
//
//   input : data/market_signals.csv (10,000 rows, 2020-01-01 .. 2023-12-30, provided)
//   output: data/generated/*.csv   (customers, orders, pipeline, supply orders, lots, stock)
//           data/generated/meta.json (the planning date and the date shift)
//
// The app runs on today's date. Every dataset date is moved forward by the same number of
// days so the dataset's last row lands on yesterday; the CSV itself is never changed, and the
// seed keeps each row's original date beside the shifted one. Orders before today are history;
// orders after today are the open order book. Set APP_AS_OF=YYYY-MM-DD to pin a different day.
//
// The provided rows are market-level signals. This script turns them into the tables on the
// whiteboard. Our order book is 1% of market demand for each model and month, shaped by a
// farm-year seasonality and 6% annual growth. Supplier delays are sampled from the dataset's
// own Supplier_Delay_Days, and lot failure rates from its Component_Failure_Rate.
//
// A few effects are planted on purpose (PLANTED below). The dataset alone carries none: every
// supplier averages ~14.7 days late and every model fails ~5%. The model tests check that
// each planted effect is recovered, which is how we know the models can find real signal.
//
// Run: npm run data:generate   (deterministic: the same seed gives the same files)

import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import {
  TRACTOR_MODELS,
  PART_CATEGORIES,
  WAREHOUSE_CODES,
  buildParts,
  skuFor,
} from "../src/lib/catalog";
import { addDays, diffDays, monthRange, monthIndex, daysInMonth, addMonths, addMonthsDay, localToday } from "../src/lib/dates";
import { mulberry32, randInt, pick, normal, poisson, binomial, type Rng } from "../src/lib/prng";
import { PLANTED, MARKET_SHARE } from "../src/lib/planted";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "data", "generated");
const AS_OF = process.env.APP_AS_OF || localToday();
const rng: Rng = mulberry32(20240101);

type Signal = {
  Date: string;
  Tractor_Model: string;
  Demand_Units: string;
  Supplier: string;
  Supplier_Delay_Days: string;
  Component_Failure_Rate: string;
  Inventory_Levels: string;
  Warehouse_Location: string;
  Inflation_Rate: string;
  Market_Trend_Index: string;
};

const signals: Signal[] = parse(fs.readFileSync(path.join(ROOT, "data", "market_signals.csv")), {
  columns: true,
  skip_empty_lines: true,
});

// ---- the date shift --------------------------------------------------------------------------
const dates = signals.map((r) => r.Date).sort();
const DATASET_FIRST = dates[0];
const DATASET_LAST = dates[dates.length - 1];
const SHIFT_DAYS = diffDays(AS_OF, DATASET_LAST) - 1;
const shift = (d: string) => addDays(d, SHIFT_DAYS);
const SHIFTED_FIRST = shift(DATASET_FIRST);
const SHIFTED_LAST = shift(DATASET_LAST);
const CUR = AS_OF.slice(0, 7);
const START = addMonths(SHIFTED_FIRST.slice(0, 7), 1); // first full month of history
const LAST_FULL = addMonths(CUR, -1);
const END = addMonths(CUR, 11);

function coveredDays(ym: string) {
  const first = `${ym}-01`;
  const last = `${ym}-${String(daysInMonth(ym)).padStart(2, "0")}`;
  const lo = first > SHIFTED_FIRST ? first : SHIFTED_FIRST;
  const hi = last < SHIFTED_LAST ? last : SHIFTED_LAST;
  return lo > hi ? 0 : diffDays(hi, lo) + 1;
}

// ---- aggregate the provided dataset (on shifted dates) -------------------------------------
const marketDemand = new Map<string, number>(); // `${model}|${ym}` -> sum Demand_Units
const failureByModelMonth = new Map<string, number[]>();
const delaysBySupplierMonth = new Map<string, number[]>();
const delaysBySupplier = new Map<string, number[]>();
const latestInventory = new Map<string, { date: string; level: number }>(); // `${model}|${wh}`

for (const r of signals) {
  r.Date = shift(r.Date);
  const ym = r.Date.slice(0, 7);
  const k = `${r.Tractor_Model}|${ym}`;
  marketDemand.set(k, (marketDemand.get(k) ?? 0) + Number(r.Demand_Units));
  (failureByModelMonth.get(k) ?? failureByModelMonth.set(k, []).get(k)!).push(Number(r.Component_Failure_Rate));
  const sk = `${r.Supplier}|${ym}`;
  (delaysBySupplierMonth.get(sk) ?? delaysBySupplierMonth.set(sk, []).get(sk)!).push(Number(r.Supplier_Delay_Days));
  (delaysBySupplier.get(r.Supplier) ?? delaysBySupplier.set(r.Supplier, []).get(r.Supplier)!).push(
    Number(r.Supplier_Delay_Days),
  );
  const ik = `${r.Tractor_Model}|${r.Warehouse_Location}`;
  const prev = latestInventory.get(ik);
  if (!prev || r.Date > prev.date) latestInventory.set(ik, { date: r.Date, level: Number(r.Inventory_Levels) });
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Market demand per model per month, as a full-month rate so partial months at either end count.
function marketRate(model: string, ym: string) {
  const days = coveredDays(ym);
  return days ? ((marketDemand.get(`${model}|${ym}`) ?? 0) / days) * daysInMonth(ym) : 0;
}
const trailingRate: Record<string, number> = {};
for (const m of TRACTOR_MODELS) {
  trailingRate[m.code] = mean(monthRange(addMonths(LAST_FULL, -11), LAST_FULL).map((ym) => marketRate(m.code, ym)));
}

function sampleDelay(supplier: string, ym: string) {
  const pool = delaysBySupplierMonth.get(`${supplier}|${ym}`) ?? delaysBySupplier.get(supplier)!;
  let d = pool[Math.floor(rng() * pool.length)];
  const mult = PLANTED.supplierDelay[supplier];
  if (mult) d *= typeof mult === "number" ? mult : monthIndex(ym) >= 9 ? mult.q4 : 1;
  return Math.max(0, Math.round(d));
}

function failureRate(model: string, category: string, supplier: string, ym: string) {
  const pool = failureByModelMonth.get(`${model}|${ym}`);
  let p = pool ? mean(pool) : 0.05;
  for (const f of PLANTED.failure) {
    if (f.category === category && (!f.supplier || f.supplier === supplier) && (!f.model || f.model === model)) {
      p *= f.multiplier;
    }
  }
  return Math.min(p, 0.6);
}

function growth(ym: string) {
  const [y0, m0] = START.split("-").map(Number);
  const [y1, m1] = ym.split("-").map(Number);
  const years = y1 - y0 + (m1 - m0) / 12;
  return Math.pow(1 + PLANTED.growthPerYear, years);
}

// ---- customers -----------------------------------------------------------------------------
const PREFIX = [
  "Prairie", "Riverbend", "Heartland", "Golden Valley", "Cedar Creek", "Big Sky", "Red River", "Lone Star",
  "Sunbelt", "Great Lakes", "Harvest Moon", "Blue Ridge", "Delta", "Pioneer", "Frontier", "Summit",
  "Clearwater", "Oak Hollow", "Twin Rivers", "Maple Ridge", "Sandhill", "Mesa", "Bayou", "Finger Lakes",
  "Central Valley", "High Plains", "Gulf Coast", "Hudson Valley", "Sierra", "Palmetto", "Cotton Belt", "Wabash",
];
const SUFFIX = ["Implement", "Equipment", "Ag Supply", "Tractor", "Farm Machinery", "Ag Partners"];
const ENDING = ["Co.", "LLC", "Inc.", "Group"];
const SEGMENTS = ["dealer", "dealer", "dealer", "fleet", "co-op"] as const;

const customers: { id: number; name: string; state: string; segment: string; since: string; weight: number }[] = [];
const usedNames = new Set<string>();
while (customers.length < 64) {
  const name = `${pick(rng, PREFIX)} ${pick(rng, SUFFIX)} ${pick(rng, ENDING)}`;
  if (usedNames.has(name)) continue;
  usedNames.add(name);
  customers.push({
    id: customers.length + 1,
    name,
    state: pick(rng, WAREHOUSE_CODES),
    segment: pick(rng, SEGMENTS),
    since: addDays("2012-01-01", randInt(rng, 0, 2800)),
    weight: 0.3 + rng() * 2.2,
  });
}
const totalWeight = customers.reduce((a, c) => a + c.weight, 0);
function pickCustomer() {
  let r = rng() * totalWeight;
  for (const c of customers) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return customers[customers.length - 1];
}

const ORDER_SIZE: Record<string, [number, number]> = {
  "TX-100": [1, 8],
  "TX-200": [1, 6],
  "TX-300": [1, 4],
  "TX-400": [1, 3],
  "TX-500": [1, 2],
};

// ---- customer orders -----------------------------------------------------------------------
type Order = {
  id: number;
  customer_id: number;
  tractor_model: string;
  quantity: number;
  warehouse: string;
  ordered_at: string;
  requested_date: string;
  promised_date: string;
  fulfilled_date: string;
  status: string;
};
const orders: Order[] = [];
const unitsByModelMonth = new Map<string, number>();

const expectedByModelMonth = new Map<string, number>();
const monthsAhead = (ym: string) => {
  const [y0, m0] = CUR.split("-").map(Number);
  const [y1, m1] = ym.split("-").map(Number);
  return (y1 - y0) * 12 + (m1 - m0);
};

// Draws orders for one model and month. Orders requested before today are history and were
// delivered. Orders requested from today on are the open book; a month further out is less
// booked, so each future order is kept with that month's booking probability.
function emitOrders(model: string, ym: string, units: number) {
  let left = units;
  const booked = Math.max(PLANTED.bookedFloor, 1 - PLANTED.bookedDecayPerMonth * Math.max(0, monthsAhead(ym)));
  while (left > 0) {
    const [lo, hi] = ORDER_SIZE[model];
    const q = Math.min(left, randInt(rng, lo, hi));
    left -= q;
    const c = pickCustomer();
    const requested = `${ym}-${String(randInt(rng, 1, daysInMonth(ym))).padStart(2, "0")}`;
    const future = requested >= AS_OF;
    let ordered = addDays(requested, -randInt(rng, 25, 170));
    const warehouse = rng() < 0.82 ? c.state : pick(rng, WAREHOUSE_CODES);
    const keep = rng();
    if (future && keep > booked) continue;
    if (ordered >= AS_OF) ordered = addDays(AS_OF, -randInt(rng, 1, 20));
    const o: Order = {
      id: orders.length + 1,
      customer_id: c.id,
      tractor_model: model,
      quantity: q,
      warehouse,
      ordered_at: ordered,
      requested_date: requested,
      promised_date: "",
      fulfilled_date: "",
      status: "open",
    };
    if (!future) {
      o.promised_date = addDays(requested, randInt(rng, 0, 3));
      let done = addDays(o.promised_date, Math.max(-5, Math.round(normal(rng, 2, 5))));
      if (done >= AS_OF) done = addDays(AS_OF, -1);
      if (done < ordered) done = requested;
      o.fulfilled_date = done;
      o.status = "fulfilled";
    }
    orders.push(o);
    const k = `${model}|${ym}`;
    unitsByModelMonth.set(k, (unitsByModelMonth.get(k) ?? 0) + q);
  }
}

// Market data exists up to yesterday. Months after it use the trailing 12-month market rate.
for (const ym of monthRange(START, END)) {
  for (const m of TRACTOR_MODELS) {
    const rate = ym < CUR || (ym === CUR && coveredDays(CUR) >= 10) ? marketRate(m.code, ym) : trailingRate[m.code];
    const expected = rate * MARKET_SHARE * PLANTED.seasonal[monthIndex(ym)] * growth(ym);
    expectedByModelMonth.set(`${m.code}|${ym}`, expected);
    emitOrders(m.code, ym, poisson(rng, expected));
  }
}

// ---- production pipeline: open orders due in the first three months -----------------------
const buildDays = Object.fromEntries(TRACTOR_MODELS.map((m) => [m.code, m.buildDays]));
const pipeline: {
  customer_order_id: number;
  stage: string;
  stage_entered_at: string;
  scheduled_start: string;
  scheduled_finish: string;
}[] = [];
const pipelineHorizon = addMonthsDay(AS_OF, 3);
for (const o of orders) {
  if (o.status !== "open" || o.requested_date >= pipelineHorizon) continue;
  const finish = addDays(o.requested_date, -3);
  const start = addDays(finish, -buildDays[o.tractor_model]);
  let stage = "scheduled";
  let entered = addDays(start, -14);
  if (finish < addDays(AS_OF, 2)) {
    stage = "qa";
    entered = addDays(finish, -1);
  } else if (start <= AS_OF) {
    stage = "assembly";
    entered = start;
  }
  if (entered >= AS_OF) entered = addDays(AS_OF, -1);
  o.status = "in_production";
  o.promised_date = addDays(finish, 2);
  pipeline.push({ customer_order_id: o.id, stage, stage_entered_at: entered, scheduled_start: start, scheduled_finish: finish });
}

// ---- parts, supply orders, lots ------------------------------------------------------------
const { parts, partSuppliers } = buildParts();
const suppliersBySku = new Map<string, { supplier: string; nominalLeadDays: number; unitPrice: number }[]>();
for (const ps of partSuppliers) {
  (suppliersBySku.get(ps.sku) ?? suppliersBySku.set(ps.sku, []).get(ps.sku)!).push(ps);
}

type SupplyOrder = {
  id: number;
  sku: string;
  supplier: string;
  warehouse: string;
  quantity: number;
  unit_price: number;
  date_ordered: string;
  promised_date: string;
  fulfilled_date: string;
  status: string;
};
const supplyOrders: SupplyOrder[] = [];
const lots: {
  id: number;
  sku: string;
  supplier: string;
  warehouse: string;
  supply_order_id: number;
  quantity: number;
  received_date: string;
  broken_quantity: number;
  broken_date: string;
  broken_stage: string;
}[] = [];
const SUPPLIER_WEIGHTS = [0.55, 0.3, 0.15];
const STAGES = ["receiving", "receiving", "assembly", "assembly", "assembly", "field", "field"];

// Orders are placed a lead time ahead of the build month they cover.
for (const ym of monthRange(START, addMonths(CUR, 2))) {
  for (const m of TRACTOR_MODELS) {
    const units =
      ym < CUR
        ? (unitsByModelMonth.get(`${m.code}|${ym}`) ?? 0)
        : Math.round(expectedByModelMonth.get(`${m.code}|${ym}`) ?? 0);
    if (!units) continue;
    for (const cat of PART_CATEGORIES) {
      const sku = skuFor(cat.key, m.code);
      const opts = suppliersBySku.get(sku)!;
      let r = rng();
      let choice = opts[opts.length - 1];
      for (let i = 0; i < opts.length; i++) {
        r -= SUPPLIER_WEIGHTS[i] ?? 0;
        if (r <= 0) {
          choice = opts[i];
          break;
        }
      }
      const need = `${ym}-01`;
      const dateOrdered = addDays(need, -(choice.nominalLeadDays + randInt(rng, 5, 15)));
      if (dateOrdered >= AS_OF) continue;
      const qty = Math.max(1, Math.round(units * (1 + normal(rng, 0.03, 0.06))));
      const promised = addDays(dateOrdered, choice.nominalLeadDays);
      const delay = sampleDelay(choice.supplier, dateOrdered.slice(0, 7));
      const arrives = addDays(promised, delay);
      const so: SupplyOrder = {
        id: supplyOrders.length + 1,
        sku,
        supplier: choice.supplier,
        warehouse: pick(rng, WAREHOUSE_CODES),
        quantity: qty,
        unit_price: choice.unitPrice,
        date_ordered: dateOrdered,
        promised_date: promised,
        fulfilled_date: arrives < AS_OF ? arrives : "",
        status: arrives < AS_OF ? "fulfilled" : "placed",
      };
      supplyOrders.push(so);
      if (so.status === "fulfilled") {
        const p = failureRate(m.code, cat.key, choice.supplier, arrives.slice(0, 7));
        const brokenAt = addDays(arrives, randInt(rng, 0, 120));
        const broken = brokenAt < AS_OF ? binomial(rng, qty, p) : 0;
        lots.push({
          id: lots.length + 1,
          sku,
          supplier: choice.supplier,
          warehouse: so.warehouse,
          supply_order_id: so.id,
          quantity: qty,
          received_date: arrives,
          broken_quantity: broken,
          broken_date: broken ? brokenAt : "",
          broken_stage: broken ? pick(rng, STAGES) : "",
        });
      }
    }
  }
}

// ---- on-hand stock at the as-of date -------------------------------------------------------
// Seeded from the dataset's latest Inventory_Levels per model and warehouse, scaled to our share.
const inventory: { sku: string; warehouse: string; on_hand: number }[] = [];
for (const p of parts) {
  const depth = 0.55 + rng() * 1.6;
  for (const wh of WAREHOUSE_CODES) {
    const lvl = latestInventory.get(`${p.tractorModel}|${wh}`)?.level ?? 1000;
    inventory.push({ sku: p.sku, warehouse: wh, on_hand: Math.max(0, Math.round(lvl * MARKET_SHARE * depth)) });
  }
}

// ---- write -----------------------------------------------------------------------------------
function writeCsv(name: string, rows: Record<string, unknown>[]) {
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
  fs.writeFileSync(path.join(OUT, `${name}.csv`), body);
  return rows.length;
}

fs.mkdirSync(OUT, { recursive: true });
const counts = {
  customers: writeCsv("customers", customers.map((c) => ({ id: c.id, name: c.name, state: c.state, segment: c.segment, since: c.since }))),
  customer_orders: writeCsv("customer_orders", orders),
  production_pipeline: writeCsv("production_pipeline", pipeline),
  parts: writeCsv(
    "parts",
    parts.map((p) => ({
      sku: p.sku,
      tractor_model: p.tractorModel,
      category: p.category,
      name: p.name,
      qty_per_tractor: p.qtyPerTractor,
      standard_cost: p.standardCost,
    })),
  ),
  part_suppliers: writeCsv(
    "part_suppliers",
    partSuppliers.map((p) => ({
      sku: p.sku,
      supplier: p.supplier,
      unit_price: p.unitPrice,
      nominal_lead_days: p.nominalLeadDays,
    })),
  ),
  supply_orders: writeCsv("supply_orders", supplyOrders),
  inventory_parts: writeCsv("inventory_parts", lots),
  inventory: writeCsv("inventory", inventory),
};

fs.writeFileSync(
  path.join(OUT, "meta.json"),
  JSON.stringify(
    {
      asOf: AS_OF,
      shiftDays: SHIFT_DAYS,
      datasetFirst: DATASET_FIRST,
      datasetLast: DATASET_LAST,
      shiftedFirst: SHIFTED_FIRST,
      shiftedLast: SHIFTED_LAST,
      historyStart: `${START}-01`,
    },
    null,
    2,
  ) + "\n",
);

const open = orders.filter((o) => o.status !== "fulfilled");
console.log(`generated from ${signals.length} market signal rows`);
console.log(`  planning date        ${AS_OF} (dataset dates moved forward ${SHIFT_DAYS} days)`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(20)} ${v}`);
console.log(`  open orders          ${open.length} (${open.reduce((a, o) => a + o.quantity, 0)} tractors)`);
console.log(`  history              ${START}-01 to ${addDays(AS_OF, -1)}`);
