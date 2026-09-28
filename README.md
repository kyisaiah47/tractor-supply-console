# Tractor Supply Console

A working prototype from the Kontakt.io system design interview. It turns a supplied market dataset into a synthetic tractor manufacturer's order book, inventory, production pipeline, and supplier history. Planners can review orders, inspect four forecasts, draft replenishment orders with an assistant, and submit them to an asynchronous supplier queue.

[Watch the 85-second demo](https://youtu.be/1B5LB3YdftQ) · [View the interview whiteboard](docs/system-design-whiteboard.pdf)

## Run locally

**Docker (recommended):**

```bash
git clone https://github.com/kyisaiah47/tractor-supply-console.git
cd tractor-supply-console
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). Compose starts Postgres, generates and loads the data on an empty database, runs the models, and starts the API, worker, and web app. It retains the database across restarts.

**Host development:** Requires Node 20+, [uv](https://docs.astral.sh/uv/), and Docker for Postgres. uv installs Python 3.13 if needed.

```bash
cp .env.example .env
npm install
uv --directory backend sync
npm run db:up
npm run db:setup
npm run dev
```

The assistant works without an API key in deterministic keyword mode. For model-backed answers, set `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` in `.env`. `LLM_PROVIDER=offline` forces keyword mode. The same variables can be supplied to Docker Compose through `.env`.

## Data and design

`data/market_signals.csv` is the supplied 10,000-row dataset (2020–2023). It has market demand, supplier delays, component failure rates, inventory, and economic indicators, but none of the operational tables in the whiteboard. `backend/supply/generate.py` deterministically creates customers, customer orders, production schedules, parts, supplier orders, and inventory lots from it. Generated CSVs stay in ignored `data/generated/`; `npm run db:setup` rebuilds and loads them. Set `APP_AS_OF=YYYY-MM-DD` to reproduce a particular planning date.

The supplied data has little useful predictive variation on its own. The generator adds documented seasonal demand and supplier and part effects in `backend/supply/planted.py`. Tests check that the models detect those effects without flagging unrelated parts. The four models use held-out data and simple baselines:

| Model | Output |
|---|---|
| Demand | Monthly tractor forecasts and uncertainty ranges |
| Supplier delay | Expected lateness and risk to open orders |
| Component failure | Failure rates by part and supplier |
| Inventory strategy | Reorder timing, quantity, and supplier |

The FastAPI service owns Postgres and exposes `/api/*`; Next.js serves the console and forwards API requests. The assistant reads the same data as the screens and can **draft** a supply order, but only a person can confirm it. Confirmed orders enter a Postgres job queue. The worker quotes mock supplier APIs, retries transient failures, and uses idempotency keys so retries do not place duplicate orders.

## Verify

```bash
npm test
npm run lint
npm run typecheck
npm run build
uv --directory backend run ruff check supply tests
uv --directory backend run ruff format --check supply tests
uv --directory backend run mypy supply tests
```

`npm test` runs the backend tests against a local Postgres instance (`npm run db:up` first). CI runs these checks and a fresh data setup on every push. With the app running, the API schema is at [http://localhost:8000/docs](http://localhost:8000/docs).

## Code map

| Path | Purpose |
|---|---|
| `backend/supply/generate.py`, `seed.py` | Synthetic dataset and database setup |
| `backend/supply/models/` | Four forecasting and planning models |
| `backend/supply/agent/` | Assistant tools, model loop, offline mode |
| `backend/supply/worker.py`, `mock_suppliers.py` | Supplier order processing |
| `backend/supply/api.py` | HTTP API |
| `backend/tests/` | API, model, worker, and assistant tests |
| `src/` | Next.js console |

This is a local prototype: suppliers are simulated, there is no user authentication, and the weekly model refresh runs on demand rather than from a production scheduler.
