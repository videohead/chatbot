import { auth } from "@/app/(auth)/auth";
import { getAvailableDeploymentIds } from "@/lib/ai/litellm";
import { probeModel } from "@/lib/ai/model-probe";
import { ChatbotError } from "@/lib/errors";
import { logger } from "@/lib/logger";

// Multi-turn capability probe for a single model. This is a diagnostic
// endpoint: it costs three model calls per invocation and is meant for
// operator/curiosity use, not for the chat UI to call on every render.

export const maxDuration = 300;

export async function POST(request: Request) {
  const startedAt = Date.now();
  const session = await auth();

  if (session?.user?.type !== "regular") {
    logger.warn("models.probe.rejected", {
      durationMs: Date.now() - startedAt,
      reason: "unauthorized",
      userType: session?.user?.type,
    });
    return new ChatbotError("unauthorized:api").toResponse();
  }

  let modelId: string | undefined;
  try {
    const body = (await request.json()) as { modelId?: string };
    modelId = typeof body.modelId === "string" ? body.modelId : undefined;
  } catch {
    // fall through to validation below
  }

  if (!modelId) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  // Only probe models the proxy actually serves; do not let this endpoint
  // become a way to request arbitrary provider strings.
  const deploymentIds = await getAvailableDeploymentIds();
  if (!deploymentIds.has(modelId)) {
    logger.warn("models.probe.rejected", {
      durationMs: Date.now() - startedAt,
      modelId,
      reason: "unknown-model",
    });
    return new ChatbotError("bad_request:api").toResponse();
  }

  const result = await probeModel(modelId);

  logger.info("models.probe.completed", {
    durationMs: Date.now() - startedAt,
    modelId,
    score: result.score,
    userId: session.user.id,
    verdict: result.verdict,
  });

  return Response.json(result);
}
