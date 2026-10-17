import { tool } from "ai";
import { z } from "zod";
import { logger } from "@/lib/logger";

const AGENT_FRAMEWORK_URL =
  process.env.AGENT_FRAMEWORK_URL ?? "http://agent-framework:8000";

const agentFrameworkResponseSchema = z.object({
  finish_reason: z.string().nullable().optional(),
  model: z.string().optional(),
  pending_tasks: z.array(z.string()).default([]),
  response: z.string().trim().min(1),
  status: z.enum(["completed", "incomplete"]).optional(),
});

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
      signal: AbortSignal.timeout(510_000),
    });
    const bodyResult: unknown = await response.json();
    if (!response.ok) {
      const parsed = z
        .object({ detail: z.unknown().optional() })
        .safeParse(bodyResult);
      const detail = parsed.success ? parsed.data.detail : undefined;
      if (response.status === 409) {
        logger.warn("agent_framework.delegate.busy", { sessionId });
        return "This conversation already has an active Agent Framework run. No new work was started. Wait for that run's result; do not retry, create a substitute artifact, or claim the service or filesystem is unavailable.";
      }
      throw new Error(
        `Agent Framework returned HTTP ${response.status}: ${JSON.stringify(detail ?? "no error detail")}`
      );
    }
    const result = agentFrameworkResponseSchema.parse(bodyResult);

    const completed =
      result.status === "completed" &&
      result.pending_tasks.length === 0 &&
      result.finish_reason === "stop";
    const log = completed ? logger.info : logger.warn;
    log("agent_framework.delegate.result", {
      durationMs: Date.now() - startedAt,
      finishReason: result.finish_reason,
      model: result.model,
      pendingTaskCount: result.pending_tasks.length,
      sessionId,
      status: completed ? "completed" : "incomplete",
    });
    if (!completed) {
      const pending = result.pending_tasks.length
        ? `\nRemaining tasks:\n${result.pending_tasks.map((task) => `- ${task}`).join("\n")}`
        : "";
      return `The Agent Framework run is incomplete or its completion is unverified (finish reason: ${result.finish_reason ?? "not reported"}). Host changes may already have been applied. This is not proof of a filesystem outage. Report the actual progress and blockers; do not claim the requested work is complete or create a substitute artifact.${pending}\nHarness report:\n${result.response}`;
    }
    return `The Agent Framework run finished. Report only changes and validation evidenced by its final report; do not infer that unmentioned work was completed or create a substitute artifact.\nHarness report:\n${result.response}`;
  } catch (error) {
    logger.error("agent_framework.delegate.error", {
      durationMs: Date.now() - startedAt,
      error,
      sessionId,
    });
    if (error instanceof Error && error.name === "TimeoutError") {
      return "The Agent Framework request timed out. Host changes may already have been applied. Check the session and project before retrying; do not claim the work is complete.";
    }
    return error instanceof Error &&
      error.message.startsWith("Agent Framework returned HTTP")
      ? `${error.message.slice(0, 500)}. The request failed; host changes may already have been applied. Check the session before retrying.`
      : "The Agent Framework request failed because the service could not be reached or returned an invalid response. Completion is unverified; check service logs and the project before retrying.";
  }
}

export function createAgentFrameworkTool(sessionId: string, modelId?: string) {
  let execution: Promise<string> | undefined;
  return tool({
    description:
      "Delegate host project implementation, complex model-broker, MCP, stack-diagnostics, or multiagent work to the Microsoft Agent Framework harness. It can read, edit, and validate host projects. Use direct tools for simple single operations.",
    execute: ({ request }) => {
      if (execution) {
        logger.warn("agent_framework.delegate.duplicate", { sessionId });
        return execution;
      }
      execution = callAgentFramework(request, sessionId, modelId);
      return execution;
    },
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
