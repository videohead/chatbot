import { tool, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import { logger } from "@/lib/logger";
import type { ChatMessage } from "@/lib/types";

const AGENT_FRAMEWORK_URL =
  process.env.AGENT_FRAMEWORK_URL ?? "http://agent-framework:8000";

// How often to poll the harness's /runs/{session_id}/progress endpoint while
// the main /chat request is still in flight. The harness loop can run for
// several minutes with nothing but this polling to report back.
const PROGRESS_POLL_INTERVAL_MS = 6000;

const agentFrameworkResponseSchema = z.object({
  finish_reason: z.string().nullable().optional(),
  model: z.string().optional(),
  pending_tasks: z.array(z.string()).default([]),
  response: z.string().trim().min(1),
  status: z.enum(["completed", "incomplete"]).optional(),
});

const agentFrameworkProgressSchema = z.object({
  active: z.boolean().optional(),
  elapsed_s: z.number(),
  iteration: z.number(),
  last_event: z.string(),
  last_tool: z.string().nullable(),
  max_iterations: z.number(),
});

// Upper bound for watching someone else's already-running session via the
// 409 "busy" path. Matches agent-framework-service's own MAX_RUN_SECONDS
// default so we never wait meaningfully longer than the harness itself would
// before giving up on a run.
const BUSY_SESSION_WATCH_TIMEOUT_MS = 480_000;

async function fetchAgentFrameworkProgress(
  sessionId: string
): Promise<{ active: boolean; message: string } | null> {
  try {
    const response = await fetch(
      `${AGENT_FRAMEWORK_URL}/runs/${sessionId}/progress`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!response.ok) {
      return null;
    }
    const parsed = agentFrameworkProgressSchema.safeParse(
      await response.json()
    );
    if (!parsed.success) {
      return null;
    }
    const { active, elapsed_s, iteration, last_event, last_tool, max_iterations } =
      parsed.data;
    const toolSuffix = last_tool ? ` (${last_tool})` : "";
    return {
      active: active ?? true,
      message: `Agent Framework: ${last_event}${toolSuffix} \u2014 step ${iteration}/${max_iterations}, ${Math.round(elapsed_s)}s elapsed`,
    };
  } catch {
    // Progress polling is best-effort; the main /chat request is the source
    // of truth, so a failed poll just means one fewer status update.
    return null;
  }
}

/**
 * Watch an already-running session's progress until it frees up (or we time
 * out), surfacing the same live updates a normal run would. Without this, a
 * duplicate/concurrent delegation that hits the harness's 409 "busy" response
 * returns one static sentence and then the UI goes completely silent for
 * however long the original run takes — indistinguishable from a hang.
 */
async function watchBusySession(
  sessionId: string,
  onProgress?: (message: string) => void
): Promise<"freed" | "timed_out"> {
  const deadline = Date.now() + BUSY_SESSION_WATCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const progress = await fetchAgentFrameworkProgress(sessionId);
    if (progress) {
      onProgress?.(progress.message);
      if (!progress.active) {
        return "freed";
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, PROGRESS_POLL_INTERVAL_MS)
    );
  }
  return "timed_out";
}

export async function callAgentFramework(
  request: string,
  sessionId: string,
  modelId?: string,
  onProgress?: (message: string) => void
) {
  const startedAt = Date.now();
  logger.info("agent_framework.delegate.start", { modelId, sessionId });

  const pollTimer = onProgress
    ? setInterval(() => {
        fetchAgentFrameworkProgress(sessionId).then((progress) => {
          if (progress) {
            onProgress(progress.message);
          }
        });
      }, PROGRESS_POLL_INTERVAL_MS)
    : undefined;

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
        onProgress?.(
          "Agent Framework: waiting for this conversation's already-running delegation to finish..."
        );
        const outcome = await watchBusySession(sessionId, onProgress);
        logger.info("agent_framework.delegate.busy_watch_done", {
          outcome,
          sessionId,
        });
        return outcome === "freed"
          ? "The previously active Agent Framework run for this conversation has now finished. No new work was started for this request. Relay that its result should already be visible above; if this request still needs doing, say so and it will be sent as a new delegation."
          : "The previously active Agent Framework run for this conversation has not finished within the wait window. No new work was started for this request. Do not claim the service or filesystem is unavailable; the original run may still complete separately.";
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
      return `The Agent Framework run is incomplete or its completion is unverified (finish reason: ${result.finish_reason ?? "not reported"}). Host changes may already have been applied. This is not proof of a filesystem outage. Do not claim the requested work is complete, do not create a substitute artifact, and do not retry the same delegation blindly. Relay the harness status report below to the user verbatim, then add one sentence offering to continue the work (a follow-up delegation resumes the same harness session and its remaining tasks).${pending}\nHarness status report:\n${result.response}`;
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
  } finally {
    if (pollTimer) {
      clearInterval(pollTimer);
    }
  }
}

export function createAgentFrameworkTool(
  sessionId: string,
  modelId?: string,
  progress?: {
    dataStream: UIMessageStreamWriter<ChatMessage>;
    modelName: string;
  }
) {
  let execution: Promise<string> | undefined;
  return tool({
    description:
      "Delegate host project implementation, complex model-broker, MCP, stack-diagnostics, or multiagent work to the Microsoft Agent Framework harness. It can read, edit, and validate host projects. Use direct tools for simple single operations.",
    execute: ({ request }) => {
      if (execution) {
        logger.warn("agent_framework.delegate.duplicate", { sessionId });
        return execution;
      }
      const onProgress = progress
        ? (message: string) => {
            progress.dataStream.write({
              data: {
                message,
                modelId: modelId ?? "",
                modelName: progress.modelName,
                phase: "thinking",
              },
              transient: true,
              type: "data-waiting-status",
            });
          }
        : undefined;
      execution = callAgentFramework(request, sessionId, modelId, onProgress);
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
