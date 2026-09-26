"""The planning assistant's tools.

Each one reads the same data and model output the console reads, so the assistant and the
screens cannot disagree. Only propose_supply_order touches supply orders, and it does not
write: it returns a draft the user confirms in the chat.
"""

from collections.abc import Callable
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from ..config import as_of
from ..db import rows
from ..models import latest_runs
from ..queries import list_orders, overview
from ..supply_orders import lines_for_customer_orders
from ..weekly import latest_brief

TractorModel = Literal["TX-100", "TX-200", "TX-300", "TX-400", "TX-500"]
Supplier = Literal["Supplier A", "Supplier B", "Supplier C", "Supplier D", "Supplier E"]
Warehouse = Literal["CA", "FL", "IL", "NY", "TX"]


def _runs() -> dict:
    r = latest_runs()
    if not r:
        raise RuntimeError("No model runs yet. Run the weekly job first.")
    return r


class NoInput(BaseModel):
    pass


class CustomerOrdersInput(BaseModel):
    tab: Literal["pipeline", "backlog"]
    months: int = Field(ge=1, le=12, description="Horizon in months: 1-3 for pipeline, 1-12 for backlog")
    tractor_model: TractorModel | None = None
    warehouse: Warehouse | None = None
    parts: Literal["covered", "short"] | None = None
    limit: int = Field(15, ge=1, le=50)


class ModelFilter(BaseModel):
    tractor_model: TractorModel | None = None


class DelayInput(BaseModel):
    supplier: Supplier | None = None
    only_at_risk: bool = True


class FailureInput(BaseModel):
    tractor_model: TractorModel | None = None
    only_elevated: bool = True
    supplier: Supplier | None = None


class InventoryInput(BaseModel):
    action: Literal["order", "ok", "excess", "all"] = "order"
    tractor_model: TractorModel | None = None


class MarketInput(BaseModel):
    group_by: Literal["month", "year", "tractor_model", "supplier", "warehouse"]
    tractor_model: TractorModel | None = None
    supplier: Supplier | None = None
    warehouse: Warehouse | None = None
    from_: str | None = Field(None, alias="from", pattern=r"^\d{4}-\d{2}-\d{2}$")
    to: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class DraftLine(BaseModel):
    sku: str
    quantity: int = Field(gt=0)
    warehouse: Warehouse | None = None
    supplier: Supplier | None = None


class ProposalInput(BaseModel):
    lines: list[DraftLine] | None = None
    customer_order_ids: list[int] | None = None
    reason: str = Field(description="One sentence the user will see explaining why")


def get_overview(_: NoInput) -> Any:
    return overview()


def list_customer_orders(i: CustomerOrdersInput) -> Any:
    r = list_orders(i.tab, i.months, i.tractor_model, i.warehouse, i.parts, i.limit)
    return {"totals": r["totals"], "through": r["through"], "facets": r["facets"], "rows": r["rows"]}


def get_demand_forecast(i: ModelFilter) -> Any:
    d = _runs()["demand"]
    return {
        "chosenModel": d["metrics"]["chosen"],
        "backtest": {k: {"mae": v["mae"], "mape": v["mape"]} for k, v in d["metrics"]["backtest"].items()},
        "datasetDiagnostics": d["metrics"]["diagnostics"],
        "perModel": [
            {"model": m["model"], "forecast": m["forecast"]}
            for m in d["output"]["perModel"]
            if not i.tractor_model or m["model"] == i.tractor_model
        ],
    }


def get_supplier_delays(i: DelayInput) -> Any:
    sd = _runs()["supplier_delay"]
    open_orders = sorted(
        (
            o
            for o in sd["output"]["openOrders"]
            if (not i.supplier or o["supplier"] == i.supplier) and (not i.only_at_risk or o["lateRisk"] >= 0.5)
        ),
        key=lambda o: -o["lateRisk"],
    )[:20]
    return {
        "backtest": sd["metrics"]["backtest"],
        "suppliers": [s for s in sd["output"]["suppliers"] if not i.supplier or s["supplier"] == i.supplier],
        "openOrders": open_orders,
        "openAtRisk": sd["output"]["atRisk"],
    }


