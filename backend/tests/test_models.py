"""Model tests. They run against the seeded test database and check two things:

  1. each model beats its simple baseline on data it did not see
  2. each effect planted by the generator (supply/planted.py) is recovered

The second is the stronger test: the provided dataset has no signal of its own, so a model
that passes has found something real in the operational history.
"""

from supply import planted


def test_demand_beats_trailing_average_and_same_month_last_year(results):
    d = results["demand"]
    b = d["metrics"]["backtest"]
    chosen = b[d["metrics"]["chosen"]]
    assert chosen["mape"] < b["trailing_mean"]["mape"], (chosen, b["trailing_mean"])
    assert chosen["mape"] < b["seasonal_naive"]["mape"], (chosen, b["seasonal_naive"])


def test_demand_recovers_the_planted_spring_peak(results):
    def total(months: list[str]) -> float:
        return sum(f["units"] for m in results["demand"]["output"]["perModel"] for f in m["forecast"] if f["ym"][5:] in months)

    spring = total(["03", "04", "05"])
    winter = total(["01", "11", "12"])
    s = planted.SEASONAL
    planted_ratio = (s[2] + s[3] + s[4]) / (s[0] + s[10] + s[11])
    assert spring / winter > 1 + (planted_ratio - 1) * 0.6, (spring / winter, planted_ratio)


def test_the_provided_market_data_carries_no_demand_signal_on_its_own(results):
    diag = results["demand"]["metrics"]["diagnostics"]
    assert abs(diag["corrDemandVsTrendIndex"]) < 0.2
    assert abs(diag["corrDemandVsInflation"]) < 0.2


def test_supplier_delay_beats_the_overall_mean_and_the_dataset_supplier_means(results):
    b = results["supplier_delay"]["metrics"]["backtest"]
    assert b["model_mae"] < b["overall_mean_mae"], b
    assert b["model_mae"] < b["dataset_supplier_mean_mae"], b


def test_supplier_delay_recovers_supplier_b_as_fastest_and_supplier_d_slow_q4(results):
    suppliers = results["supplier_delay"]["output"]["suppliers"]
    assert min(suppliers, key=lambda s: s["meanDelay"])["supplier"] == "Supplier B"
    d = next(s for s in suppliers if s["supplier"] == "Supplier D")["byQuarter"]
    other_quarters = (d[0] + d[1] + d[2]) / 3
    assert d[3] > other_quarters * 1.15, (d[3], other_quarters)


def test_component_failure_beats_the_dataset_rate_on_held_out_lots(results):
    b = results["component_failure"]["metrics"]["backtest"]
    assert b["model_mae_units"] < b["dataset_rate_mae_units"], b


def test_component_failure_flags_supplier_e_pumps_and_tx400_transmissions_and_little_else(results):
    flagged = [f"{e['sku']}|{e['supplier']}" for e in results["component_failure"]["output"]["elevated"]]
    for m in ["100", "200", "300", "400", "500"]:
        assert f"HYD-{m}|Supplier E" in flagged, f"HYD-{m} from Supplier E not flagged"
    assert any(f.startswith("TRN-400|") for f in flagged), "TX-400 transmissions not flagged"
    unplanted = [f for f in flagged if not f.startswith("HYD-") and not f.startswith("TRN-400|")]
    assert len(unplanted) <= 1, unplanted


def test_inventory_strategy_never_buys_hydraulic_pumps_from_supplier_e(results):
    for row in results["inventory_strategy"]["output"]["rows"]:
        if row["sku"].startswith("HYD-"):
            assert row["supplier"] != "Supplier E", row["sku"]


def test_every_order_recommendation_brings_stock_back_above_its_reorder_point(results):
    for row in results["inventory_strategy"]["output"]["rows"]:
        if row["action"] == "order":
            fr = next(o for o in row["options"] if o["supplier"] == row["supplier"])["failureRate"]
            assert row["position"] + row["quantity"] * (1 - fr) >= row["reorderPoint"], row["sku"]
