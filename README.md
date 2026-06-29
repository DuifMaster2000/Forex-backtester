# Forex Strategy Backtester

A personal research tool to fine-tune forex/metals strategies and judge their
feasibility. Upload OANDA/TradingView CSV exports, view the instrument on a
candlestick chart, and backtest configurable strategies. The first built-in
strategy detects large **session gaps** and simulates trades with price- or
time-based stops.

> **Live demo:** once GitHub Pages is enabled, the app runs fully in the browser
> at `https://duifmaster2000.github.io/Forex-backtester/` — no server required.
> Your CSV never leaves your machine. See **[Deployment](#deployment)**.

## Two ways to run

The strategy engine exists in two forms with **identical logic** (verified to
produce the same numbers):

- **Browser (TypeScript)** — `frontend/src/engine/`. Runs entirely client-side, so
  the app is a static site deployable to GitHub Pages. This is what the live demo
  uses.
- **Python backend (FastAPI)** — `backend/`. A REST API plus pytest suite, handy
  for local development, scripting, and validating the TypeScript port.

## Highlights

- **DST-correct, New York display axis.** CSV timestamps carry the chart's local
  UTC offset (e.g. `+02:00`) and are parsed to a true UTC instant. Everything is
  *displayed* on one **New York axis** (`America/New_York`) — candles, session
  bands, and trade markers — so a "09:30 open" stays anchored across DST. Each
  session is *detected* in its own real timezone (NY = America/New_York, London =
  Europe/London, Tokyo = Asia/Tokyo) and then rendered in NY time, so e.g.
  London's real 08:00 open appears at its correct NY position (~03:00 ET in
  summer) rather than at 08:00 ET. Both DST transitions are handled by tzdata.
- **Gap detection.** For each session, the gap is the move from the previous
  session close to the next session open (NY: 17:00 ET → 09:30 ET). A gap is
  "big" when `|gap| > mean + sigma·std` of the previous `window` gaps
  (defaults: window 20, sigma 1.5; both adjustable).
- **Configurable trade engine.** Direction (fade vs. follow), an entry delay
  measured from the gap (30-min steps, up to 48h), stop-loss and take-profit
  (in points, percent, gap multiples, or multiples of the 20-day **Average Daily
  Range** for instrument-agnostic risk), and a time stop measured from the gap
  (30-min steps, up to 96h). Entry and time stop are counted in **trading bars**
  (not wall-clock), so a duration represents real market time — weekends and
  daily closures, which have no bars, don't consume the budget and a 48h stop
  spans a weekend rather than expiring inside it. Same-bar SL/TP ambiguity on
  30-minute bars is resolved by a configurable rule (default: stop-first,
  conservative). A **spread** (round-trip transaction cost in price units, e.g.
  EURUSD 0.00015 = 1.5 pips, gold 0.30) can be deducted from every trade to make
  results realistic — configurable in single/stability runs and as a static
  value in the optimiser.
- **Any instrument, auto precision.** Works for metals, indices, FX, etc. The
  price precision is detected from the data (e.g. EURUSD = 5 dp), and P/L, prices,
  and the chart's price axis are formatted to that precision so small pips aren't
  rounded away.
- **Chart + results.** Candlesticks with big-gap and trade entry/exit markers,
  a metrics summary (win rate, expectancy, profit factor, drawdown, total/avg R),
  a **long vs short breakdown** to reveal directional asymmetry (useful for
  trending instruments like NAS100), and a trade table.
- **Brute-force optimiser.** An *Optimize* mode lets you choose which parameters
  to vary (session, direction, gap window/sigma, entry delay, time stop, SL, TP)
  and over what ranges/intervals, then runs every permutation and reports the
  combinations ranked by a chosen metric (Total R/P&L, **Return / Max Drawdown**,
  profit factor, etc.), with the best highlighted and a CSV export. Runs
  client-side across a **Web Worker pool** (one per CPU core) for a near-linear
  speedup on large grids, with `zonedParts` memoisation on top; ranking is
  deterministic via a config tiebreak. Curve-fitting caveats apply — it's a
  research aid, not a promise.
- **Stability sweep.** A *Stability* mode varies one parameter (optionally split
  into a few series, e.g. fade vs follow) over a range and plots a metric (P&L,
  profit factor, Total R, …) as a line chart, so you can check a strategy sits on
  a broad **plateau** rather than a single profitable **spike** — a quick sanity
  check against curve-fitting.

## Project layout

```
backend/                 FastAPI app: CSV loader, sessions, gap strategy, engine
frontend/
  src/engine/            TypeScript port of the engine (runs in the browser)
  src/components/         React UI with lightweight-charts
  src/api/client.ts       in-browser facade calling the engine (no network)
.github/workflows/deploy.yml   builds the frontend and publishes to GitHub Pages
```

## Running (local)

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload      # serves on http://localhost:8000
```

### Frontend (standalone — no backend needed)

```bash
cd frontend
npm install
npm run dev                        # serves on http://localhost:5173
```

Open http://localhost:5173, upload a CSV (columns `time,open,high,low,close,Volume`
with ISO-8601 timestamps), pick parameters, and click **Run backtest**. All
computation happens in the browser; the Python backend is optional.

### Tests

```bash
cd backend
python -m pytest
```

Covers DST conversion (summer `+02:00` and winter `+01:00` both mapping to the
correct ET hour), gap-outlier detection, and engine exits (stop, target, time
stop, and same-bar ordering).

## Deployment

The app is a static site, so it deploys to **GitHub Pages** via
`.github/workflows/deploy.yml` (build with Vite → publish `frontend/dist`).

One-time setup (repo admin):

1. Push the branch (the workflow triggers on push and via **Actions → Deploy to
   GitHub Pages → Run workflow**).
2. **Settings → Pages → Build and deployment → Source → GitHub Actions**.
3. Wait for the **Deploy to GitHub Pages** workflow to finish. The site is then
   live at `https://duifmaster2000.github.io/Forex-backtester/`.

If the deploy step is blocked by an environment branch rule, go to
**Settings → Environments → github-pages → Deployment branches** and allow the
deploying branch (or merge it into the default branch).

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/datasets` | Upload a CSV, returns dataset id + metadata |
| GET | `/api/datasets/{id}/candles?tz=` | OHLC candles in the given timezone |
| GET | `/api/datasets/{id}/gaps?session=NY&window=20&sigma=1.5` | Per-session gaps + big-gap flags |
| POST | `/api/datasets/{id}/backtest` | Run a backtest from a strategy config |
| POST | `/api/datasets/{id}/optimize` | Brute-force a parameter grid, ranked results |
| POST | `/api/datasets/{id}/sweep` | Vary one parameter, metric curve(s) for stability |
| GET / POST | `/api/sessions` | List / add session presets |

## Adding a new strategy

The framework is registry-friendly: add a module under
`backend/app/strategies/` that produces signals, and either extend the existing
backtest engine or add a new config schema. Session handling, DST conversion,
metrics, and the chart all remain reusable.

## Notes

- 30-minute OHLC means intrabar fills are approximations; the conservative
  same-bar ordering is the default and is configurable per run.
- Uploaded files are persisted under `backend/data/uploads/`; the in-memory
  dataset registry resets on backend restart (re-upload, or add SQLite later).
