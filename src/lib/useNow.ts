"use client";

import { useSyncExternalStore } from "react";

// The current time, bucketed to `ms`, so components re-render on a tick without calling
// Date.now() during render. The server snapshot is 0, meaning "unknown".
export function useNow(ms: number) {
  return useSyncExternalStore(
    (cb) => {
      const t = setInterval(cb, ms);
      return () => clearInterval(t);
    },
    () => Math.floor(Date.now() / ms) * ms,
    () => 0,
  );
}

const STORAGE_EVENT = "local-flag";

// A boolean kept in localStorage, readable during render without an effect.
export function useLocalFlag(key: string): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      window.addEventListener(STORAGE_EVENT, cb);
      window.addEventListener("storage", cb);
      return () => {
        window.removeEventListener(STORAGE_EVENT, cb);
        window.removeEventListener("storage", cb);
      };
    },
    () => {
      try {
        return localStorage.getItem(key) === "1";
      } catch {
        return false;
      }
    },
    () => false,
  );
  const set = (v: boolean) => {
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {}
    window.dispatchEvent(new Event(STORAGE_EVENT));
  };
  return [value, set];
}
