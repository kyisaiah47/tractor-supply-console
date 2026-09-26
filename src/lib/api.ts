// Server-side reads from the Python API. Browser code calls /api/* on this origin instead,
// which next.config.ts rewrites to the same API.

const API_URL = process.env.API_URL ?? "http://localhost:8000";

export async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

// The same read, but a 404 (no model runs or no brief yet) is null rather than an error.
export async function apiOrNull<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}
