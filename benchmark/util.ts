export interface Stats {
  min: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

/**
 * Nearest-rank percentiles. `p99` is deliberately absent: at the iteration counts used here it
 * resolves to the last sample, so it would print `max` under a second name and read as corroboration
 * of a figure it is a copy of.
 */
export function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
  return {
    min: sorted[0]!,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted.at(-1)!
  };
}

export function printStats(label: string, s: Stats, unit = 'ms'): void {
  const f = (n: number) => n.toFixed(unit === 'ms' ? 2 : 1);
  console.log(
    `${label.padEnd(28)} min=${f(s.min)} mean=${f(s.mean)} p50=${f(s.p50)} p95=${f(s.p95)} max=${f(s.max)} ${unit}`
  );
}
