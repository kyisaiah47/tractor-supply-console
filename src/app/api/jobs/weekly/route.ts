import { runWeeklyJob } from "@/lib/weekly";

// POST /api/jobs/weekly: run the four models and write a new weekly brief.
// In production this is called by a scheduler once a week; `npm run job:weekly` does the same.
export async function POST() {
  const t0 = Date.now();
  const brief = await runWeeklyJob({ useLlm: true });
  return Response.json({ ...brief, ms: Date.now() - t0 });
}
