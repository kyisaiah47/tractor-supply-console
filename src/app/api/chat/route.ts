import { z } from "zod";
import { runAgent, type AgentEvent } from "@/lib/agent/run";

const Body = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .min(1)
    .max(40),
});

// POST /api/chat: the chatbot API. Streams newline-delimited JSON events:
// meta, text, tool_call, tool_result, done, error.
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
  const history = parsed.data.messages.filter((m) => m.content.trim());
  if (history[0]?.role !== "user") return Response.json({ error: "The first message must be from the user" }, { status: 400 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      await runAgent(history, emit);
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}
