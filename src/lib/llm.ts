// One-shot text completion for the weekly brief. The chatbot's tool loop is in agent/run.ts.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { llmConfig } from "./config";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export async function completeText(system: string, prompt: string): Promise<{ text: string; author: string } | null> {
  const { provider, model } = llmConfig();
  if (provider === "anthropic") {
    const client = new Anthropic();
    const res = await client.messages.create({
      model,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, author: `llm:anthropic/${model}` };
  }
  if (provider === "gemini") {
    const client = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: GEMINI_BASE_URL });
    const res = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });
    return { text: res.choices[0]?.message?.content ?? "", author: `llm:gemini/${model}` };
  }
  return null;
}
