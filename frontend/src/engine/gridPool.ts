// Worker pool that runs the grid across CPU cores. Falls back to single-thread
// at the call site if workers aren't available.

import { compareResults, countGrid, type GridResult, type GridSpec } from "./grid";
import type { Bar } from "./types";
import { flattenBars } from "./gridShared";

export function workerCount(total: number): number {
  const cores = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));
  return Math.max(1, Math.min(cores, total));
}

interface WorkerMsg {
  type: "progress" | "done" | "error";
  done?: number;
  results?: GridResult[];
  message?: string;
}

export function runGridParallel(
  bars: Bar[],
  spec: GridSpec,
  onProgress?: (done: number, total: number) => void
): Promise<GridResult[]> {
  return new Promise((resolve, reject) => {
    const total = countGrid(spec);
    const count = workerCount(total);
    const flat = flattenBars(bars);

    const workers: Worker[] = [];
    const doneByWorker = new Array<number>(count).fill(0);
    const collected: GridResult[] = [];
    let finished = 0;
    let settled = false;

    const cleanup = () => workers.forEach((w) => w.terminate());
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const report = () => {
      let s = 0;
      for (const d of doneByWorker) s += d;
      onProgress?.(Math.min(s, total), total);
    };

    for (let i = 0; i < count; i++) {
      let w: Worker;
      try {
        w = new Worker(new URL("./gridWorker.ts", import.meta.url), { type: "module" });
      } catch (err) {
        fail(err);
        return;
      }
      workers.push(w);

      w.onmessage = (e: MessageEvent) => {
        if (settled) return;
        const msg = e.data as WorkerMsg;
        if (msg.type === "progress") {
          doneByWorker[i] = msg.done ?? 0;
          report();
        } else if (msg.type === "done") {
          doneByWorker[i] = msg.done ?? 0;
          report();
          if (msg.results) for (const r of msg.results) collected.push(r);
          if (++finished === count) {
            settled = true;
            cleanup();
            collected.sort((a, b) => compareResults(a, b, spec.rankBy));
            resolve(collected);
          }
        } else if (msg.type === "error") {
          fail(new Error(msg.message));
        }
      };
      w.onerror = () => fail(new Error("Optimiser worker failed"));

      w.postMessage({ bars: flat, spec, index: i, count });
    }
  });
}
