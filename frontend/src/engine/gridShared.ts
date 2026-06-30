// Pure helpers shared by the worker pool and the single-thread fallback, kept
// free of any Worker references so both can import them without cycles.

import type { Bar } from "./types";
import { expandGrid, type GridResult, type GridSpec } from "./grid";
import { getSession } from "./sessions";
import { makeGridRunner } from "./backtest";

const FIELDS = 6; // ms, open, high, low, close, volume

// Bars <-> flat Float64Array, so they can be posted to workers cheaply.
export function flattenBars(bars: Bar[]): Float64Array {
  const a = new Float64Array(bars.length * FIELDS);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const o = i * FIELDS;
    a[o] = b.ms;
    a[o + 1] = b.open;
    a[o + 2] = b.high;
    a[o + 3] = b.low;
    a[o + 4] = b.close;
    a[o + 5] = b.volume;
  }
  return a;
}

export function unflattenBars(a: Float64Array): Bar[] {
  const n = a.length / FIELDS;
  const bars: Bar[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * FIELDS;
    bars[i] = { ms: a[o], open: a[o + 1], high: a[o + 2], low: a[o + 3], close: a[o + 4], volume: a[o + 5] };
  }
  return bars;
}

// Run the configs at indices index, index+count, index+2*count, … of the grid.
// Splitting by stride balances load across workers. equity_curve is dropped (the
// optimiser report never uses it) to keep results small to transfer/hold.
export function runStride(
  bars: Bar[],
  spec: GridSpec,
  index: number,
  count: number,
  onProgress?: (done: number) => void
): GridResult[] {
  const configs = expandGrid(spec);
  const out: GridResult[] = [];
  const run = makeGridRunner(bars); // memoizes signal-level work across this stride
  let done = 0;
  for (let i = index; i < configs.length; i += count) {
    const config = configs[i];
    const metrics = run(getSession(config.session), config).metrics;
    metrics.equity_curve = [];
    out.push({ config, metrics });
    done++;
    if (onProgress && done % 50 === 0) onProgress(done);
  }
  onProgress?.(done);
  return out;
}
