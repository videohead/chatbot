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
  type ToolSet,
  toUIMessageStream,
} from "ai";
import { checkBotId } from "botid/server";
import { after } from "next/server";
import { createResumableStreamContext } from "resumable-stream";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import {
  getAllowedModelIds,
  getCapabilities,
  getModelAvailability,
  getModelConfig,
} from "@/lib/ai/litellm";
import {
  normalizeImageSize,
  normalizeVideoQuality,
  supportsImageInput,
  supportsVideoFileInput,
  supportsVideoImageInput,
} from "@/lib/ai/media-settings";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import {
  formatChatMemoryContext,
  searchChatMemory,
  storeChatMemory,
} from "@/lib/ai/chat-memory";
import { createDocument } from "@/lib/ai/tools/create-document";
import { createAgentFrameworkTool } from "@/lib/ai/tools/delegate-agent-framework";
import { editDocument } from "@/lib/ai/tools/edit-document";
import {
  createGenerateImageTool,
  generateImageForChat,
} from "@/lib/ai/tools/generate-image";
import {
  createGenerateVideoTool,
  generateVideo,
} from "@/lib/ai/tools/generate-video";
import { getWeather } from "@/lib/ai/tools/get-weather";
import { requestSuggestions } from "@/lib/ai/tools/request-suggestions";
import { updateDocument } from "@/lib/ai/tools/update-document";
import {
  createWorkspaceTools,
  hasWorkspaceAccess,
} from "@/lib/ai/tools/workspace";
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
import { resolveMediaInputUrl } from "@/lib/media-storage";
import { persistMessageParts } from "@/lib/message-attribution";
import { checkIpRateLimit } from "@/lib/ratelimit";
import type { ChatMessage, WaitingStatusData } from "@/lib/types";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import { generateTitleFromUserMessage } from "../../actions";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 600;

const HEALTH_CHECK_DELAY_MS = 9000;

/**
 * Parse a LiteLLM or streaming error into a concise, user-facing message.
 * LiteLLM wraps upstream failures in deeply nested escaped JSON; this
 * extracts the actionable part so users (and models) can act on it.
 */
function formatStreamError(error: unknown): string {
  const msg =
    error instanceof Error ? error.message : String(error ?? "Unknown error");

  // Model unavailable / connection error
  const modelGroupMatch = msg.match(
    /Received Model Group=(\S+).*?Available Model Group Fallbacks=(\S+)/s
  );
  if (modelGroupMatch) {
    const model = modelGroupMatch[1];
    const fallbacks = modelGroupMatch[2];
    return fallbacks === "None"
      ? `The model "${model}" is currently unavailable and no fallback models are configured. Try selecting a different model.`
      : `The model "${model}" is unavailable. Falling back to: ${fallbacks}.`;
  }

  // LiteLLM internal / connection errors
  if (msg.includes("Connection error") || msg.includes("ConnectionError")) {
    return "The model backend is unreachable. It may be loading or temporarily down. Try again in a moment or choose a different model.";
  }
  if (msg.includes("RateLimitError") || msg.includes("rate_limit")) {
    return "The model provider is rate-limiting requests. Please wait a moment and try again.";
  }
  if (msg.includes("AuthenticationError") || msg.includes("Unauthorized")) {
    return "Authentication with the model provider failed. This is a server configuration issue.";
  }
  if (msg.includes("timeout") || msg.includes("Timeout")) {
    return "The request timed out waiting for the model to respond. Try a shorter prompt or a different model.";
  }
  if (msg.includes("context_length_exceeded") || msg.includes("max_tokens")) {
    return "The conversation is too long for this model's context window. Start a new chat or use a model with a larger context.";
  }

  // MCP / tool errors
  if (msg.includes("MCP") || msg.includes("mcp")) {
    return "A tool call failed through the MCP gateway. The tool server may be temporarily unavailable.";
  }

  // Agent framework errors
  if (msg.includes("Agent Framework") || msg.includes("agent_framework")) {
    return "The Agent Framework harness encountered an error. It may be unavailable or the backing model may be down.";
  }

  // Truncate long messages to something readable
  if (msg.length > 200) {
    return `An error occurred: ${msg.slice(0, 180)}…`;
  }

  return `An error occurred: ${msg}`;
}

