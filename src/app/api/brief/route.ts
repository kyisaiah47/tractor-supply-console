import { latestBrief } from "@/lib/weekly";

// GET /api/brief: the latest weekly brief.
export async function GET() {
  const b = await latestBrief();
  if (!b) return Response.json({ error: "No brief yet" }, { status: 404 });
  return Response.json(b);
}
