"""The golden set: every recorded answer passes all four checks. No model is called."""

import json
from pathlib import Path

import pytest

from evals import checks

HERE = Path(__file__).parent
CASES = [json.loads(line) for line in (HERE / "golden.jsonl").read_text().splitlines() if line.strip()]


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_golden_case(case):
    evs = checks.events(HERE / "transcripts" / f"{case['id']}.jsonl")
    assert evs[-1]["type"] == "done", "the recorded answer did not finish"
    assert checks.answer(evs).strip(), "the recorded answer is empty"
    failures = {name: problems for name, problems in checks.run_all(evs, case).items() if problems}
    assert not failures, failures


def test_every_case_has_a_transcript_and_every_transcript_a_case():
    recorded = {p.stem for p in (HERE / "transcripts").glob("*.jsonl")}
    assert recorded == {c["id"] for c in CASES}


def test_the_golden_set_covers_every_tool_but_the_market_query():
    expected = {t for c in CASES for t in c["expected_tools"]}
    assert checks.TOOLS - expected == {"query_market_signals"}