def get_component_failures(i: FailureInput) -> Any:
    cf = _runs()["component_failure"]
    found = [
        x
        for x in cf["output"]["rows"]
        if (not i.only_elevated or x["elevated"])
        and (not i.tractor_model or x["tractorModel"] == i.tractor_model)
        and (not i.supplier or x["supplier"] == i.supplier)
    ][:25]
    return {"backtest": cf["metrics"]["backtest"], "rows": found, "expectedBrokenInPipeline": cf["output"]["expectedBrokenInPipeline"]}


def get_inventory_recommendations(i: InventoryInput) -> Any:
    inv = _runs()["inventory_strategy"]
    found = [
        {**{k: v for k, v in x.items() if k != "options"}, "alternatives": x["options"][1:]}
        for x in inv["output"]["rows"]
        if (i.action == "all" or x["action"] == i.action) and (not i.tractor_model or x["tractorModel"] == i.tractor_model)
    ]
    out = inv["output"]
    return {
        "metrics": inv["metrics"],
        "summary": {"toOrder": out["toOrder"], "spend": out["spend"], "excess": out["excess"]},
        "rows": found,
    }


MARKET_KEY = {
    "month": "to_char(date,'YYYY-MM')",
    "year": "to_char(date,'YYYY')",
    "tractor_model": "tractor_model",
    "supplier": "supplier",
    "warehouse": "warehouse_location",
}


def query_market_signals(i: MarketInput) -> Any:
    where: list[str] = ["1=1"]
    params: dict[str, Any] = {}
    for col, val, op in [
        ("tractor_model", i.tractor_model, "="),
        ("supplier", i.supplier, "="),
        ("warehouse_location", i.warehouse, "="),
        ("date", i.from_, ">="),
        ("date", i.to, "<="),
    ]:
        if val:
            name = f"p{len(params)}"
            where.append(f"{col} {op} :{name}")
            params[name] = val
    found = rows(
        f"""SELECT {MARKET_KEY[i.group_by]} AS key, COUNT(*)::int AS rows, SUM(demand_units)::int AS demand_units,
                   ROUND(AVG(supplier_delay_days)::numeric,2)::float AS avg_delay_days,
                   ROUND(AVG(component_failure_rate)::numeric,4)::float AS avg_failure_rate,
                   ROUND(AVG(inventory_levels)::numeric,0)::int AS avg_inventory,
                   ROUND(AVG(inflation_rate)::numeric,2)::float AS avg_inflation,
                   ROUND(AVG(market_trend_index)::numeric,3)::float AS avg_trend_index
              FROM market_signals WHERE {" AND ".join(where)} GROUP BY 1 ORDER BY 1 LIMIT 60""",
        params,
    )
    return {"rows": found}


def get_weekly_brief(_: NoInput) -> Any:
    return latest_brief()


def propose_supply_order(i: ProposalInput) -> Any:
    lines: list[dict] = [ln.model_dump(exclude_none=True) for ln in (i.lines or [])]
    if i.customer_order_ids:
        lines += lines_for_customer_orders(i.customer_order_ids)["lines"]
    prices = rows("SELECT sku, supplier, unit_price FROM part_suppliers WHERE sku = ANY(:skus)", {"skus": [ln["sku"] for ln in lines]})
    unknown = [ln["sku"] for ln in lines if not any(p["sku"] == ln["sku"] for p in prices)]
    if unknown:
        return {"error": f"Unknown SKUs: {', '.join(unknown)}"}
    priced = []
    for ln in lines:
        opts = [p for p in prices if p["sku"] == ln["sku"]]
        p = next((o for o in opts if o["supplier"] == ln.get("supplier")), None) or min(opts, key=lambda o: o["unit_price"])
        priced.append(
            {
                **ln,
                "warehouse": ln.get("warehouse") or "IL",
                "estUnitPrice": p["unit_price"],
                "estCost": round(p["unit_price"] * ln["quantity"]),
            }
        )
    return {
        "proposal": True,
        "asOf": as_of(),
        "reason": i.reason,
        "lines": priced,
        "estTotal": sum(ln["estCost"] for ln in priced),
        "note": "Not placed. The user must press Confirm in the chat to queue these orders.",
    }


