"""Record the golden set's transcripts: `uv run python -m evals.record`.

Each case's question goes through the planning assistant against the database in DATABASE_URL,
and the streamed events are written to evals/transcripts/<id>.jsonl. Tool call ids are
renumbered so a re-recording only changes what the assistant actually did.

By default the assistant runs offline (the keyword router), which calls no model. --live records
with the configured model provider instead. That spends model quota, so it is a manual run that
needs Isaiah's approval each time; CI and the eval tests never record.
"""

import argparse
import json
import os
from pathlib import Path

HERE = Path(__file__).parent


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--live", action="store_true", help="record with the configured model provider (needs approval)")
    p.add_argument("--only", nargs="*", help="case ids to record")
    a = p.parse_args()
    if not a.live:
        os.environ["LLM_PROVIDER"] = "offline"

    from supply.agent.run import run_agent

    cases = [json.loads(line) for line in (HERE / "golden.jsonl").read_text().splitlines() if line.strip()]
    (HERE / "transcripts").mkdir(exist_ok=True)
    for case in cases:
        if a.only and case["id"] not in a.only:
            continue
        ids: dict[str, str] = {}
        lines = []
        for ev in run_agent([{"role": "user", "content": case["question"]}], offline_pause=0):
            if "id" in ev:
                ev = {**ev, "id": ids.setdefault(ev["id"], f"call_{len(ids) + 1}")}
            lines.append(json.dumps(ev, default=str, sort_keys=True))
        (HERE / "transcripts" / f"{case['id']}.jsonl").write_text("\n".join(lines) + "\n")
        print(f"recorded {case['id']}: {sum(1 for x in lines if '"tool_call"' in x)} tool calls")


if __name__ == "__main__":
    main()
