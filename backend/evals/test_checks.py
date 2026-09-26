"""Each check must catch the failure it exists for. These answers are written to fail."""

from evals import checks

RESULT = {
    "suppliers": [{"supplier": "Supplier D", "meanDelay": 15.9, "byQuarter": [14.1, 15.2, 15.1, 19.0]}],
    "rate": 0.1197,
    "spend": 46813063,
}
FORECAST = {"perModel": [{"model": "TX-400", "forecast": [{"units": 70}, {"units": 80}, {"units": 90}]}]}


def transcript(text: str, tools: list[tuple[str, dict]]) -> list[dict]:
    evs: list[dict] = [{"type": "meta", "provider": "anthropic", "model": "claude-opus-5"}]
    for i, (name, result) in enumerate(tools):
        evs.append({"type": "tool_call", "id": f"c{i}", "name": name, "input": {}})
        evs.append({"type": "tool_result", "id": f"c{i}", "name": name, "ok": True, "result": result})
    return [*evs, {"type": "text", "text": text}, {"type": "done"}]


def test_a_grounded_answer_passes_every_check():
    evs = transcript(
        "Supplier D is slowest in Q4 at 19.0 days late, against 15.9 on average. Pumps fail 12.0% of the time. "
        "The plan costs $46,813,063. TX-400 needs 240 tractors over the next 3 months.",
        [("get_supplier_delays", {**RESULT, **FORECAST})],
    )
    assert checks.run_all(evs, {"question": "Which supplier is slowest?", "expected_tools": ["get_supplier_delays"]}) == {
        "expected_tools": [],
        "numbers_grounded": [],
        "no_placed_claim": [],
        "no_internal_names": [],
    }


def test_an_invented_number_is_caught():
    evs = transcript("Supplier D is 22.4 days late in Q4.", [("get_supplier_delays", RESULT)])
    assert checks.numbers_grounded(evs) == ["22.4 is in no tool result"]


def test_a_number_with_no_tool_call_at_all_is_caught():
    assert checks.numbers_grounded(transcript("About 900 parts will break.", [])) == ["900 is in no tool result"]


def test_a_missing_tool_and_an_unasked_draft_are_caught():
    evs = transcript("Here is a draft.", [("get_overview", {}), ("propose_supply_order", {"proposal": True})])
    assert checks.expected_tools(evs, ["get_supplier_delays"]) == ["did not call get_supplier_delays", "drafted an order nobody asked for"]


def test_claiming_a_draft_was_placed_is_caught():
    for text in [
        "I placed the order with Supplier D.",
        "Your orders have been placed.",
        "We've submitted 3 supply orders.",
        "The order was queued.",
    ]:
        assert checks.no_placed_claim(transcript(text, [])), text
    assert not checks.no_placed_claim(transcript("I drafted these orders. Press Confirm to queue them.", []))


def test_naming_a_table_tool_or_method_is_caught():
    found = checks.no_internal_names(
        transcript("I read supply_orders with get_supplier_delays and fitted a beta-binomial posterior with a low MAPE.", [])
    )
    assert "names the table supply_orders" in found
    assert "names the tool get_supplier_delays" in found
    assert any("beta-binomial" in f for f in found) and any("MAPE" in f for f in found)
    assert not checks.no_internal_names(transcript("Hydraulic pumps from Supplier E fail more than other parts.", []))
