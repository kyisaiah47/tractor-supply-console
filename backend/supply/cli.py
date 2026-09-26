"""Command line: `supply <command>`.

generate   rebuild data/generated/ from data/market_signals.csv
seed       rebuild the schema, load both datasets, run the models, write the first brief
setup      generate, then seed
migrate    apply the Alembic migrations
weekly     run the weekly job: the four models, then the weekly brief
worker     run the supply order worker
serve      run the API on port 8000
"""

import argparse
import os
import sys


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="supply", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("generate")
    s = sub.add_parser("seed")
    s.add_argument("--no-models", action="store_true", help="load the data without running the models")
    sub.add_parser("setup")
    sub.add_parser("migrate")
    w = sub.add_parser("weekly")
    w.add_argument("--no-llm", action="store_true", help="write the template brief without calling a model")
    sub.add_parser("worker")
    sv = sub.add_parser("serve")
    sv.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    sv.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    sv.add_argument("--reload", action="store_true")
    a = p.parse_args(argv)

    if a.cmd in ("generate", "setup"):
        from .generate import generate

        generate(os.environ.get("APP_AS_OF") or None)
    if a.cmd in ("seed", "setup"):
        from .seed import seed

        seed(run_models=not getattr(a, "no_models", False))
    elif a.cmd == "migrate":
        from .seed import migrate

        migrate()
    elif a.cmd == "weekly":
        from .weekly import run_weekly_job

        b = run_weekly_job(use_llm=not a.no_llm)
        print(f"weekly brief ({b['author']}) as of {b['asOf']}\n\n{b['body']}")
    elif a.cmd == "worker":
        from .worker import main as worker_main

        worker_main()
    elif a.cmd == "serve":
        import uvicorn

        uvicorn.run("supply.api:app", host=a.host, port=a.port, reload=a.reload)


if __name__ == "__main__":
    main(sys.argv[1:])
