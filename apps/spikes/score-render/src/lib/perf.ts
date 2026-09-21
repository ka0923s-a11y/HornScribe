/** Tiny measurement recorder for spike evidence (GUI_UX_PLAN §46 budgets). */

export interface MetricStats {
  count: number;
  last: number;
  min: number;
  max: number;
  avg: number;
}

export class Metrics {
  private samples = new Map<string, number[]>();

  record(label: string, ms: number): number {
    const list = this.samples.get(label) ?? [];
    list.push(ms);
    this.samples.set(label, list);
    return ms;
  }

  /** Time a synchronous call, record under `label`, return the call result. */
  measure<T>(label: string, fn: () => T): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.record(label, performance.now() - t0);
    }
  }

  stats(label: string): MetricStats | null {
    const list = this.samples.get(label);
    if (!list || list.length === 0) return null;
    const sum = list.reduce((a, b) => a + b, 0);
    return {
      count: list.length,
      last: list[list.length - 1],
      min: Math.min(...list),
      max: Math.max(...list),
      avg: sum / list.length,
    };
  }

  labels(): string[] {
    return [...this.samples.keys()];
  }
}

export const metrics = new Metrics();

export function formatMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`;
}
