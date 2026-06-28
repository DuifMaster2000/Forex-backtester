// Worker entry: receives the bars + grid spec + its stride, runs that slice of
// the grid, and posts progress and the results back.

import { runStride, unflattenBars } from "./gridShared";
import type { GridSpec } from "./grid";

interface InMsg {
  bars: Float64Array;
  spec: GridSpec;
  index: number;
  count: number;
}

interface Ctx {
  postMessage(msg: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
}

const ctx = self as unknown as Ctx;

ctx.onmessage = (e: MessageEvent) => {
  const { bars, spec, index, count } = e.data as InMsg;
  try {
    const results = runStride(unflattenBars(bars), spec, index, count, (done) =>
      ctx.postMessage({ type: "progress", done })
    );
    ctx.postMessage({ type: "done", done: results.length, results });
  } catch (err) {
    ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
