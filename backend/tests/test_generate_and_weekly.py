"""The generator is deterministic, and the weekly job keeps one brief per planning week."""

import filecmp
import io
from contextlib import redirect_stdout

from conftest import TEST_AS_OF

from supply.db import one
from supply.generate import generate
from supply.weekly import run_weekly_job


def test_the_generator_gives_the_same_files_for_the_same_planning_date(tmp_path):
    with redirect_stdout(io.StringIO()):
        generate(TEST_AS_OF, tmp_path / "a")
        generate(TEST_AS_OF, tmp_path / "b")
    names = sorted(p.name for p in (tmp_path / "a").iterdir())
    match, mismatch, errors = filecmp.cmpfiles(tmp_path / "a", tmp_path / "b", names, shallow=False)
    assert len(names) == 9 and not mismatch and not errors, (mismatch, errors)


def test_running_the_weekly_job_twice_in_one_week_keeps_one_brief_and_one_run_per_model():
    run_weekly_job(use_llm=False)
    first = one("SELECT id, generated_at FROM weekly_briefs")
    run_weekly_job(use_llm=False)
    counts = one("SELECT (SELECT COUNT(*) FROM weekly_briefs) AS briefs, (SELECT COUNT(*) FROM model_runs) AS runs")
    second = one("SELECT id, generated_at FROM weekly_briefs")
    assert counts == {"briefs": 1, "runs": 4}
    assert first and second
    assert second["id"] == first["id"] and second["generated_at"] > first["generated_at"]
