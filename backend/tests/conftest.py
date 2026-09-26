"""Test setup. Runs before any supply module is imported.

The tests get their own database, supply_test, on the same server as DATABASE_URL. It is
generated and seeded once per run with a fixed planning date, so figures do not move with the
calendar. Both model API keys are blanked and LLM_PROVIDER is offline, so no test can reach a
paid model: the repo's .env never overrides a variable that is already set.
"""

import io
import os
from contextlib import redirect_stdout
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest

TEST_AS_OF = "2026-09-23"
_base = os.environ.get("DATABASE_URL") or "postgres://supply:supply@localhost:5433/supply"
_parts = urlsplit(_base)
TEST_DB = "supply_test"
os.environ["DATABASE_URL"] = urlunsplit(_parts._replace(path=f"/{TEST_DB}"))
os.environ["APP_AS_OF"] = TEST_AS_OF
os.environ["LLM_PROVIDER"] = "offline"
os.environ["ANTHROPIC_API_KEY"] = ""
os.environ["GEMINI_API_KEY"] = ""
os.environ["OPENAI_API_KEY"] = ""


def _admin_url() -> str:
    return urlunsplit(_parts._replace(scheme="postgresql", path="/postgres"))


@pytest.fixture(scope="session", autouse=True)
def seeded_db(tmp_path_factory):
    with psycopg.connect(_admin_url(), autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)")
        c.execute(f"CREATE DATABASE {TEST_DB}")
    from supply.generate import generate
    from supply.seed import seed

    gen = tmp_path_factory.mktemp("generated")
    with redirect_stdout(io.StringIO()):
        generate(TEST_AS_OF, gen)
        seed(generated_dir=gen)
    yield
    from supply.db import engine

    engine().dispose()


@pytest.fixture(scope="session")
def results(seeded_db):
    from supply.models import run_all_models

    return run_all_models(TEST_AS_OF)
