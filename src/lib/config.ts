import fs from "node:fs";
import path from "node:path";
import { localToday } from "./dates";

// The planning date: the day the data was generated (data/generated/meta.json), unless
// APP_AS_OF pins another. The generator shifts every dataset date so history ends the day before.
function readMeta(): { asOf?: string; shiftDays?: number; datasetFirst?: string; datasetLast?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/generated/meta.json"), "utf8"));
  } catch {
    return {};
  }
}
export const META = readMeta();
export const AS_OF = process.env.APP_AS_OF || META.asOf || localToday();
export const APP_URL = process.env.APP_URL || "http://localhost:3000";

export type LlmProvider = "anthropic" | "gemini" | "offline";

// Each free Gemini model has its own daily request cap. On a 429 the app moves to the next one.
export function geminiModels(): string[] {
  const first = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const rest = (process.env.GEMINI_FALLBACK_MODELS || "gemini-3-flash-preview,gemini-3.1-flash-lite")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return [first, ...rest.filter((m) => m !== first)];
}

export function llmConfig(): { provider: LlmProvider; model: string } {
  const forced = (process.env.LLM_PROVIDER || "").trim() as LlmProvider | "";
  const provider: LlmProvider =
    forced === "anthropic" || forced === "gemini" || forced === "offline"
      ? forced
      : process.env.ANTHROPIC_API_KEY
        ? "anthropic"
        : process.env.GEMINI_API_KEY
          ? "gemini"
          : "offline";
  const model =
    provider === "anthropic"
      ? process.env.ANTHROPIC_MODEL || "claude-opus-5"
      : provider === "gemini"
        ? process.env.GEMINI_MODEL || "gemini-flash-latest"
        : "rules";
  return { provider, model };
}