const directMcpToolsEnabled =
  process.env.CHATBOT_ENABLE_DIRECT_MCP_TOOLS === "true";
const workspaceToolNames = [
  "gitAuthStatus",
  "gitClone",
  "gitCommit",
  "gitCreateBranch",
  "gitDiff",
  "gitFetch",
  "gitLog",
  "gitPull",
  "gitPush",
  "gitRemoteCheck",
  "gitRepoInfo",
  "gitSetIdentity",
  "gitStage",
  "gitStatus",
  "workspaceList",
  "workspaceRead",
  "workspaceProposePatch",
  "workspaceApplyPatch",
] as const;

function videoStatusModelName(modelId: string) {
  if (modelId.includes("cosmos3-super")) {
    return "Cosmos3 Super";
  }
  if (modelId.includes("cosmos3-nano")) {
    return "Cosmos3 Nano";
  }
  if (modelId.includes("gemini-omni")) {
    return "Gemini Omni Flash Preview";
  }
  if (modelId.includes("veo-3.1")) {
    return "Veo 3.1";
  }
  if (modelId.includes("veo-3.0")) {
    return "Veo 3.0";
  }
  return modelId;
}

type DirectMediaRecord = {
  createdAt: Date;
  input: {
    model: string;
    prompt: string;
    quality?: string;
    size?: string;
    sourceImage?: string;
    sourceVideo?: string;
  };
  kind: "image" | "video";
  messageId: string;
  modelId: string;
  modelName: string;
  toolCallId: string;
};

function directMediaParts(
  record: DirectMediaRecord,
  output?: Record<string, unknown>
): DBMessage["parts"] {
  const model =
    typeof output?.model === "string" ? output.model : record.modelId;
  const modelName =
    typeof output?.modelName === "string" ? output.modelName : record.modelName;
  const toolType =
    record.kind === "image" ? "tool-generateImage" : "tool-generateVideo";

  return [
    { type: "step-start" },
    {
      input: record.input,
      ...(output ? { output } : {}),
      state: output ? "output-available" : "input-available",
      toolCallId: record.toolCallId,
      type: toolType,
    },
    {
      data: { model, modelName },
      type: "data-model-attribution",
    },
  ] as DBMessage["parts"];
}

function hasPendingDirectMedia(messages: DBMessage[]) {
  return messages.some(
    (storedMessage) =>
      storedMessage.role === "assistant" &&
      Array.isArray(storedMessage.parts) &&
      storedMessage.parts.some((part) => {
        if (!part || typeof part !== "object") {
          return false;
        }
        const candidate = part as { state?: unknown; type?: unknown };
        return (
          (candidate.type === "tool-generateImage" ||
            candidate.type === "tool-generateVideo") &&
          (candidate.state === "input-available" ||
            candidate.state === "input-streaming")
        );
      })
  );
}

async function hydrateOwnedMediaForModel(
  messages: ChatMessage[],
  userId: string
) {
  return (await Promise.all(
    messages.map(async (chatMessage) => ({
      ...chatMessage,
      parts: await Promise.all(
        chatMessage.parts.map(async (part) => {
          if (part.type !== "file" || !part.mediaType.startsWith("image/")) {
            return part;
          }
          return {
            ...part,
            url: await resolveMediaInputUrl({
              mediaType: part.mediaType,
              url: part.url,
              userId,
            }),
          };
        })
      ),
    }))
  )) as ChatMessage[];
}

// LiteLLM's MCP gateway executes these server-side for OpenAI-hosted models.
// When a deployment routes the tool call back to the client instead (seen
// with Azure OpenAI deployments), the execute stub below runs and must fail
// loudly: a fake success marker makes the model re-call the tool forever
// until the context window is exhausted.
const MCP_GATEWAY_CLIENT_SIDE_ERROR =
  "This tool call was returned to the chatbot instead of being executed by the LiteLLM MCP gateway. The host filesystem was not touched. Tell the user this tool is unavailable for the current model deployment and answer from conversation context only. Do not call this tool again.";

const mcpGatewayStubExecute = async (toolName: string) => {
  logger.error("chat.tool.gateway_bounce", {
    message: "MCP tool call bounced to client-side stub; failing the call",
    toolName,
  });
  throw new Error(MCP_GATEWAY_CLIENT_SIDE_ERROR);
};

