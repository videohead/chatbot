import { auth } from "@/app/(auth)/auth";
import { getMediaModels } from "@/lib/ai/media-models";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json(
    { models: await getMediaModels() },
    { headers: { "Cache-Control": "private, max-age=30" } }
  );
}
