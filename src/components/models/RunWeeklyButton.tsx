"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowsClockwise } from "@phosphor-icons/react";

export function RunWeeklyButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <button
        className="btn small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const res = await fetch("/api/jobs/weekly", { method: "POST" });
                    setBusy(false);
          setMsg(res.ok ? "Forecasts and the weekly brief are up to date." : "The update failed. Try again.");
          router.refresh();
        }}
      >
        <ArrowsClockwise size={14} />
        {busy ? "Updating" : "Update forecasts now"}
      </button>
      {msg && <span className="dim mono" style={{ fontSize: 11 }}>{msg}</span>}
    </span>
  );
}
