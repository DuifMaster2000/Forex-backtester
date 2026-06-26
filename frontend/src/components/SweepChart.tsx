import type { SweepSeries } from "../engine/sweep";

const COLORS = ["#3fb950", "#58a6ff", "#f5a623", "#ef5350", "#a371f7", "#56d4dd"];
const W = 760;
const H = 340;
const M = { l: 60, r: 16, t: 16, b: 42 };

interface Props {
  series: SweepSeries[];
  xLabel: string;
  yLabel: string;
  yFormat: (v: number) => string;
}

export default function SweepChart({ series, xLabel, yLabel, yFormat }: Props) {
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const ys = series.flatMap((s) => s.points.map((p) => p.y).filter((y): y is number => y != null));
  if (xs.length === 0 || ys.length === 0) {
    return <p className="muted">No data to plot.</p>;
  }

  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys, 0);
  const yMax = Math.max(...ys, 0);

  const px = (x: number) => M.l + (xMax === xMin ? 0.5 : (x - xMin) / (xMax - xMin)) * (W - M.l - M.r);
  const py = (y: number) => M.t + (yMax === yMin ? 0.5 : 1 - (y - yMin) / (yMax - yMin)) * (H - M.t - M.b);

  // Distinct x values for ticks (sub-sample if many).
  const xVals = [...new Set(xs)].sort((a, b) => a - b);
  const xTicks = xVals.length <= 12 ? xVals : everyNth(xVals, Math.ceil(xVals.length / 10));
  const yTicks = linspace(yMin, yMax, 5);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="sweep-svg" preserveAspectRatio="xMidYMid meet">
        {/* y grid + labels */}
        {yTicks.map((y, i) => (
          <g key={i}>
            <line x1={M.l} x2={W - M.r} y1={py(y)} y2={py(y)} className="grid" />
            <text x={M.l - 8} y={py(y) + 3} className="axis-label" textAnchor="end">{yFormat(y)}</text>
          </g>
        ))}
        {/* zero baseline */}
        {yMin < 0 && yMax > 0 && (
          <line x1={M.l} x2={W - M.r} y1={py(0)} y2={py(0)} className="zero-line" />
        )}
        {/* x ticks */}
        {xTicks.map((x, i) => (
          <text key={i} x={px(x)} y={H - M.b + 16} className="axis-label" textAnchor="middle">
            {trim(x)}
          </text>
        ))}
        {/* axis titles */}
        <text x={(M.l + W - M.r) / 2} y={H - 4} className="axis-title" textAnchor="middle">{xLabel}</text>
        <text x={14} y={(M.t + H - M.b) / 2} className="axis-title"
          textAnchor="middle" transform={`rotate(-90 14 ${(M.t + H - M.b) / 2})`}>{yLabel}</text>

        {/* series lines + points */}
        {series.map((s, si) => {
          const color = COLORS[si % COLORS.length];
          return (
            <g key={s.label}>
              <path d={linePath(s.points, px, py)} fill="none" stroke={color} strokeWidth={1.8} />
              {s.points.map((p, pi) =>
                p.y == null ? null : (
                  <circle key={pi} cx={px(p.x)} cy={py(p.y)} r={2.6} fill={color}>
                    <title>{`${s.label}  ${trim(p.x)} → ${yFormat(p.y)}`}</title>
                  </circle>
                )
              )}
            </g>
          );
        })}
      </svg>

      {series.length > 1 && (
        <div className="sweep-legend">
          {series.map((s, si) => (
            <span key={s.label} className="legend-item">
              <span className="swatch" style={{ background: COLORS[si % COLORS.length] }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function linePath(
  points: { x: number; y: number | null }[],
  px: (x: number) => number,
  py: (y: number) => number
): string {
  let d = "";
  let pen = false; // whether the last point was drawable (break line on null)
  for (const p of points) {
    if (p.y == null) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"} ${px(p.x).toFixed(1)} ${py(p.y).toFixed(1)} `;
    pen = true;
  }
  return d.trim();
}

function linspace(a: number, b: number, n: number): number[] {
  if (a === b) return [a];
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

function everyNth<T>(arr: T[], n: number): T[] {
  return arr.filter((_, i) => i % n === 0);
}

function trim(v: number): string {
  return Number(v.toFixed(4)).toString();
}
