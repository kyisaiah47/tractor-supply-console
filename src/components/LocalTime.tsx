"use client";

import { useSyncExternalStore } from "react";
import { stamp } from "@/lib/format";

const noSubscribe = () => () => {};

// A timestamp in the viewer's own time zone. The server may run in another zone (UTC in Docker),
// so the time is written only in the browser; the server renders an empty <time> to hydrate against.
export function LocalTime({ iso }: { iso: string | null }) {
  const inBrowser = useSyncExternalStore(noSubscribe, () => true, () => false);
  return <time dateTime={iso ?? undefined}>{inBrowser ? stamp(iso) : ""}</time>;
}
