// Seeded random numbers so the generated dataset is identical on every machine.

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = ReturnType<typeof mulberry32>;

export function randInt(rng: Rng, lo: number, hi: number) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function normal(rng: Rng, mean = 0, sd = 1) {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function poisson(rng: Rng, lambda: number) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(normal(rng, lambda, Math.sqrt(lambda))));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

export function binomial(rng: Rng, n: number, p: number) {
  if (n <= 0 || p <= 0) return 0;
  if (n > 60) return Math.min(n, Math.max(0, Math.round(normal(rng, n * p, Math.sqrt(n * p * (1 - p))))));
  let k = 0;
  for (let i = 0; i < n; i++) if (rng() < p) k++;
  return k;
}
