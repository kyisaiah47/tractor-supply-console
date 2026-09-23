import { latestRuns, MODEL_SPECS } from "@/lib/models";

// GET /api/models: the latest output of all four models, with their specs.
export async function GET() {
  const runs = await latestRuns();
  if (!runs) return Response.json({ error: "No model runs yet. POST /api/jobs/weekly." }, { status: 404 });
  return Response.json({ specs: MODEL_SPECS, ...runs });
}
