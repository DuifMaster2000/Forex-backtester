// A lightweight-charts series primitive that shades each trading session window
// (open -> close) with a translucent band and draws thin vertical boundary lines
// at the open (green) and close (red). Drawn in the chart's own render loop, so it
// stays aligned with the candles during pan/zoom.

import type {
  IChartApi,
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesAttachedParameter,
  SeriesPrimitivePaneViewZOrder,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

export interface SessionSpan {
  open: UTCTimestamp;
  close: UTCTimestamp;
}

const BAND_FILL = "rgba(56, 139, 253, 0.07)";
const OPEN_LINE = "rgba(38, 166, 154, 0.6)";
const CLOSE_LINE = "rgba(239, 83, 80, 0.6)";

class SessionRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(private readonly source: SessionPrimitive, private readonly isBackground: boolean) {}

  draw(target: CanvasRenderingTarget2D): void {
    if (!this.isBackground) this.source.drawLines(target);
  }

  drawBackground(target: CanvasRenderingTarget2D): void {
    if (this.isBackground) this.source.drawBands(target);
  }
}

class SessionPaneView implements ISeriesPrimitivePaneView {
  constructor(private readonly source: SessionPrimitive, private readonly isBackground: boolean) {}

  zOrder(): SeriesPrimitivePaneViewZOrder {
    return this.isBackground ? "bottom" : "normal";
  }

  renderer(): ISeriesPrimitivePaneRenderer {
    return new SessionRenderer(this.source, this.isBackground);
  }
}

export class SessionPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private requestUpdate: (() => void) | null = null;
  private spans: SessionSpan[] = [];
  private readonly views: SessionPaneView[] = [
    new SessionPaneView(this, true),
    new SessionPaneView(this, false),
  ];

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this.views;
  }

  setSpans(spans: SessionSpan[]): void {
    this.spans = spans;
    this.requestUpdate?.();
  }

  drawBands(target: CanvasRenderingTarget2D): void {
    const timeScale = this.chart?.timeScale();
    if (!timeScale) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hpr = scope.horizontalPixelRatio;
      ctx.fillStyle = BAND_FILL;
      for (const span of this.spans) {
        const x1 = timeScale.timeToCoordinate(span.open);
        const x2 = timeScale.timeToCoordinate(span.close);
        if (x1 == null || x2 == null) continue;
        const left = Math.min(x1, x2) * hpr;
        const width = Math.max(1, Math.abs(x2 - x1) * hpr);
        ctx.fillRect(left, 0, width, scope.bitmapSize.height);
      }
    });
  }

  drawLines(target: CanvasRenderingTarget2D): void {
    const timeScale = this.chart?.timeScale();
    if (!timeScale) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hpr = scope.horizontalPixelRatio;
      const lineWidth = Math.max(1, Math.floor(hpr));
      const height = scope.bitmapSize.height;
      for (const span of this.spans) {
        this.strokeVertical(ctx, timeScale.timeToCoordinate(span.open), hpr, lineWidth, height, OPEN_LINE);
        this.strokeVertical(ctx, timeScale.timeToCoordinate(span.close), hpr, lineWidth, height, CLOSE_LINE);
      }
    });
  }

  private strokeVertical(
    ctx: CanvasRenderingContext2D,
    coord: number | null,
    hpr: number,
    lineWidth: number,
    height: number,
    color: string
  ): void {
    if (coord == null) return;
    const x = Math.round(coord * hpr);
    ctx.fillStyle = color;
    ctx.fillRect(x - Math.floor(lineWidth / 2), 0, lineWidth, height);
  }
}