function createMessageMetadataHandler({
  modelId,
  modelName,
}: {
  modelId: string;
  modelName: string;
}) {
  const createdAt = new Date().toISOString();

  return ({ part }: { part: { type: string } }) => {
    if (part.type === "start" || part.type === "finish") {
      return {
        createdAt,
        model: modelId,
        modelName,
      };
    }
  };
}

const stringInputSchema = (
  required: string[],
  properties: Record<string, any>
) =>
  jsonSchema({
    additionalProperties: false,
    properties,
    required,
    type: "object",
  });

const litellmMcpTools = {
  "metis_router-filesystem__create_directory": dynamicTool({
    description: "Create a directory through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-filesystem__create_directory"),
    inputSchema: stringInputSchema(["path"], {
      parents: { type: "boolean" },
      path: { type: "string" },
    }),
  }),
  "metis_router-filesystem__delete_path": dynamicTool({
    description: "Delete a filesystem path through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-filesystem__delete_path"),
    inputSchema: stringInputSchema(["path"], {
      path: { type: "string" },
      recursive: { type: "boolean" },
    }),
  }),
  "metis_router-filesystem__execute_command": dynamicTool({
    description: "Execute a shell command through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-filesystem__execute_command"),
    inputSchema: stringInputSchema(["command"], {
      command: { type: "string" },
      working_dir: { type: "string" },
    }),
  }),
  "metis_router-filesystem__filesystem_diagnostics": dynamicTool({
    description: "Run filesystem diagnostics through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-filesystem__filesystem_diagnostics"),
    inputSchema: stringInputSchema([], {
      path: { type: "string" },
      probe_write: { type: "boolean" },
    }),
  }),
  "metis_router-filesystem__list_directory": dynamicTool({
    description: "List a directory through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-filesystem__list_directory"),
    inputSchema: stringInputSchema(["path"], { path: { type: "string" } }),
  }),
  "metis_router-filesystem__move_path": dynamicTool({
    description: "Move a filesystem path through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-filesystem__move_path"),
    inputSchema: stringInputSchema(["source", "destination"], {
      destination: { type: "string" },
      overwrite: { type: "boolean" },
      source: { type: "string" },
    }),
  }),
  "metis_router-filesystem__read_file": dynamicTool({
    description: "Read a file through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-filesystem__read_file"),
    inputSchema: stringInputSchema(["file_path"], {
      file_path: { type: "string" },
    }),
  }),
  "metis_router-filesystem__update_file": dynamicTool({
    description: "Update a file through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-filesystem__update_file"),
    inputSchema: stringInputSchema(["file_path", "old_string", "new_string"], {
      file_path: { type: "string" },
      new_string: { type: "string" },
      old_string: { type: "string" },
      replace_all: { type: "boolean" },
    }),
  }),
  "metis_router-filesystem__write_file": dynamicTool({
    description: "Write a file through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-filesystem__write_file"),
    inputSchema: stringInputSchema(["file_path", "content"], {
      content: { type: "string" },
      create_dirs: { type: "boolean" },
      file_path: { type: "string" },
    }),
  }),
  "metis_router-ubuntu-controller__get_job_status": dynamicTool({
    description: "Get background job status through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-ubuntu-controller__get_job_status"),
    inputSchema: stringInputSchema(["job_id"], { job_id: { type: "string" } }),
  }),
  "metis_router-ubuntu-controller__get_system_info": dynamicTool({
    description: "Get system information through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-ubuntu-controller__get_system_info"),
    inputSchema: stringInputSchema([], {}),
  }),
  "metis_router-ubuntu-controller__install_package": dynamicTool({
    description: "Install a package through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-ubuntu-controller__install_package"),
    inputSchema: stringInputSchema(["package_name"], {
      package_name: { type: "string" },
    }),
  }),
  "metis_router-ubuntu-controller__list_background_jobs": dynamicTool({
    description: "List background jobs through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-ubuntu-controller__list_background_jobs"),
    inputSchema: stringInputSchema([], {}),
  }),
  "metis_router-ubuntu-controller__search_packages": dynamicTool({
    description: "Search packages through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-ubuntu-controller__search_packages"),
    inputSchema: stringInputSchema(["query"], { query: { type: "string" } }),
  }),
  "metis_router-ubuntu-controller__start_background_job": dynamicTool({
    description: "Start a background job through the LiteLLM MCP gateway.",
    execute: async () => mcpGatewayStubExecute("metis_router-ubuntu-controller__start_background_job"),
    inputSchema: stringInputSchema(["command"], {
      command: { type: "string" },
      working_dir: { type: "string" },
    }),
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
    const {
      generationMode,
      id,
      message,
      messages,
      selectedChatModel,
      selectedImageModel,
      selectedImageSize,
      selectedVideoModel,
      selectedVideoQuality,
      selectedVisibilityType,
    } = requestBody;

    logger.info("chat.post.start", {
      body: process.env.CHATBOT_LOG_BODIES === "true" ? requestBody : undefined,
      chatId: id,
      generationMode,
      hasApprovalMessages: Boolean(messages),
      messageId: message?.id,
      messagePartCount: message?.parts?.length,
      selectedChatModel,
      selectedImageModel,
      selectedImageSize,
      selectedVideoModel,
      selectedVideoQuality,
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

    const workspaceAccess = hasWorkspaceAccess(session);
    const workspaceTools: ToolSet = createWorkspaceTools(session);

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

    if (messageCount >= entitlementsByUserType[userType].maxMessagesPerHour) {
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

    let directMediaRecord: DirectMediaRecord | undefined;
    let directMediaInputImage: string | undefined;
    let directMediaInputVideo: string | undefined;
    const imageSize = normalizeImageSize(selectedImageModel, selectedImageSize);
    const videoQuality = normalizeVideoQuality(
      selectedVideoModel,
      selectedVideoQuality
    );
    if (
      message?.role === "user" &&
      (generationMode === "image" || generationMode === "video")
    ) {
      const prompt = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      const modelId =
        generationMode === "image" ? selectedImageModel : selectedVideoModel;
      const sourceImage = message.parts.find(
        (
          part
        ): part is Extract<(typeof message.parts)[number], { type: "file" }> =>
          part.type === "file" && part.mediaType.startsWith("image/")
      );
      const sourceVideo = message.parts.find(
        (
          part
        ): part is Extract<(typeof message.parts)[number], { type: "file" }> =>
          part.type === "file" && part.mediaType.startsWith("video/")
      );

      if (!prompt || !modelId) {
        throw new ChatbotError("bad_request:api");
      }
      if (
        (generationMode === "image" &&
          (Boolean(sourceVideo) ||
            (Boolean(sourceImage) && !supportsImageInput(modelId)))) ||
        (generationMode === "video" &&
          ((Boolean(sourceImage) && !supportsVideoImageInput(modelId)) ||
            (Boolean(sourceVideo) && !supportsVideoFileInput(modelId))))
      ) {
        throw new ChatbotError("bad_request:api");
      }

      directMediaRecord = {
        createdAt: new Date(),
        input: {
          model: modelId,
          prompt,
          ...(generationMode === "image" ? { size: imageSize } : {}),
          ...(generationMode === "video" ? { quality: videoQuality } : {}),
          ...(sourceImage ? { sourceImage: sourceImage.name } : {}),
          ...(sourceVideo ? { sourceVideo: sourceVideo.name } : {}),
        },
        kind: generationMode,
        messageId: generateUUID(),
        modelId,
        modelName:
          generationMode === "video" ? videoStatusModelName(modelId) : modelId,
        toolCallId: generateUUID(),
      };

      if (sourceImage) {
        directMediaInputImage = await resolveMediaInputUrl({
          mediaType: sourceImage.mediaType,
          url: sourceImage.url,
          userId: session.user.id,
        });
      }
      if (sourceVideo) {
        directMediaInputVideo = await resolveMediaInputUrl({
          mediaType: sourceVideo.mediaType,
          url: sourceVideo.url,
          userId: session.user.id,
        });
      }

      await saveMessages({
        messages: [
          {
            attachments: [],
            chatId: id,
            createdAt: directMediaRecord.createdAt,
            id: directMediaRecord.messageId,
            parts: directMediaParts(directMediaRecord),
            role: "assistant",
          },
        ],
      });
      logger.info("chat.media_mode.persisted", {
        chatId: id,
        kind: directMediaRecord.kind,
        messageId: directMediaRecord.messageId,
        model: directMediaRecord.modelId,
      });
    }

    const modelConfig = await getModelConfig(chatModel);
    const modelCapabilities = await getCapabilities();
    const capabilities = modelCapabilities[chatModel];
    const isReasoningModel = capabilities?.reasoning === true;
    const supportsTools = capabilities?.tools === true;

    const modelMessages = await convertToModelMessages(
      await hydrateOwnedMediaForModel(uiMessages, session.user.id)
    );

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

    const stream = createUIMessageStream<ChatMessage>({
      execute: async ({ writer: dataStream }) => {
        if (generationMode === "image" && message?.role === "user") {
          if (directMediaRecord?.kind !== "image") {
            throw new Error("Image request was not persisted");
          }

          const {
            input: { prompt },
            modelId,
            toolCallId,
          } = directMediaRecord;
          const createdAt = directMediaRecord.createdAt.toISOString();
          dataStream.write({
            messageMetadata: {
              createdAt,
              model: modelId,
              modelName: directMediaRecord.modelName,
            },
            type: "start",
          });
          dataStream.write({ type: "start-step" });
          dataStream.write({
            input: {
              model: modelId,
              prompt,
              size: imageSize,
            },
            toolCallId,
            toolName: "generateImage",
            type: "tool-input-available",
          });
          dataStream.write({
            data: {
              message: "Generating image…",
              modelId,
              modelName: directMediaRecord.modelName,
              phase: "waiting",
            },
            transient: true,
            type: "data-waiting-status",
          });

          const output = await generateImageForChat({
            preferredModel: modelId,
            prompt,
            session,
            size: imageSize,
            sourceImage: directMediaInputImage,
          });
          await updateMessage({
            id: directMediaRecord.messageId,
            parts: directMediaParts(
              directMediaRecord,
              output as Record<string, unknown>
            ),
          });
          dataStream.write({
            output,
            toolCallId,
            type: "tool-output-available",
          });
          dataStream.write({
            messageMetadata: {
              createdAt,
              model: output.model,
              modelName: output.modelName,
            },
            type: "message-metadata",
          });
          dataStream.write({ type: "finish-step" });
          dataStream.write({
            finishReason: "tool-calls",
            messageMetadata: {
              createdAt,
              model: output.model,
              modelName: output.modelName,
            },
            type: "finish",
          });
          logger.info("chat.image_mode.end", {
            chatId: id,
            durationMs: Date.now() - startedAt,
            model: output.model,
            success: !("error" in output),
          });

          if (titlePromise) {
            try {
              const title = await titlePromise;
              dataStream.write({ data: title, type: "data-chat-title" });
              updateChatTitleById({ chatId: id, title });
            } catch {
              /* non-fatal */
            }
          }
          return;
        }

        if (generationMode === "video" && message?.role === "user") {
          if (directMediaRecord?.kind !== "video") {
            throw new Error("Video request was not persisted");
          }

          const {
            input: { prompt },
            modelId,
            toolCallId,
          } = directMediaRecord;
          const createdAt = directMediaRecord.createdAt.toISOString();
          dataStream.write({
            messageMetadata: {
              createdAt,
              model: modelId,
              modelName: directMediaRecord.modelName,
            },
            type: "start",
          });
          dataStream.write({ type: "start-step" });
          dataStream.write({
            input: {
              model: modelId,
              prompt,
              quality: directMediaRecord.input.quality,
              ...(directMediaRecord.input.sourceImage
                ? { sourceImage: directMediaRecord.input.sourceImage }
                : {}),
              ...(directMediaRecord.input.sourceVideo
                ? { sourceVideo: directMediaRecord.input.sourceVideo }
                : {}),
            },
            toolCallId,
            toolName: "generateVideo",
            type: "tool-input-available",
          });

          const videoStartedAt = Date.now();
          const videoModelName = videoStatusModelName(modelId);
          let heartbeatCount = 0;
          const writeVideoHeartbeat = () => {
            heartbeatCount += 1;
            const elapsedMinutes = Math.max(
              1,
              Math.floor((Date.now() - videoStartedAt) / 60_000)
            );
            dataStream.write({
              data: {
                message: `${videoModelName} is still generating (${elapsedMinutes} min)…`,
                modelId,
                modelName: videoModelName,
                phase: "still-waiting",
              },
              transient: true,
              type: "data-waiting-status",
            });
            if (heartbeatCount % 4 === 0) {
              logger.info("chat.video_mode.heartbeat", {
                chatId: id,
                elapsedMs: Date.now() - videoStartedAt,
                model: modelId,
              });
            }
          };
          dataStream.write({
            data: {
              message: `${videoModelName} accepted the request and is generating…`,
              modelId,
              modelName: videoModelName,
              phase: "waiting",
            },
            transient: true,
            type: "data-waiting-status",
          });
          const heartbeatTimer = setInterval(writeVideoHeartbeat, 15_000);
          let output: Awaited<ReturnType<typeof generateVideo>>;
          try {
            output = await generateVideo({
              inputImage: directMediaInputImage,
              inputVideo: directMediaInputVideo,
              preferredModel: modelId,
              prompt,
              quality: videoQuality,
              session,
            });
          } finally {
            clearInterval(heartbeatTimer);
          }
          await updateMessage({
            id: directMediaRecord.messageId,
            parts: directMediaParts(
              directMediaRecord,
              output as Record<string, unknown>
            ),
          });
          dataStream.write({
            output,
            toolCallId,
            type: "tool-output-available",
          });
          dataStream.write({
            messageMetadata: {
              createdAt,
              model: output.model,
              modelName: output.modelName,
            },
            type: "message-metadata",
          });
          dataStream.write({ type: "finish-step" });
          dataStream.write({
            finishReason: "tool-calls",
            messageMetadata: {
              createdAt,
              model: output.model,
              modelName: output.modelName,
            },
            type: "finish",
          });
          logger.info("chat.video_mode.end", {
            chatId: id,
            durationMs: Date.now() - startedAt,
            model: output.model,
            success: !("error" in output),
          });

          if (titlePromise) {
            try {
              const title = await titlePromise;
              dataStream.write({ data: title, type: "data-chat-title" });
              updateChatTitleById({ chatId: id, title });
            } catch {
              /* non-fatal */
            }
          }
          return;
        }

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

        const tools: ToolSet = {
          createDocument: createDocument({
            dataStream,
            modelId: chatModel,
            session,
          }),
          delegateToAgentFramework: createAgentFrameworkTool(id, chatModel),
          editDocument: editDocument({ dataStream, session }),
          generateImage: createGenerateImageTool(session),
          generateVideo: createGenerateVideoTool(session, selectedVideoModel),
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
          ...workspaceTools,
          ...(directMcpToolsEnabled ? litellmMcpTools : {}),
        };

        const memoryQuery = message?.parts
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(" ")
          .slice(0, 500) ?? "";
        let memoryContext = "";
        if (memoryQuery) {
          try {
            const memoryRows = await searchChatMemory({
              chatId: id,
              query: memoryQuery,
              userId: session.user.id,
            });
            memoryContext = formatChatMemoryContext(memoryRows);
            if (memoryRows.length > 0) {
              logger.info("chat.memory.retrieved", {
                chatId: id,
                chunkCount: memoryRows.length,
              });
            }
          } catch (error) {
            logger.warn("chat.memory.retrieve_failed", {
              chatId: id,
              error,
            });
          }
        }

        // Counts consecutive MCP gateway bounces (client-side stub runs) in
        // this request; two in a row abort the stream with a user-visible
        // notice so the model cannot loop until the context window fills.
        let gatewayBounceCount = 0;
        logger.info("chat.litellm.request", {
          chatId: id,
          gatewayToolsOffered: directMcpToolsEnabled
            ? litellmMcpToolNames.length
            : 0,
          messageCount: modelMessages.length,
          model: chatModel,
          modelMessagesTokensHint: JSON.stringify(modelMessages).length,
          workspaceToolsOffered: workspaceTools ? workspaceToolNames.length : 0,
        });
        const result = streamText({
          activeTools: supportsTools
            ? [
                "getWeather",
                "generateImage",
                "createDocument",
                "editDocument",
                "updateDocument",
                "requestSuggestions",
                "delegateToAgentFramework",
                ...(workspaceAccess ? workspaceToolNames : []),
                ...(directMcpToolsEnabled ? litellmMcpToolNames : []),
              ]
            : [],
          instructions: `${systemPrompt({ requestHints, supportsTools })}${
            workspaceAccess
              ? "\n\nYou have account-scoped workspace tools. The tool path creative/ maps to /home/blechdom/creative and nvidia/ maps to /home/blechdom/nvidia. Use workspaceList or workspaceRead before claiming local files are unavailable. To edit a file, read it, propose the complete replacement with workspaceProposePatch, show the returned diff to the user, then request workspaceApplyPatch approval. Use the Git tools for repositories under those roots; inspect status and diffs before commits, and request approval for every push."
              : ""
          }${memoryContext ? `\n\n${memoryContext}` : ""}`,
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
          onStepFinish(step) {
            const toolCalls = step.toolCalls;
            if (toolCalls && toolCalls.length > 0) {
              for (const tc of toolCalls) {
                const matchingResult = step.toolResults?.find(
                  (tr) => tr.toolCallId === tc.toolCallId
                );
                const outputStr =
                  matchingResult && "output" in matchingResult
                    ? JSON.stringify(
                        (matchingResult as { output: unknown }).output
                      )
                    : JSON.stringify(matchingResult ?? "");
                const resultPreview = outputStr.slice(0, 300) || "no result";
                // A bounced gateway call fails in the stub execute, which the
                // SDK surfaces as a tool-error content part, not a toolResult.
                const bouncedInContent = (step.content ?? []).some(
                  (part) =>
                    part.type === "tool-error" &&
                    part.toolCallId === tc.toolCallId
                );
                const isStub =
                  bouncedInContent ||
                  outputStr.includes("handled_by_litellm_mcp_gateway") ||
                  outputStr.includes("returned to the chatbot instead") ||
                  outputStr === "{}" ||
                  outputStr === '""' ||
                  outputStr === "";
                if (isStub) {
                  gatewayBounceCount += 1;
                  logger.warn("chat.tool.stub_result", {
                    chatId: id,
                    consecutiveBounces: gatewayBounceCount,
                    model: chatModel,
                    toolCallId: tc.toolCallId,
                    toolName: tc.toolName,
                    toolResult: resultPreview,
                  });
                  if (gatewayBounceCount === 1) {
                    dataStream.write({
                      data: {
                        message:
                          "A filesystem tool call is not reaching the LiteLLM MCP gateway for this model. If it repeats, the run will stop and explain.",
                        modelId: chatModel,
                        modelName,
                        phase: "waiting",
                      },
                      type: "data-waiting-status",
                    });
                  }
                  if (gatewayBounceCount >= 2) {
                    logger.error("chat.tool.gateway_bounce_loop", {
                      chatId: id,
                      bounceCount: gatewayBounceCount,
                      model: chatModel,
                    });
                    dataStream.write({
                      data: {
                        message:
                          "Stopping: this model's deployment is not executing filesystem tools (calls keep returning to the app instead of running on the gateway). Ask for a different model or continue without filesystem tools.",
                        modelId: chatModel,
                        modelName,
                        phase: "waiting",
                      },
                      type: "data-waiting-status",
                    });
                  }
                } else {
                  gatewayBounceCount = 0;
                }
                logger.info("chat.tool.call", {
                  chatId: id,
                  durationMs: Date.now() - startedAt,
                  model: chatModel,
                  toolArgs: JSON.stringify(tc.input).slice(0, 200),
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  toolResult: resultPreview,
                });
              }
            }
          },
          providerOptions: {
            ...(modelConfig?.gatewayOrder && {
              gateway: { order: modelConfig.gatewayOrder },
            }),
            ...(modelConfig?.reasoningEffort && {
              openai: { reasoningEffort: modelConfig.reasoningEffort },
            }),
          },
          stopWhen: [
            isStepCount(5),
            // Video generation is a complete terminal action. Stopping after
            // its result prevents a chat model from retrying an expensive job
            // or silently substituting an image when video generation fails.
            hasToolCall("generateVideo"),
            // MCP gateway tools are normally executed server-side by LiteLLM.
            // When a deployment bounces them back to the app stub instead,
            // allow one bounce step (so the model can explain the failure from
            // the error result), then stop before it can loop indefinitely.
            ...(directMcpToolsEnabled
              ? [
                  ({
                    steps,
                  }: {
                    steps: Array<{
                      content: Array<{
                        toolCallId?: string;
                        toolName?: string;
                        type: string;
                      }>;
                    }>;
                  }) =>
                    steps.filter((step) =>
                      (step.content ?? []).some(
                        (part) =>
                          part.type === "tool-error" &&
                          typeof part.toolName === "string" &&
                          part.toolName.startsWith("metis_router-")
                      )
                    ).length >= 2,
                ]
              : []),
          ],
          telemetry: {
            functionId: "stream-text",
            isEnabled: isProductionEnvironment,
          },
          tools,
        });

        dataStream.merge(
          toUIMessageStream({
            messageMetadata: createMessageMetadataHandler({
              modelId: chatModel,
              modelName,
            }),
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
      generateId: directMediaRecord
        ? () => directMediaRecord.messageId
        : generateUUID,
      onEnd: async ({ messages: finishedMessages }) => {
        logger.info("chat.response.end", {
          chatId: id,
          durationMs: Date.now() - startedAt,
          messageCount: finishedMessages.length,
        });

        if (directMediaRecord) {
          return;
        }

        if (isToolApprovalFlow) {
          await Promise.all(
            finishedMessages.map(async (finishedMsg) => {
              const existingMsg = uiMessages.find(
                (m) => m.id === finishedMsg.id
              );
              if (existingMsg) {
                await updateMessage({
                  id: finishedMsg.id,
                  parts: persistMessageParts(finishedMsg),
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
                    parts: persistMessageParts(finishedMsg),
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
              parts: persistMessageParts(currentMessage),
              role: currentMessage.role,
            })),
          });
        }
        logger.info("chat.response.persisted", {
          chatId: id,
          durationMs: Date.now() - startedAt,
          messageIds: finishedMessages.map((m) => m.id),
          messageCount: finishedMessages.length,
          roleSummary: finishedMessages
            .map((m) => m.role)
            .reduce<Record<string, number>>((acc, role) => {
              acc[role] = (acc[role] ?? 0) + 1;
              return acc;
            }, {}),
        });

        // Store large text and tool-output content as chat memory for
        // later retrieval. Failures are non-fatal; the chat still works.
        try {
          for (const currentMessage of finishedMessages) {
            const persistableParts = currentMessage.parts.filter(
              (part) =>
                (part.type === "text" && part.text.length >= 2000) ||
                (part.type === "dynamic-tool" &&
                  part.state === "output-available" &&
                  part.output != null &&
                  String(part.output).length >= 2000)
            );
            for (const part of persistableParts) {
              const content =
                part.type === "text"
                  ? part.text
                  : String((part as { output?: unknown }).output ?? "");
              await storeChatMemory({
                chatId: id,
                content,
                metadata: { partType: part.type },
                sourceMessageId: currentMessage.id,
                userId: session.user.id,
              });
            }
          }
        } catch (error) {
          logger.warn("chat.memory.store_failed", {
            chatId: id,
            error,
          });
        }
      },
      onError: (error) => {
        const userMessage = formatStreamError(error);
        logger.error("chat.response.error", {
          chatId: id,
          durationMs: Date.now() - startedAt,
          error,
          userMessage,
        });
        return userMessage;
      },
      originalMessages: isToolApprovalFlow ? uiMessages : undefined,
    });

    return createUIMessageStreamResponse({
      async consumeSseStream({ stream: sseStream }) {
        logger.info("chat.response.stream_started", {
          chatId: id,
          durationMs: Date.now() - startedAt,
          resumable: Boolean(process.env.REDIS_URL),
        });
        if (!process.env.REDIS_URL) {
          // Keep a second consumer alive so an expensive tool call can finish
          // and createUIMessageStream.onEnd can persist its result even when
          // the browser navigates away or refreshes during generation.
          await sseStream.pipeTo(new WritableStream());
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
            return;
          }
          await sseStream.pipeTo(new WritableStream());
        } catch (error) {
          logger.warn("chat.stream.persistence_consumer_error", {
            chatId: id,
            error,
          });
          if (!sseStream.locked) {
            await sseStream.pipeTo(new WritableStream());
          }
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

  const messages = await getMessagesByChatId({ id });
  if (hasPendingDirectMedia(messages)) {
    logger.warn("chat.delete.rejected", {
      chatId: id,
      reason: "media-generation-active",
      userId: session.user.id,
    });
    return Response.json(
      {
        code: "bad_request:chat",
        message:
          "This chat has media still generating. Wait for it to finish before deleting it.",
      },
      { status: 409 }
    );
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
