import { tool } from "ai";
import { z } from "zod";
import { logger } from "@/lib/logger";

const AGENT_FRAMEWORK_URL =
  process.env.AGENT_FRAMEWORK_URL ?? "http://agent-framework:8000";

type AgentFrameworkResponse = {
  detail?: unknown;
  model?: string;
  response?: string;
  session_id?: string;
};

export async function callAgentFramework(
  request: string,
  sessionId: string,
  modelId?: string
) {
  const startedAt = Date.now();
  logger.info("agent_framework.delegate.start", { modelId, sessionId });

  try {
    const body: Record<string, string> = {
      message: request,
      session_id: sessionId,
    };
    if (modelId) {
      body.model = modelId;
    }

    const response = await fetch(`${AGENT_FRAMEWORK_URL}/chat`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(120_000),
    });
    const result = (await response.json()) as AgentFrameworkResponse;

    if (!response.ok || typeof result.response !== "string") {
      const detail = result.detail ?? "invalid response";
      const detailStr =
        typeof detail === "string" ? detail : JSON.stringify(detail);

      // Detect model incompatibility (no tool support, not available, etc.)
      if (
        detailStr.includes("does not support") ||
        detailStr.includes("not found") ||
        detailStr.includes("Connection error") ||
        detailStr.includes("Received Model Group")
      ) {
        return `The Agent Framework could not use the model "${modelId ?? "default"}". ${detailStr.slice(0, 200)}. Try selecting a different model that supports tool use.`;
      }

      throw new Error(
        `Agent Framework returned HTTP ${response.status}: ${JSON.stringify(detail)}`
      );
    }

    logger.info("agent_framework.delegate.success", {
      durationMs: Date.now() - startedAt,
      model: result.model,
      sessionId,
    });
    return `Agent Framework completed successfully. Use this authoritative result without calling another tool:\n${result.response}`;
  } catch (error) {
    logger.error("agent_framework.delegate.error", {
      durationMs: Date.now() - startedAt,
      error,
      sessionId,
    });
    return "The Agent Framework harness is currently unavailable.";
  }
}

export function createAgentFrameworkTool(
  sessionId: string,
  modelId?: string
) {
  return tool({
    description:
      "Delegate complex model-broker, MCP, stack-diagnostics, or multiagent work to the Microsoft Agent Framework harness. Use direct tools for simple single operations.",
    execute: async ({ request }) =>
      callAgentFramework(request, sessionId, modelId),
    inputSchema: z.object({
      request: z
        .string()
        .min(1)
        .describe(
          "A complete, self-contained request for the multiagent harness."
        ),
    }),
  });
}
