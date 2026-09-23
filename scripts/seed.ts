// Creates the schema and loads both datasets:
//   data/market_signals.csv  -> market_signals (the provided dataset, row for row)
//   data/generated/*.csv     -> the operational tables (run `npm run data:generate` first)
// Then runs the four models once and writes the first weekly brief.
import "./_env";
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { pool } from "../src/lib/db";
import { TRACTOR_MODELS, SUPPLIERS, WAREHOUSES } from "../src/lib/catalog";
import { runWeeklyJob } from "../src/lib/weekly";
import { addDays } from "../src/lib/dates";

const ROOT = process.cwd();

function readCsv(file: string): Record<string, string>[] {
  return parse(fs.readFileSync(path.join(ROOT, file)), { columns: true, skip_empty_lines: true });
}

async function insert(table: string, cols: string[], rows: unknown[][]) {
  const chunk = Math.floor(60_000 / cols.length);
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = part.map((r) => {
      const ph = r.map((v) => {
        params.push(v === "" ? null : v);
        return `$${params.length}`;
      });
      return `(${ph.join(",")})`;
    });
    await pool.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values.join(",")}`, params);
  }
  return rows.length;
}

async function loadCsv(table: string, file: string) {
  const rows = readCsv(file);
  const cols = Object.keys(rows[0]);
  const n = await insert(table, cols, rows.map((r) => cols.map((c) => r[c])));
  if (cols.includes("id")) {
    await pool.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), (SELECT MAX(id) FROM ${table}))`);
  }
  return n;
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, "data/generated/customer_orders.csv"))) {
    throw new Error("data/generated is empty. Run `npm run data:generate` first.");
  }
  await pool.query(fs.readFileSync(path.join(ROOT, "db/schema.sql"), "utf8"));

  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "data/generated/meta.json"), "utf8"));
  const signals = readCsv("data/market_signals.csv");
  const counts: Record<string, number> = {};
  counts.market_signals = await insert(
    "market_signals",
    [
      "date",
      "source_date",
      "tractor_model",
      "demand_units",
      "supplier",
      "supplier_delay_days",
      "component_failure_rate",
      "inventory_levels",
      "warehouse_location",
      "inflation_rate",
      "market_trend_index",
    ],
    signals.map((r) => [
      addDays(r.Date, meta.shiftDays),
      r.Date,
      r.Tractor_Model,
      r.Demand_Units,
      r.Supplier,
      r.Supplier_Delay_Days,
      r.Component_Failure_Rate,
      r.Inventory_Levels,
      r.Warehouse_Location,
      r.Inflation_Rate,
      r.Market_Trend_Index,
    ]),
  );

  await insert(
    "tractor_models",
    ["code", "name", "horsepower", "list_price", "build_days"],
    TRACTOR_MODELS.map((m) => [m.code, m.name, m.horsepower, m.listPrice, m.buildDays]),
  );
  await insert("suppliers", ["code", "slug", "name"], SUPPLIERS.map((s) => [s.code, s.slug, s.name]));
  await insert("warehouses", ["code", "name"], WAREHOUSES.map((w) => [w.code, w.name]));

  for (const t of [
    "parts",
    "part_suppliers",
    "customers",
    "customer_orders",
    "production_pipeline",
    "supply_orders",
    "inventory_parts",
    "inventory",
  ]) {
    counts[t] = await loadCsv(t, `data/generated/${t}.csv`);
  }
  for (const [k, v] of Object.entries(counts)) console.log(`  loaded ${k.padEnd(20)} ${v}`);
  console.log(`  planning date ${meta.asOf}, dataset dates moved forward ${meta.shiftDays} days`);

  const t0 = Date.now();
  const brief = await runWeeklyJob({ useLlm: false });
  console.log(`  ran 4 models and wrote the weekly brief in ${Date.now() - t0} ms (${brief.author})`);
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
