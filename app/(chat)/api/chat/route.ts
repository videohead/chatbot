import { geolocation, ipAddress } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  isStepCount,
  pruneMessages,
  streamText,
  toUIMessageStream,
  type ModelMessage,
} from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import {
  allowedModelIds,
  chatModels,
  DEFAULT_CHAT_MODEL,
  getCapabilities,
  getModelAvailability,
} from "@/lib/ai/models";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { connectMcpTools } from "@/lib/ai/mcp";
import { createDocument } from "@/lib/ai/tools/create-document";
import { editDocument } from "@/lib/ai/tools/edit-document";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { updateDocument } from "@/lib/ai/tools/update-document";
import { isProductionEnvironment } from "@/lib/constants";
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  saveChat,
  saveMessages,
  updateChatTitleById,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import { checkIpRateLimit } from "@/lib/ratelimit";
import type { ChatMessage, WaitingStatusData } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

// Next.js requires a static literal here; long-running agent runs need the headroom.
export const maxDuration = 3600;

const HEALTH_CHECK_DELAY_MS = 9000;
const MODEL_CONTEXT_WINDOW_TOKENS = Number.parseInt(
  process.env.OPENHARNESS_CONTEXT_WINDOW_TOKENS ?? "131072",
  10
);
const MODEL_OUTPUT_TOKENS = Number.parseInt(
  process.env.OPENHARNESS_MAX_OUTPUT_TOKENS ?? "8192",
  10
);
// Reserve for the system prompt, tool schemas, and JSON framing. MCP tool
// definitions can be large and are not counted by estimateTokenCount().
const CONTEXT_OVERHEAD_TOKENS = Number.parseInt(
  process.env.OPENHARNESS_CONTEXT_OVERHEAD_TOKENS ?? "32768",
  10
);
const CONTEXT_SAFETY_MARGIN_TOKENS = Number.parseInt(
  process.env.OPENHARNESS_CONTEXT_SAFETY_MARGIN_TOKENS ?? "8192",
  10
);
const DEFAULT_CONTEXT_INPUT_TOKENS =
  MODEL_CONTEXT_WINDOW_TOKENS -
  MODEL_OUTPUT_TOKENS -
  CONTEXT_OVERHEAD_TOKENS -
  CONTEXT_SAFETY_MARGIN_TOKENS;
const MAX_CONTEXT_INPUT_TOKENS = Math.min(
  Number.parseInt(
    process.env.OPENHARNESS_AUTO_COMPACT_THRESHOLD_TOKENS ??
      String(DEFAULT_CONTEXT_INPUT_TOKENS),
    10
  ),
  DEFAULT_CONTEXT_INPUT_TOKENS
);
const CONTEXT_COMPACTION_NOTICE =
  "Earlier conversation history was compacted to fit the model context window. Use the recent conversation and saved agent memories for prior details.";

// Cap the size of persisted tool outputs that get re-injected as context on
// every turn. Stored `dynamic-tool` / `tool-*` outputs (execute_command,
// read_repo_file) can be 100-235KB each; a 46-message chat accumulated 3.8MB
// of them, which the whole-history rehydration then re-sent on every request
// until the context window overflowed. Only the most recent tool results are
// useful to the model, so older ones are replaced with a short placeholder.
// The cap scales with the model's context window (pool config) so behavior is
// uniform with the backend tuning.
const TOOL_OUTPUT_KEEP_RECENT = Number.parseInt(
  process.env.OPENHARNESS_TOOL_OUTPUT_KEEP_RECENT ?? "4",
  10
);
const TOOL_OUTPUT_MAX_CHARS = Math.max(
  512,
  Number.parseInt(
    process.env.OPENHARNESS_TOOL_OUTPUT_MAX_CHARS ??
      String(Math.floor(MODEL_CONTEXT_WINDOW_TOKENS / 16)),
    10
  )
);

function isToolPart(part: { type?: string }): boolean {
  const t = part.type ?? "";
  return t === "dynamic-tool" || t.startsWith("tool-");
}

function truncateToolOutputText(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= TOOL_OUTPUT_MAX_CHARS) {
    return value;
  }
  return `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n\n[…tool output truncated to fit context window…]`;
}

