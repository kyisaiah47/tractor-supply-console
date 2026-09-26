"""Unit tests for the stock-out walk and the failure posterior. They need no database rows."""

from supply.models.component_failure import posterior
from supply.models.stock import compute_stockout


def test_failure_interval_contains_the_mean_and_narrows_with_more_data():
    small = posterior({"units": 100, "broken": 5}, 0.05)
    big = posterior({"units": 10_000, "broken": 500}, 0.05)
    lo_s, hi_s = small.interval(0.9)
    lo_b, hi_b = big.interval(0.9)
    assert lo_s < 0.05 < hi_s
    assert lo_b < big.mean() < hi_b
    assert hi_b - lo_b < hi_s - lo_s


def test_a_supplier_with_no_lots_stays_at_the_dataset_rate():
    assert abs(posterior({"units": 0, "broken": 0}, 0.05).mean() - 0.05) < 1e-12


def test_stockout_is_the_build_start_that_first_exceeds_stock_on_hand():
    out = compute_stockout(
        [{"sku": "A", "units": 10}, {"sku": "B", "units": 100}],
        [
            {"sku": "A", "scheduled_start": "2024-01-05", "units": 6},
            {"sku": "A", "scheduled_start": "2024-01-09", "units": 6},
            {"sku": "B", "scheduled_start": "2024-01-05", "units": 6},
        ],
    )
    assert {o["sku"]: o["date"] for o in out} == {"A": "2024-01-09", "B": None}
