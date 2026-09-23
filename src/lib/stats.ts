export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);

export function sd(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

export function quantile(xs: number[], p: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export function mae(actual: number[], pred: number[]) {
  return mean(actual.map((a, i) => Math.abs(a - pred[i])));
}

export function mape(actual: number[], pred: number[]) {
  return mean(actual.map((a, i) => (a === 0 ? 0 : Math.abs(a - pred[i]) / Math.abs(a))));
}

export function rmse(actual: number[], pred: number[]) {
  return Math.sqrt(mean(actual.map((a, i) => (a - pred[i]) ** 2)));
}

export function pearson(a: number[], b: number[]) {
  const ma = mean(a);
  const mb = mean(b);
  let c = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i++) {
    c += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return va && vb ? c / Math.sqrt(va * vb) : 0;
}

// Ordinary least squares with a small ridge term, solved by Gaussian elimination.
export function ols(X: number[][], y: number[], ridge = 1e-6): number[] {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let r = 0; r < X.length; r++) {
    const x = X[r];
    for (let i = 0; i < k; i++) {
      b[i] += x[i] * y[r];
      for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j];
    }
  }
  for (let i = 1; i < k; i++) A[i][i] += ridge * X.length;
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    const piv = A[c][c] || 1e-12;
    for (let r = c + 1; r < k; r++) {
      const f = A[r][c] / piv;
      if (!f) continue;
      for (let j = c; j < k; j++) A[r][j] -= f * A[c][j];
      b[r] -= f * b[c];
    }
  }
  const beta = new Array(k).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < k; j++) s -= A[i][j] * beta[j];
    beta[i] = s / (A[i][i] || 1e-12);
  }
  return beta;
}

export const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

export const Z80 = 1.2816;
export const Z90 = 1.6449;
export const Z95 = 1.6449; // one-sided 95% service level

// Normal approximation to a Beta(a, b) interval; accurate for the lot counts used here.
export function betaInterval(a: number, b: number, z = Z90) {
  const m = a / (a + b);
  const v = (a * b) / ((a + b) ** 2 * (a + b + 1));
  const s = Math.sqrt(v);
  return { mean: m, lo: Math.max(0, m - z * s), hi: Math.min(1, m + z * s) };
}

export const round = (x: number, d = 0) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
