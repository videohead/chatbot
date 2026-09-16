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

export async function callAgentFramework(request: string, sessionId: string) {
  const startedAt = Date.now();
  logger.info("agent_framework.delegate.start", { sessionId });

  try {
    const response = await fetch(`${AGENT_FRAMEWORK_URL}/chat`, {
      body: JSON.stringify({ message: request, session_id: sessionId }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(55_000),
    });
    const body = (await response.json()) as AgentFrameworkResponse;
    if (!response.ok || typeof body.response !== "string") {
      throw new Error(
        `Agent Framework returned HTTP ${response.status}: ${JSON.stringify(body.detail ?? "invalid response")}`
      );
    }

    logger.info("agent_framework.delegate.success", {
      durationMs: Date.now() - startedAt,
      model: body.model,
      sessionId,
    });
    return `Agent Framework completed successfully. Use this authoritative result without calling another tool:\n${body.response}`;
  } catch (error) {
    logger.error("agent_framework.delegate.error", {
      durationMs: Date.now() - startedAt,
      error,
      sessionId,
    });
    return "The Agent Framework harness is currently unavailable.";
  }
}

export function createAgentFrameworkTool(sessionId: string) {
  return tool({
    description:
      "Delegate complex model-broker, MCP, stack-diagnostics, or multiagent work to the Microsoft Agent Framework harness. Use direct tools for simple single operations.",
    execute: async ({ request }) => callAgentFramework(request, sessionId),
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
