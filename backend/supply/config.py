"""Settings read from the environment, with the repo's .env loaded for local runs."""

import json
import os
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
# Local runs read the repo's .env. Existing environment variables win, so Docker and CI settings hold.
load_dotenv(REPO_ROOT / ".env", override=False)

DATA_DIR = Path(os.environ.get("DATA_DIR") or REPO_ROOT / "data")
GENERATED_DIR = DATA_DIR / "generated"


def database_url() -> str:
    url = os.environ.get("DATABASE_URL") or "postgres://supply:supply@localhost:5433/supply"
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix) :]
    return url


def read_meta() -> dict:
    """The planning date and date shift written by the generator (data/generated/meta.json)."""
    try:
        return json.loads((GENERATED_DIR / "meta.json").read_text())
    except (OSError, ValueError):
        return {}


def as_of() -> str:
    """The planning date: APP_AS_OF, else the day the data was generated, else today."""
    return os.environ.get("APP_AS_OF") or read_meta().get("asOf") or date.today().isoformat()


# Base URL the worker uses to reach the mock supplier APIs, which the API service serves.
API_URL = os.environ.get("API_URL") or os.environ.get("APP_URL") or "http://localhost:8000"


def gemini_models() -> list[str]:
    """Each free Gemini model has its own daily request cap. On a 429 the app moves to the next one."""
    first = os.environ.get("GEMINI_MODEL") or "gemini-flash-latest"
    rest = [
        m.strip()
        for m in (os.environ.get("GEMINI_FALLBACK_MODELS") or "gemini-3-flash-preview,gemini-3.1-flash-lite").split(",")
        if m.strip()
    ]
    return [first, *[m for m in rest if m != first]]


def llm_config() -> tuple[str, str]:
    """(provider, model). LLM_PROVIDER forces a provider; otherwise the first key set wins."""
    forced = (os.environ.get("LLM_PROVIDER") or "").strip()
    if forced in ("anthropic", "gemini", "offline"):
        provider = forced
    elif os.environ.get("ANTHROPIC_API_KEY"):
        provider = "anthropic"
    elif os.environ.get("GEMINI_API_KEY"):
        provider = "gemini"
    else:
        provider = "offline"
    if provider == "anthropic":
        model = os.environ.get("ANTHROPIC_MODEL") or "claude-opus-5"
    elif provider == "gemini":
        model = os.environ.get("GEMINI_MODEL") or "gemini-flash-latest"
    else:
        model = "rules"
    return provider, model
