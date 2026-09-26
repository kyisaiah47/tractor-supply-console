"""Effects written into the generated dataset on purpose, so the models have signal to find.

The generator reads these values and the model tests check each one is recovered.
"""

# Our order book is this share of the dataset's market-level Demand_Units.
MARKET_SHARE = 0.01

_RAW_SEASONAL = [0.8, 0.9, 1.25, 1.35, 1.2, 0.95, 0.85, 0.9, 1.1, 1.05, 0.8, 0.75]
_SEASONAL_MEAN = sum(_RAW_SEASONAL) / 12

# Spring planting peaks March to May; harvest brings a smaller September bump.
SEASONAL = [x / _SEASONAL_MEAN for x in _RAW_SEASONAL]
GROWTH_PER_YEAR = 0.06

# Supplier B ships 40% faster than the dataset's delays; Supplier D is 40% slower in Q4.
SUPPLIER_DELAY: dict[str, float | dict[str, float]] = {
    "Supplier B": 0.6,
    "Supplier D": {"q4": 1.4},
}

# Hydraulic pumps from Supplier E fail 2.5x as often; TX-400 transmissions 1.8x.
FAILURE = [
    {"category": "HYD", "supplier": "Supplier E", "model": None, "multiplier": 2.5},
    {"category": "TRN", "supplier": None, "model": "TX-400", "multiplier": 1.8},
]

# Share of each future month already booked: 100% this month, falling 7.5 points a month.
BOOKED_DECAY_PER_MONTH = 0.075
BOOKED_FLOOR = 0.2
