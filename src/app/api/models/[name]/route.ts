import { latestRuns, MODEL_SPECS, MODEL_NAMES, type ModelName } from "@/lib/models";

// GET /api/models/:name: one model's spec, metrics and output.
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  if (!MODEL_NAMES.includes(name as ModelName)) {
    return Response.json({ error: `Unknown model. One of: ${MODEL_NAMES.join(", ")}` }, { status: 404 });
  }
  const runs = await latestRuns();
  if (!runs) return Response.json({ error: "No model runs yet. POST /api/jobs/weekly." }, { status: 404 });
  const m = name as ModelName;
  return Response.json({ model: m, spec: MODEL_SPECS[m], ranAt: runs.ranAt, ...runs[m] });
}
