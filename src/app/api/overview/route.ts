import { overview } from "@/lib/queries";

// GET /api/overview: the headline counts shown in the console's folio strip.
export async function GET() {
  return Response.json(await overview());
}
