import { test } from "node:test";
import assert from "node:assert/strict";
import { ols, quantile, betaInterval } from "../src/lib/stats";
import { computeStockout } from "../src/lib/models/stock";

test("ols recovers known coefficients", () => {
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 200; i++) {
    const a = Math.sin(i);
    const b = Math.cos(i * 0.7);
    X.push([1, a, b]);
    y.push(3 + 2 * a - 5 * b);
  }
  const [c, ca, cb] = ols(X, y, 0);
  assert.ok(Math.abs(c - 3) < 1e-6 && Math.abs(ca - 2) < 1e-6 && Math.abs(cb + 5) < 1e-6);
});

test("quantile interpolates", () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([0, 10], 0.9), 9);
});

test("beta interval contains the mean and narrows with more data", () => {
  const small = betaInterval(5, 95);
  const big = betaInterval(500, 9500);
  assert.ok(small.lo < 0.05 && small.hi > 0.05);
  assert.ok(big.hi - big.lo < small.hi - small.lo);
});

test("stockout is the build start that first exceeds stock on hand", () => {
  const out = computeStockout(
    [{ sku: "A", units: 10 }, { sku: "B", units: 100 }],
    [
      { sku: "A", scheduled_start: "2024-01-05", units: 6 },
      { sku: "A", scheduled_start: "2024-01-09", units: 6 },
      { sku: "B", scheduled_start: "2024-01-05", units: 6 },
    ],
  );
  assert.deepEqual(Object.fromEntries(out.map((o) => [o.sku, o.date])), { A: "2024-01-09", B: null });
});
