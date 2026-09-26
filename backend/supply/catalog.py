"""The fixed catalog: tractor models, their bill of materials, suppliers and warehouses.

Model codes, supplier codes and warehouse codes are the ones in data/market_signals.csv.
"""

from .prng import js_round

TRACTOR_MODELS = [
    {"code": "TX-100", "name": "Compact utility", "horsepower": 25, "listPrice": 28_000, "buildDays": 5},
    {"code": "TX-200", "name": "Utility", "horsepower": 60, "listPrice": 58_000, "buildDays": 7},
    {"code": "TX-300", "name": "Mid row-crop", "horsepower": 130, "listPrice": 145_000, "buildDays": 10},
    {"code": "TX-400", "name": "Row-crop", "horsepower": 230, "listPrice": 265_000, "buildDays": 14},
    {"code": "TX-500", "name": "Four-wheel drive", "horsepower": 420, "listPrice": 480_000, "buildDays": 18},
]
MODEL_CODES = [m["code"] for m in TRACTOR_MODELS]
BUILD_DAYS = {m["code"]: m["buildDays"] for m in TRACTOR_MODELS}

SUPPLIERS = [{"code": f"Supplier {c}", "slug": c.lower(), "name": f"Supplier {c}"} for c in "ABCDE"]
SUPPLIER_CODES = [s["code"] for s in SUPPLIERS]

WAREHOUSES = [
    {"code": "CA", "name": "Fresno, CA"},
    {"code": "FL", "name": "Lakeland, FL"},
    {"code": "IL", "name": "Peoria, IL"},
    {"code": "NY", "name": "Syracuse, NY"},
    {"code": "TX", "name": "Amarillo, TX"},
]
WAREHOUSE_CODES = [w["code"] for w in WAREHOUSES]

# Ten part categories per tractor. costShare is the share of the list price the part costs;
# suppliers lists who can make it; leadDays is the nominal lead time a supplier quotes.
PART_CATEGORIES = [
    {"key": "ENG", "name": "Engine", "costShare": 0.16, "suppliers": ["Supplier A", "Supplier B", "Supplier D"], "leadDays": 35},
    {"key": "TRN", "name": "Transmission", "costShare": 0.1, "suppliers": ["Supplier B", "Supplier C", "Supplier E"], "leadDays": 30},
    {"key": "HYD", "name": "Hydraulic pump", "costShare": 0.035, "suppliers": ["Supplier C", "Supplier E", "Supplier A"], "leadDays": 21},
    {"key": "FAX", "name": "Front axle", "costShare": 0.04, "suppliers": ["Supplier D", "Supplier A"], "leadDays": 25},
    {"key": "RAX", "name": "Rear axle", "costShare": 0.05, "suppliers": ["Supplier D", "Supplier B"], "leadDays": 25},
    {"key": "CAB", "name": "Cab and ROPS", "costShare": 0.07, "suppliers": ["Supplier E", "Supplier C"], "leadDays": 28},
    {
        "key": "ECU",
        "name": "Engine control unit",
        "costShare": 0.015,
        "suppliers": ["Supplier A", "Supplier C", "Supplier E"],
        "leadDays": 18,
    },
    {"key": "TIR", "name": "Tire set", "costShare": 0.025, "suppliers": ["Supplier B", "Supplier D"], "leadDays": 14},
    {"key": "PTO", "name": "PTO assembly", "costShare": 0.02, "suppliers": ["Supplier C", "Supplier D"], "leadDays": 21},
    {"key": "FUE", "name": "Fuel system", "costShare": 0.012, "suppliers": ["Supplier E", "Supplier A", "Supplier B"], "leadDays": 16},
]

# Supplier price positioning relative to standard cost.
SUPPLIER_PRICE_FACTOR = {"Supplier A": 1.0, "Supplier B": 1.07, "Supplier C": 0.99, "Supplier D": 0.95, "Supplier E": 0.97}


def sku_for(category_key: str, model: str) -> str:
    return f"{category_key}-{model.replace('TX-', '')}"


def build_parts() -> tuple[list[dict], list[dict]]:
    parts: list[dict] = []
    part_suppliers: list[dict] = []
    for m in TRACTOR_MODELS:
        for c in PART_CATEGORIES:
            sku = sku_for(c["key"], m["code"])
            standard_cost = js_round(m["listPrice"] * c["costShare"])
            parts.append(
                {
                    "sku": sku,
                    "tractor_model": m["code"],
                    "category": c["name"],
                    "name": f"{c['name']}, {m['code']}",
                    "qty_per_tractor": 1,
                    "standard_cost": standard_cost,
                }
            )
            for i, s in enumerate(c["suppliers"]):
                part_suppliers.append(
                    {
                        "sku": sku,
                        "supplier": s,
                        "unit_price": js_round(standard_cost * SUPPLIER_PRICE_FACTOR[s] * 100) / 100,
                        "nominal_lead_days": c["leadDays"] + i * 3,
                    }
                )
    return parts, part_suppliers
