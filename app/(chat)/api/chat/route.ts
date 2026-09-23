import { geolocation, ipAddress } from "@vercel/functions";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  dynamicTool,
  generateId,
  hasToolCall,
  isStepCount,
  jsonSchema,
  streamText,
  toUIMessageStream,
} from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import {
  getCapabilities,
  getAllowedModelIds,
  getModelAvailability,
  getModelConfig,
} from "@/lib/ai/litellm";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { createAgentFrameworkTool } from "@/lib/ai/tools/delegate-agent-framework";
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
import { logger } from "@/lib/logger";
import { checkIpRateLimit } from "@/lib/ratelimit";
import type { ChatMessage, WaitingStatusData } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

const HEALTH_CHECK_DELAY_MS = 9000;

const mcpGatewayHandledOutput = {
  status: "handled_by_litellm_mcp_gateway",
};

const stringInputSchema = (required: string[], properties: Record<string, any>) =>
  jsonSchema({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });

const litellmMcpTools = {
  "metis_router-filesystem:execute_command": dynamicTool({
    description: "Execute a shell command through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema(["command"], {
      command: { type: "string" },
      working_dir: { type: "string" },
    }),
  }),
  "metis_router-filesystem:list_directory": dynamicTool({
    description: "List a directory through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema(["path"], { path: { type: "string" } }),
  }),
  "metis_router-filesystem:read_file": dynamicTool({
    description: "Read a file through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema(["file_path"], {
      file_path: { type: "string" },
    }),
  }),
  "metis_router-filesystem:write_file": dynamicTool({
    description: "Write a file through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema(["file_path", "content"], {
      file_path: { type: "string" },
      content: { type: "string" },
      create_dirs: { type: "boolean" },
    }),
  }),
  "metis_router-filesystem:update_file": dynamicTool({
    description: "Update a file through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema(
      ["file_path", "old_string", "new_string"],
      {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      }
    ),
  }),
  "metis_router-filesystem:create_directory": dynamicTool({
    description: "Create a directory through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema(["path"], {
      path: { type: "string" },
      parents: { type: "boolean" },
    }),
  }),
  "metis_router-filesystem:move_path": dynamicTool({
    description: "Move a filesystem path through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema(["source", "destination"], {
      source: { type: "string" },
      destination: { type: "string" },
      overwrite: { type: "boolean" },
    }),
  }),
  "metis_router-filesystem:delete_path": dynamicTool({
    description: "Delete a filesystem path through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema(["path"], {
      path: { type: "string" },
      recursive: { type: "boolean" },
    }),
  }),
  "metis_router-filesystem:filesystem_diagnostics": dynamicTool({
    description: "Run filesystem diagnostics through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema([], {
      path: { type: "string" },
      probe_write: { type: "boolean" },
    }),
  }),
  "metis_router-ubuntu-controller:get_system_info": dynamicTool({
    description: "Get system information through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema([], {}),
  }),
  "metis_router-ubuntu-controller:install_package": dynamicTool({
    description: "Install a package through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema(["package_name"], {
      package_name: { type: "string" },
    }),
  }),
  "metis_router-ubuntu-controller:search_packages": dynamicTool({
    description: "Search packages through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema(["query"], { query: { type: "string" } }),
  }),
  "metis_router-ubuntu-controller:start_background_job": dynamicTool({
    description: "Start a background job through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema(["command"], {
      command: { type: "string" },
      working_dir: { type: "string" },
    }),
  }),
  "metis_router-ubuntu-controller:get_job_status": dynamicTool({
    description: "Get background job status through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema(["job_id"], { job_id: { type: "string" } }),
  }),
  "metis_router-ubuntu-controller:list_background_jobs": dynamicTool({
    description: "List background jobs through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayHandledOutput,
    inputSchema: stringInputSchema([], {}),
  }),
};

const litellmMcpToolNames = Object.keys(litellmMcpTools) as Array<
  keyof typeof litellmMcpTools
>;