// Truncate the `output.content[].text` payload of tool parts older than the
// newest TOOL_OUTPUT_KEEP_RECENT tool messages. Returns the (possibly copied)
// UI messages; recent turns are untouched.
function truncateStaleToolOutputs(uiMessages: ChatMessage[]): ChatMessage[] {
  // Find the indices of messages that contain tool parts, newest first.
  const toolMessageIndexes: number[] = [];
  uiMessages.forEach((msg, i) => {
    if ((msg.parts as { type?: string }[] | undefined)?.some(isToolPart)) {
      toolMessageIndexes.push(i);
    }
  });
  const stale = new Set(toolMessageIndexes.slice(0, Math.max(0, toolMessageIndexes.length - TOOL_OUTPUT_KEEP_RECENT)));
  if (stale.size === 0) {
    return uiMessages;
  }

  return uiMessages.map((msg, i) => {
    if (!stale.has(i)) {
      return msg;
    }
    const parts = (msg.parts as Record<string, unknown>[]).map((part) => {
      if (!isToolPart(part as { type?: string })) {
        return part;
      }
      const output = part.output as { content?: { text?: unknown }[] } | undefined;
      if (!output?.content) {
        return part;
      }
      return {
        ...part,
        output: {
          ...output,
          content: output.content.map((c) =>
            c && typeof c === "object" ? { ...c, text: truncateToolOutputText(c.text) } : c
          ),
        },
      };
    });
    return { ...msg, parts: parts as ChatMessage["parts"] };
  });
}

function isModelStreamActivity(chunk: { type: string }) {
  return !["start", "start-step", "finish-step", "finish", "raw"].includes(
    chunk.type
  );
}

function estimateTokenCount(messages: ModelMessage[]): number {
  // This deliberately overestimates typical Qwen tokenization, including code,
  // so the retained history leaves room for the system prompt and tool schemas.
  return Math.ceil(JSON.stringify(messages).length / 2);
}

function compactTextToTokenBudget(text: string, budgetTokens: number): string {
  if (Math.ceil(text.length / 2) <= budgetTokens) {
    return text;
  }

  const budgetChars = Math.max(512, budgetTokens * 2);
  const notice = "\n\n[OpenHarness Chat compacted earlier content from this oversized message.]\n\n";
  const headChars = Math.max(0, Math.floor((budgetChars - notice.length) * 0.35));
  const tailChars = Math.max(0, budgetChars - notice.length - headChars);
  return `${text.slice(0, headChars)}${notice}${text.slice(-tailChars)}`;
}

function compactMessageContentToTokenBudget(
  message: ModelMessage,
  budgetTokens: number
): ModelMessage {
  const content = message.content;

  if (typeof content === "string") {
    if (message.role === "tool") {
      return message;
    }
    return {
      ...message,
      content: compactTextToTokenBudget(content, budgetTokens),
    } as ModelMessage;
  }

  if (!Array.isArray(content)) {
    return message;
  }

  const remainingBudget = { tokens: budgetTokens };
  return {
    ...message,
    content: content.map((part) => {
      if (!part || typeof part !== "object" || !("text" in part)) {
        return part;
      }
      const text = part.text;
      if (typeof text !== "string") {
        return part;
      }
      const compacted = compactTextToTokenBudget(text, remainingBudget.tokens);
      remainingBudget.tokens = Math.max(
        0,
        remainingBudget.tokens - Math.ceil(compacted.length / 2)
      );
      return { ...part, text: compacted };
    }),
  } as ModelMessage;
}

function compactModelMessages(messages: ModelMessage[]): {
  messages: ModelMessage[];
  instructions?: string;
} {
  const prunedMessages = pruneMessages({
    emptyMessages: "remove",
    messages,
    reasoning: "before-last-message",
    toolCalls: "before-last-8-messages",
  }).filter((message) => message.role !== "system");

  if (estimateTokenCount(prunedMessages) <= MAX_CONTEXT_INPUT_TOKENS) {
    return { messages: prunedMessages };
  }

  let firstRetainedIndex = prunedMessages.length - 1;

  // Retain complete turns from the newest user message backwards. Starting at
  // a user turn prevents orphaning a tool result from its originating call.
  for (let index = prunedMessages.length - 1; index >= 0; index -= 1) {
    if (prunedMessages[index]?.role !== "user") {
      continue;
    }
    const candidateMessages = prunedMessages.slice(index);
    if (estimateTokenCount(candidateMessages) > MAX_CONTEXT_INPUT_TOKENS) {
      break;
    }
    firstRetainedIndex = index;
  }

  return {
    instructions: CONTEXT_COMPACTION_NOTICE,
    messages: compactOversizedRetainedMessages(
      prunedMessages.slice(firstRetainedIndex),
      MAX_CONTEXT_INPUT_TOKENS
    ),
  };
}