class Tool:
    def __init__(self, name: str, description: str, schema: type[BaseModel], run: Callable[[Any], Any]) -> None:
        self.name, self.description, self.schema, self.run = name, description, schema, run
        self.json_schema = _clean(schema.model_json_schema(by_alias=True))


def _clean(s: Any) -> Any:
    """Drop Pydantic's titles so the schema the model sees is only names, types and descriptions."""
    if isinstance(s, dict):
        return {k: _clean(v) for k, v in s.items() if k != "title"}
    if isinstance(s, list):
        return [_clean(v) for v in s]
    return s


TOOLS = [
    Tool(
        "get_overview",
        "Headline numbers: open orders and tractors in the 12-month backlog and the 0-3 month production pipeline, supply orders in flight, parts to order, elevated failure pairs, when the models last ran.",
        NoInput,
        get_overview,
    ),
    Tool(
        "list_customer_orders",
        "Customer orders from the dashboard table. tab 'pipeline' is orders scheduled for production in the next 1-3 months; tab 'backlog' is all open orders requested in the next 1-12 months. Each row says whether its parts are covered by stock and inbound supply, and which parts are short.",
        CustomerOrdersInput,
        list_customer_orders,
    ),
    Tool(
        "get_demand_forecast",
        "The demand model: forecast tractors per month for the next 12 months with an 80% interval and how many are already booked, plus which candidate model won the backtest and its error.",
        ModelFilter,
        get_demand_forecast,
    ),
    Tool(
        "get_supplier_delays",
        "The supplier delay model: mean and 90th-percentile days late per supplier and quarter, on-time rate, the dataset's own mean delay for comparison, and open supply orders with their late-risk (chance of arriving after the part runs out).",
        DelayInput,
        get_supplier_delays,
    ),
    Tool(
        "get_component_failures",
        "The component failure model: failure rate with a 90% interval for each part and supplier, against the dataset's rate for that tractor model, where failures were found (receiving, assembly, field), and expected broken parts in the next three months of builds.",
        FailureInput,
        get_component_failures,
    ),
    Tool(
        "get_inventory_recommendations",
        "The inventory strategy model: for each part, order / ok / excess, the quantity, the supplier with the lowest cost after failures and delay, spend, reorder point, target, stock on hand and on order, and the reason.",
        InventoryInput,
        get_inventory_recommendations,
    ),
    Tool(
        "query_market_signals",
        "Aggregates over the market data (10,000 rows covering the four years up to yesterday): demand units, supplier delay days, failure rate, inventory levels, inflation and market trend index, grouped one way and optionally filtered.",
        MarketInput,
        query_market_signals,
    ),
    Tool(
        "get_weekly_brief",
        "The latest weekly brief written by the weekly job, with the facts it was written from.",
        NoInput,
        get_weekly_brief,
    ),
    Tool(
        "propose_supply_order",
        "Draft supply orders for the user to confirm. It does NOT place anything: the chat shows a confirm button. Either pass lines (sku and quantity, optional warehouse and supplier), or pass customer_order_ids to cover those orders' part shortfalls. Use get_inventory_recommendations first to pick quantities and suppliers.",
        ProposalInput,
        propose_supply_order,
    ),
]
TOOL_MAP = {t.name: t for t in TOOLS}


def execute_tool(name: str, raw_input: Any) -> tuple[bool, Any]:
    """Validate the input against the tool's schema, run it, and return (ok, result)."""
    t = TOOL_MAP.get(name)
    if not t:
        return False, {"error": f"No tool named {name}"}
    try:
        parsed = t.schema.model_validate(raw_input or {})
    except ValidationError as e:
        return False, {"error": f"Invalid input: {e.errors(include_url=False)}"}
    try:
        return True, t.run(parsed)
    except Exception as e:  # noqa: BLE001 - a tool error goes back to the model as an error result
        return False, {"error": str(e)}