function isModelStreamActivity(chunk: { type: string }) {
  return !["start", "start-step", "finish-step", "finish", "raw"].includes(
    chunk.type
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

export async function POST(request: Request) {
  const startedAt = Date.now();
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch {
    logger.warn("chat.post.bad_request", {
      durationMs: Date.now() - startedAt,
    });
    return new ChatbotError("bad_request:api").toResponse();
  }

  try {
    const { id, message, messages, selectedChatModel, selectedVisibilityType } =
      requestBody;

    logger.info("chat.post.start", {
      body: process.env.CHATBOT_LOG_BODIES === "true" ? requestBody : undefined,
      chatId: id,
      hasApprovalMessages: Boolean(messages),
      messageId: message?.id,
      messagePartCount: message?.parts?.length,
      selectedChatModel,
      selectedVisibilityType,
    });

    const [botIdResult, session] = await Promise.all([
      checkBotId().catch(() => null),
      auth(),
    ]);

    if (botIdResult?.isBot) {
      logger.warn("chat.post.rejected", {
        chatId: id,
        durationMs: Date.now() - startedAt,
        reason: "bot-detected",
      });
      return new ChatbotError("forbidden:api").toResponse();
    }

    if (!session?.user) {
      logger.warn("chat.post.rejected", {
        chatId: id,
        durationMs: Date.now() - startedAt,
        reason: "missing-session",
      });
      return new ChatbotError("unauthorized:chat").toResponse();
    }

    const allowedModelIds = await getAllowedModelIds();
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
      logger.warn("chat.post.rejected", {
        chatId: id,
        durationMs: Date.now() - startedAt,
        messageCount,
        reason: "rate-limit",
        userId: session.user.id,
        userType,
      });
      return new ChatbotError("rate_limit:chat").toResponse();
    }

    const isToolApprovalFlow = Boolean(messages);

    const chat = await getChatById({ id });
    let messagesFromDb: DBMessage[] = [];
    let titlePromise: Promise<string> | null = null;

    if (chat) {
      if (chat.userId !== session.user.id) {
        logger.warn("chat.post.rejected", {
          chatId: id,
          durationMs: Date.now() - startedAt,
          reason: "chat-owner-mismatch",
          userId: session.user.id,
        });
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

    const modelConfig = await getModelConfig(chatModel);
    const modelCapabilities = await getCapabilities();
    const capabilities = modelCapabilities[chatModel];
    const isReasoningModel = capabilities?.reasoning === true;
    const supportsTools = capabilities?.tools === true;

    const modelMessages = await convertToModelMessages(uiMessages);

    logger.info("chat.post.model_ready", {
      capability: capabilities,
      chatId: id,
      durationMs: Date.now() - startedAt,
      isReasoningModel,
      modelMessageCount: modelMessages.length,
      requestedModel: selectedChatModel,
      resolvedModel: chatModel,
      supportsTools,
      userId: session.user.id,
    });

    const stream = createUIMessageStream({
      execute: async ({ writer: dataStream }) => {
        const modelName = modelConfig?.name ?? chatModel;
        let hasModelActivity = false;
        let healthCheckTimer: ReturnType<typeof setTimeout> | undefined;

        const clearHealthCheckTimer = () => {
          if (healthCheckTimer) {
            clearTimeout(healthCheckTimer);
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

        healthCheckTimer = setTimeout(() => {
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

        const result = streamText({
          activeTools:
            isReasoningModel && !supportsTools
              ? []
              : [
                  "getWeather",
                  "createDocument",
                  "editDocument",
                  "updateDocument",
                  "requestSuggestions",
                  "delegateToAgentFramework",
                  ...litellmMcpToolNames,
                ],
          instructions: systemPrompt({ requestHints, supportsTools }),
          messages: modelMessages,
          model: getLanguageModel(chatModel),
          onAbort() {
            stopWaitingStatus();
            logger.warn("chat.stream.abort", {
              chatId: id,
              durationMs: Date.now() - startedAt,
              model: chatModel,
            });
          },
          onChunk({ chunk }) {
            if (isModelStreamActivity(chunk)) {
              markModelActive();
            }
            logger.debug("chat.stream.chunk", {
              chatId: id,
              chunkType: chunk.type,
              durationMs: Date.now() - startedAt,
              model: chatModel,
            });
          },
          onEnd() {
            stopWaitingStatus();
            logger.info("chat.stream.end", {
              chatId: id,
              durationMs: Date.now() - startedAt,
              model: chatModel,
            });
          },
          onError(error) {
            stopWaitingStatus();
            logger.error("chat.stream.error", {
              chatId: id,
              durationMs: Date.now() - startedAt,
              error,
              model: chatModel,
            });
          },
          providerOptions: {
            ...(modelConfig?.gatewayOrder && {
              gateway: { order: modelConfig.gatewayOrder },
            }),
            ...(modelConfig?.reasoningEffort && {
              openai: { reasoningEffort: modelConfig.reasoningEffort },
            }),
          },
          stopWhen: [isStepCount(5), hasToolCall(...litellmMcpToolNames)],
          telemetry: {
            functionId: "stream-text",
            isEnabled: isProductionEnvironment,
          },
          tools: {
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
            delegateToAgentFramework: createAgentFrameworkTool(id),
            ...litellmMcpTools,
          },
        });

        dataStream.merge(
          toUIMessageStream({
            sendReasoning: isReasoningModel,
            stream: result.stream,
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
        logger.info("chat.response.end", {
          chatId: id,
          durationMs: Date.now() - startedAt,
          messageCount: finishedMessages.length,
        });

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
        logger.error("chat.response.error", {
          chatId: id,
          durationMs: Date.now() - startedAt,
          error,
        });

        if (
          error instanceof Error &&
          error.message?.includes(
            "AI Gateway requires a valid credit card on file to service requests"
          )
        ) {
          return "AI Gateway requires a valid credit card on file to service requests. Please visit https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card to add a card and unlock your free credits.";
        }
        return "Oops, an error occurred!";
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
      logger.warn("chat.post.chatbot_error", {
        durationMs: Date.now() - startedAt,
        error,
      });
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

    logger.error("chat.post.unhandled_error", {
      durationMs: Date.now() - startedAt,
      error,
      vercelId,
    });
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
