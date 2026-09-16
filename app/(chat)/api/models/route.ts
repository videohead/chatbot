import { auth } from "@/app/(auth)/auth";
import { getCapabilities, getLitellmModels } from "@/lib/ai/litellm";
import { ChatbotError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function GET() {
  const startedAt = Date.now();
  const session = await auth();

  if (session?.user?.type !== "regular") {
    logger.warn("models.get.rejected", {
      durationMs: Date.now() - startedAt,
      reason: "unauthorized",
      userType: session?.user?.type,
    });
    return new ChatbotError("unauthorized:api").toResponse();
  }

  const headers = {
    "Cache-Control": "public, max-age=30, s-maxage=30",
  };

  const [models, capabilities] = await Promise.all([
    getLitellmModels(),
    getCapabilities(),
  ]);

  logger.info("models.get.success", {
    durationMs: Date.now() - startedAt,
    modelCount: models.length,
    userId: session.user.id,
  });

  return Response.json({ capabilities, models }, { headers });
}