function compactOversizedRetainedMessages(
  messages: ModelMessage[],
  budgetTokens: number
): ModelMessage[] {
  if (estimateTokenCount(messages) <= budgetTokens) {
    return messages;
  }

  const retainedMessages = [...messages];
  while (
    retainedMessages.length > 1 &&
    estimateTokenCount(retainedMessages) > budgetTokens
  ) {
    retainedMessages.shift();
  }

  if (estimateTokenCount(retainedMessages) <= budgetTokens) {
    return retainedMessages;
  }

  return retainedMessages.map((message, index) =>
    index === retainedMessages.length - 1
      ? compactMessageContentToTokenBudget(message, Math.floor(budgetTokens * 0.85))
      : message
  );
}

function getStreamContext() {
  try {
    return createResumableStreamContext({ waitUntil: after });
  } catch {
    return null;
  }
}

export { getStreamContext };

function formatChatStreamError(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "The agent stopped responding and was cancelled after a period of inactivity. Please try again.";
  }

  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  const normalizedMessage = message.replace(/\s+/g, " ").slice(0, 500);
  const lowerCaseMessage = normalizedMessage.toLowerCase();

  if (!normalizedMessage || normalizedMessage === "[object Object]") {
    return "The language model request failed without an error message. Check that the configured model service is running and reachable.";
  }
  if (lowerCaseMessage.includes("credit card")) {
    return "AI Gateway requires a valid credit card on file to service requests. Please visit https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card to add a card and unlock your free credits.";
  }
  if (
    lowerCaseMessage.includes("fetch failed") ||
    lowerCaseMessage.includes("econnrefused") ||
    lowerCaseMessage.includes("enotfound") ||
    lowerCaseMessage.includes("network")
  ) {
    return "Unable to reach the configured language model. Check that the model service is running and reachable.";
  }
  if (lowerCaseMessage.includes("401") || lowerCaseMessage.includes("unauthorized")) {
    return "The configured language model rejected the request because its credentials are invalid or missing.";
  }
  if (lowerCaseMessage.includes("403") || lowerCaseMessage.includes("forbidden")) {
    return "The configured language model refused this request. Check the model service permissions.";
  }
  if (lowerCaseMessage.includes("404") || lowerCaseMessage.includes("not found")) {
    return "The configured language model or endpoint was not found. Check the selected model and base URL.";
  }
  if (lowerCaseMessage.includes("429") || lowerCaseMessage.includes("rate limit")) {
    return "The language model is rate-limiting requests. Please wait a moment and try again.";
  }
  if (lowerCaseMessage.includes("timeout") || lowerCaseMessage.includes("timed out")) {
    return "The language model request timed out. The service may be overloaded; please try again.";
  }
  if (/\b5\d\d\b/.test(normalizedMessage)) {
    return `The language model service returned an upstream error: ${normalizedMessage}`;
  }

  return `The language model request failed: ${normalizedMessage}`;
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch {
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const {
      agentMode,
      id,
      message,
      messages,
      selectedChatModel,
      selectedVisibilityType,
    } = requestBody;

    const session = await auth();

    if (!session?.user) {
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    const chatModel = allowedModelIds.has(selectedChatModel)
      ? selectedChatModel
      : DEFAULT_CHAT_MODEL;

    await checkIpRateLimit(ipAddress(request));

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      differenceInHours: 1,
      id: session.user.id,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerHour) {
      return new ChatbotError("rate_limit:chat").toResponse();
    }

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        return new ChatbotError("forbidden:chat").toResponse();
      }
      messagesFromDb = await getMessagesByChatId({ id });
    } else if (message?.role === "user") {
      await saveChat({
        id,
        title: "New chat",
        userId: session.user.id,
        visibility: selectedVisibilityType,
      });
      titlePromise = generateTitleFromUserMessage({ message });
    }

    let uiMessages: ChatMessage[];

    if (isToolApprovalFlow && messages) {
      const dbMessages = convertToUIMessages(messagesFromDb);
      const approvalStates = new Map(
        messages.flatMap(
          (m) =>
            m.parts
              ?.filter(
                (p: Record<string, unknown>) =>
                  p.state === "approval-responded" ||
                  p.state === "output-denied"
              )
              .map((p: Record<string, unknown>) => [
                String(p.toolCallId ?? ""),
                p,
              ]) ?? []
        )
      );
      uiMessages = dbMessages.map((msg) => ({
        ...msg,
        parts: msg.parts.map((part) => {
          if (
            "toolCallId" in part &&
            approvalStates.has(String(part.toolCallId))
          ) {
            return { ...part, ...approvalStates.get(String(part.toolCallId)) };
          }
          return part;
        }),
      })) as ChatMessage[];
    } else {
      uiMessages = [
        ...convertToUIMessages(messagesFromDb),
        message as ChatMessage,
      ];
    }

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      city,
      country,
      latitude,
      longitude,
    };

    if (message?.role === "user") {
      await saveMessages({
        messages: [
          {
            attachments: [],
            chatId: id,
            createdAt: new Date(),
            id: message.id,
            parts: message.parts,
            role: "user",
          },
        ],
      });
    }

    const modelConfig = chatModels.find((m) => m.id === chatModel);
    const modelCapabilities = await getCapabilities();
    const capabilities = modelCapabilities[chatModel];
    const isReasoningModel = capabilities?.reasoning === true;
    const supportsTools = capabilities?.tools === true;

    const truncatedUiMessages = truncateStaleToolOutputs(uiMessages);
    const convertedModelMessages = await convertToModelMessages(truncatedUiMessages, {
      // A timed-out MCP call can leave an input-available tool part in the
      // persisted assistant message. It has no valid tool result to resend.
      ignoreIncompleteToolCalls: true,
    });
    const compactedModelMessages = compactModelMessages(convertedModelMessages);
    const modelMessages = compactedModelMessages.messages;

    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        const modelName = modelConfig?.name ?? chatModel;
        let hasModelActivity = false;
        let healthCheckTimer: ReturnType<typeof setInterval> | undefined;

        const clearHealthCheckTimer = () => {
          if (healthCheckTimer) {
            clearInterval(healthCheckTimer);
          }
        };

        const writeWaitingStatus = (
          phase: WaitingStatusData["phase"],
          messageText: string
        ) => {
          if (hasModelActivity && phase !== "thinking") {
            return;
          }
          dataStream.write({
            data: {
              message: messageText,
              modelId: chatModel,
              modelName,
              phase,
            },
            transient: true,
            type: "data-waiting-status",
          });
        };

        writeWaitingStatus("waiting", "Waiting...");

        // Recurs so the status stays fresh right up until the chunkMs
        // timeout aborts the run, instead of going stale after one check.
        healthCheckTimer = setInterval(() => {
          getModelAvailability(chatModel)
            .then((availability) => {
              if (availability === "impacted") {
                writeWaitingStatus(
                  "health",
                  `${modelName} may be slow or unavailable right now...`
                );
              } else {
                writeWaitingStatus("still-waiting", "Still waiting...");
              }
            })
            .catch(() => {
              writeWaitingStatus("still-waiting", "Still waiting...");
            });
        }, HEALTH_CHECK_DELAY_MS);

        const markModelActive = () => {
          if (hasModelActivity) {
            return;
          }
          hasModelActivity = true;
          clearHealthCheckTimer();
          writeWaitingStatus("thinking", "Thinking...");
        };

        const stopWaitingStatus = () => {
          hasModelActivity = true;
          clearHealthCheckTimer();
        };

        const mcpSession = supportsTools ? await connectMcpTools() : undefined;
        const hasMcpTools = Boolean(
          mcpSession && Object.keys(mcpSession.tools).length > 0
        );
        const mcpToolNames = Object.keys(mcpSession?.tools ?? {});
        console.info("Chat MCP diagnostics", {
          agentMode,
          hasDefaultFilesystem: [
            "filesystem:read_file",
            "filesystem:write_file",
            "filesystem:update_file",
            "filesystem:delete_path",
          ].every((toolName) => mcpToolNames.includes(toolName)),
          mcpToolCount: mcpToolNames.length,
          model: chatModel,
          supportsTools,
        });

        const result = streamText({
          // Omitted entirely when tools are usable, so MCP gateway tools stay active.
          ...(isReasoningModel && !supportsTools
            ? { activeTools: [] as const }
            : {}),
          instructions: [
            systemPrompt({
              agentMode,
              requestHints,
              supportsMcp: hasMcpTools,
              supportsTools,
            }),
            compactedModelMessages.instructions,
          ]
            .filter(Boolean)
            .join("\n\n"),
          messages: modelMessages,
          model: getLanguageModel(chatModel),
          maxOutputTokens: MODEL_OUTPUT_TOKENS,
          onAbort() {
            stopWaitingStatus();
            void mcpSession?.close();
          },
          onChunk({ chunk }) {
            if (isModelStreamActivity(chunk)) {
              markModelActive();
            }
          },
          onEnd() {
            stopWaitingStatus();
            void mcpSession?.close();
          },
          onError() {
            stopWaitingStatus();
            void mcpSession?.close();
          },
          providerOptions: {
            ...(modelConfig?.gatewayOrder && {
              gateway: { order: modelConfig.gatewayOrder },
            }),
            ...(modelConfig?.reasoningEffort && {
              openai: { reasoningEffort: modelConfig.reasoningEffort },
            }),
          },
          stopWhen: isStepCount(
            Number.parseInt(process.env.MAX_AGENT_STEPS ?? "25", 10)
          ),
          telemetry: {
            functionId: "stream-text",
            isEnabled: isProductionEnvironment,
          },
          // Aborts a stalled run instead of hanging silently until maxDuration:
          // no stream chunk for chunkMs, or a single tool stuck for toolMs.
          timeout: {
            chunkMs: 60_000,
            toolMs: 5 * 60_000,
            totalMs: maxDuration * 1000,
          },
          tools: {
            ...mcpSession?.tools,
            createDocument: createDocument({
              dataStream,
              modelId: chatModel,
              session,
            }),
            editDocument: editDocument({ dataStream, session }),
            getWeather,
            requestSuggestions: requestSuggestions({
              dataStream,
              modelId: chatModel,
              session,
            }),
            updateDocument: updateDocument({
              dataStream,
              modelId: chatModel,
              session,
            }),
          },
        });

        dataStream.merge(
          toUIMessageStream({
            sendReasoning: isReasoningModel,
            stream: result.stream,
            // Default onError sanitizes to "An error occurred." and hides the
            // real cause from server logs. Log the underlying error and rethrow
            // it so the outer handler can format it.
            onError: (error) => {
              console.error("Model stream error:", error);
              throw error;
            },
          })
        );

        if (titlePromise) {
          try {
            const title = await titlePromise;
            dataStream.write({ data: title, type: "data-chat-title" });
            updateChatTitleById({ chatId: id, title });
          } catch {
            /* non-fatal */
          }
        }
      },
      generateId: generateUUID,
      onEnd: async ({ messages: finishedMessages }) => {
        if (isToolApprovalFlow) {
          await Promise.all(
            finishedMessages.map(async (finishedMsg) => {
              const existingMsg = uiMessages.find(
                (m) => m.id === finishedMsg.id
              );
              if (existingMsg) {
                await updateMessage({
                  id: finishedMsg.id,
                  parts: finishedMsg.parts,
                });
                return;
              }

              await saveMessages({
                messages: [
                  {
                    attachments: [],
                    chatId: id,
                    createdAt: new Date(),
                    id: finishedMsg.id,
                    parts: finishedMsg.parts,
                    role: finishedMsg.role,
                  },
                ],
              });
            })
          );
        } else if (finishedMessages.length > 0) {
          await saveMessages({
            messages: finishedMessages.map((currentMessage) => ({
              attachments: [],
              chatId: id,
              createdAt: new Date(),
              id: currentMessage.id,
              parts: currentMessage.parts,
              role: currentMessage.role,
            })),
          });
        }
      },
      onError: (error) => {
        console.error("Chat stream error:", error);
        return formatChatStreamError(error);
      },
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
    });

    return createUIMessageStreamResponse({
      async consumeSseStream({ stream: sseStream }) {
        if (!process.env.REDIS_URL) {
          return;
        }
        try {
          const streamContext = getStreamContext();
          if (streamContext) {
            const streamId = generateId();
            await createStreamId({ chatId: id, streamId });
            await streamContext.createNewResumableStream(
              streamId,
              () => sseStream
            );
          }
        } catch {
          /* non-critical */
        }
      },
      stream,
    });
  } catch (error) {
    const vercelId = request.headers.get("x-vercel-id");

    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    if (
      error instanceof Error &&
      error.message?.includes(
        "AI Gateway requires a valid credit card on file to service requests"
      )
    ) {
      return new ChatbotError("bad_request:activate_gateway").toResponse();
    }

    console.error("Unhandled error in chat API:", error, { vercelId });
    return new ChatbotError("offline:chat").toResponse();
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError("bad_request:api").toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatbotError("unauthorized:chat").toResponse();
  }

  const chat = await getChatById({ id });

  if (chat?.userId !== session.user.id) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
