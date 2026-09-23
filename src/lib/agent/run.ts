// The chatbot's agent loop. The model answers, calls tools, reads their results and answers
// again, up to MAX_ROUNDS. Every event is streamed to the browser as one JSON line.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { AS_OF, geminiModels, llmConfig } from "../config";
import { GEMINI_BASE_URL } from "../llm";
import { TOOLS, executeTool } from "./tools";
import { runOffline } from "./offline";

export type ChatTurn = { role: "user" | "assistant"; content: string };
export type AgentEvent =
  | { type: "meta"; provider: string; model: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; result: unknown }
  | { type: "done" }
  | { type: "error"; message: string };

const MAX_ROUNDS = 10; // the last round is answered without tools, so a reply always arrives

export const SYSTEM_PROMPT = `You are the planning assistant inside a supply chain console for a tractor manufacturer that builds five models, TX-100 to TX-500, from parts bought from Supplier A to Supplier E and stocked in five warehouses (CA, FL, IL, NY, TX).

The app's clock is ${AS_OF}. History is everything before that date; the open order book and all forecasts are after it.

How to answer:
- Get every number from a tool. Never estimate or invent a figure. If no tool has it, say so.
- The reader is a supply planner, not a developer. Never name a database table, a field, a tool or function, an API or a statistical method. Say "the demand forecast", "the supplier delay forecast", "market data", "order history".
- Keep answers short: one fact per sentence, plain words. Use a small markdown table when comparing more than three rows.
- Call each tool once with the widest filter you need. get_supplier_delays with no supplier returns every supplier at once.
- When the user asks you to draft, order, buy or reorder anything, call propose_supply_order in the same turn with the quantities and suppliers from get_inventory_recommendations. It only drafts: the user must press Confirm. Never say an order was placed.
- Market data on its own predicts little: market demand does not move with the trend index or inflation, and every supplier averages about the same delay there. The forecasts rely on the company's own order and supply history. Say this if asked why a forecast uses one input and not another.`;

type Emit = (e: AgentEvent) => void;

export async function runAgent(history: ChatTurn[], emit: Emit) {
  const { provider, model } = llmConfig();
  emit({ type: "meta", provider, model });
  let wroteText = false;
  const tracked: Emit = (e) => {
    if (e.type === "text") wroteText = true;
    emit(e);
  };
  try {
    if (provider === "anthropic") await runAnthropic(history, model, tracked);
    else if (provider === "gemini") await runGemini(history, model, tracked);
    else await runOffline(history, tracked);
    emit({ type: "done" });
  } catch (e) {
    console.error(`[chat] ${provider}/${model} failed:`, e instanceof Error ? e.message : e);
    // A rate limit or outage before any answer: answer from the console's own lookups instead.
    if (!wroteText && provider !== "offline") {
      try {
        emit({ type: "text", text: "The language model is busy right now, so this answer comes straight from the console's data.\n\n" });
        await runOffline(history, emit);
        emit({ type: "done" });
        return;
      } catch {
        // fall through to the plain error
      }
    }
    emit({ type: "error", message: "The assistant could not finish that answer. Try again in a moment." });
  }
}

async function runAnthropic(history: ChatTurn[], model: string, emit: Emit) {
  const client = new Anthropic();
  const tools: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.jsonSchema as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  }));
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((h) => ({ role: h.role, content: h.content }));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools,
      ...(last ? { tool_choice: { type: "none" as const } } : {}),
      messages,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") emit({ type: "text", text: ev.delta.text });
    }
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") {
      emit({ type: "text", text: "\n\nThe model declined to answer that." });
      return;
    }
    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || !uses.length) return;

    messages.push({ role: "assistant", content: msg.content });
    const results = await Promise.all(
      uses.map(async (u) => {
        emit({ type: "tool_call", id: u.id, name: u.name, input: u.input });
        const r = await executeTool(u.name, u.input);
        emit({ type: "tool_result", id: u.id, name: u.name, ok: r.ok, result: r.result });
        return {
          type: "tool_result" as const,
          tool_use_id: u.id,
          content: JSON.stringify(r.result),
          is_error: !r.ok,
        };
      }),
    );
    messages.push({ role: "user", content: results });
  }
}

async function runGemini(history: ChatTurn[], _model: string, emit: Emit) {
  const client = new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: GEMINI_BASE_URL, maxRetries: 1 });
  const models = geminiModels();
  let mi = 0;
  const tools: OpenAI.Chat.ChatCompletionTool[] = TOOLS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.jsonSchema },
  }));
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((h) => ({ role: h.role, content: h.content }) as OpenAI.Chat.ChatCompletionMessageParam),
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;
    let stream;
    for (;;) {
      try {
        stream = await client.chat.completions.create({
          model: models[mi],
          messages,
          tools,
          stream: true,
          ...(last ? { tool_choice: "none" as const } : {}),
        });
        break;
      } catch (e) {
        if (e instanceof OpenAI.RateLimitError && mi < models.length - 1) {
          console.warn(`[chat] ${models[mi]} is over its free quota, trying ${models[mi + 1]}`);
          mi++;
          continue;
        }
        throw e;
      }
    }
    let text = "";
    // Gemini 3 models return a thought signature on each tool call that must be sent back.
    const calls: { id: string; name: string; args: string; extra?: unknown }[] = [];
    for await (const chunk of stream) {
      const d = chunk.choices[0]?.delta;
      if (!d) continue;
      if (d.content) {
        text += d.content;
        emit({ type: "text", text: d.content });
      }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { id: tc.id ?? `call_${round}_${i}`, name: "", args: "" };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
        const extra = (tc as { extra_content?: unknown }).extra_content;
        if (extra) calls[i].extra = extra;
      }
    }
    const real = calls.filter(Boolean);
    if (!real.length) return;
    messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: real.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args || "{}" },
        ...(c.extra ? { extra_content: c.extra } : {}),
      })),
    });
    for (const c of real) {
      let input: unknown = {};
      try {
        input = JSON.parse(c.args || "{}");
      } catch {
        input = {};
      }
      emit({ type: "tool_call", id: c.id, name: c.name, input });
      const r = await executeTool(c.name, input);
      emit({ type: "tool_result", id: c.id, name: c.name, ok: r.ok, result: r.result });
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(r.result) });
    }
  }
}
