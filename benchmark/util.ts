export interface Stats {
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    min: sorted[0]!,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[sorted.length - 1]!
  };
}

export function printStats(label: string, s: Stats, unit = 'ms'): void {
  const f = (n: number) => n.toFixed(unit === 'ms' ? 2 : 1);
  console.log(
    `${label.padEnd(28)} min=${f(s.min)} mean=${f(s.mean)} p50=${f(s.p50)} p95=${f(s.p95)} p99=${f(s.p99)} max=${f(s.max)} ${unit}`
  );
}
