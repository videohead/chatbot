import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { customProvider } from "ai";
import { isTestEnvironment } from "../constants";
import { DEFAULT_CHAT_MODEL } from "./models";

const LITELLM_BASE_URL =
  process.env.LITELLM_BASE_URL ?? "http://litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY ?? "not-needed";
const MEDIA_LITELLM_BASE_URL =
  process.env.MEDIA_LITELLM_BASE_URL ??
  "http://media:4000/v1";
const MEDIA_LITELLM_API_KEY =
  process.env.MEDIA_LITELLM_MASTER_KEY ?? "not-configured";
const LITELLM_MCP_SERVER = process.env.LITELLM_MCP_SERVER ?? "metis_router";
const LITELLM_MCP_TOOL_PREFIX = `${LITELLM_MCP_SERVER}-`;
const TOOL_CHOICE_COMPAT_MODELS = new Set(["azure/openai/gpt-5.4"]);

function appendLitellmMcpGateway(args: Record<string, any>) {
  if (!Array.isArray(args.tools) || args.tools.length === 0) {
    return args;
  }

  const localMcpTools = args.tools.filter(
    (tool: Record<string, any>) =>
      tool?.type === "function" &&
      typeof tool.function?.name === "string" &&
      tool.function.name.startsWith(LITELLM_MCP_TOOL_PREFIX)
  );

  const appTools = args.tools.filter(
    (tool: Record<string, any>) => !localMcpTools.includes(tool)
  );

  if (appTools.length === args.tools.length) {
    return args;
  }

  return {
    ...args,
    tools: [
      ...appTools,
      {
        require_approval: "never",
        server_label: LITELLM_MCP_SERVER,
        server_url: `litellm_proxy/mcp/${LITELLM_MCP_SERVER}`,
        type: "mcp",
      },
    ],
  };
}

function prepareLitellmRequestBody(args: Record<string, any>) {
  const body = appendLitellmMcpGateway(args);

  // LiteLLM's Azure model metadata can reject tool_choice before forwarding
  // the request even though this deployment accepts OpenAI-compatible tools.
  // Its per-request override keeps the exception scoped to the affected model.
  if (
    TOOL_CHOICE_COMPAT_MODELS.has(String(body.model ?? "")) &&
    body.tool_choice !== undefined
  ) {
    const existingAllowedParams = Array.isArray(body.allowed_openai_params)
      ? body.allowed_openai_params.filter(
          (parameter): parameter is string => typeof parameter === "string"
        )
      : [];

    return {
      ...body,
      allowed_openai_params: Array.from(
        new Set([...existingAllowedParams, "tool_choice"])
      ),
    };
  }

  return body;
}

// A single OpenAI-compatible provider pointed at the LiteLLM proxy. LiteLLM
// owns the model pool, routing, and cost accounting; the chatbot just asks it
// for a named model.
const litellm = createOpenAICompatible({
  apiKey: LITELLM_API_KEY,
  baseURL: LITELLM_BASE_URL,
  name: "litellm",
  transformRequestBody: prepareLitellmRequestBody,
});

// Media uses an isolated LiteLLM process with no database and no published
// port. Experimental media deployments stay out of the shared model registry.
const mediaLitellm = createOpenAICompatible({
  apiKey: MEDIA_LITELLM_API_KEY,
  baseURL: MEDIA_LITELLM_BASE_URL,
  name: "media",
});

export const myProvider = isTestEnvironment
  ? (() => {
      const {
        chatModel,
        titleModel: mockTitleModel,
      } = require("./models.mock");
      return customProvider({
        languageModels: {
          "chat-model": chatModel,
          "title-model": mockTitleModel,
        },
      });
    })()
  : null;

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  return litellm.chatModel(modelId);
}

export function getImageModel(modelId: string) {
  return mediaLitellm.imageModel(modelId);
}

function imageBlobFromDataUrl(sourceImage: string) {
  const match = /^data:(image\/(?:jpeg|png));base64,([\s\S]+)$/.exec(
    sourceImage
  );
  if (!match?.[1] || !match[2]) {
    throw new Error("The reference image could not be read");
  }

  return {
    blob: new Blob([Buffer.from(match[2], "base64")], { type: match[1] }),
    mediaType: match[1],
  };
}

export async function editImageWithMediaGateway({
  modelId,
  prompt,
  size,
  sourceImage,
}: {
  modelId: string;
  prompt: string;
  size: string;
  sourceImage: string;
}) {
  const { blob, mediaType } = imageBlobFromDataUrl(sourceImage);
  const formData = new FormData();
  formData.set("model", modelId);
  formData.set("prompt", prompt);
  formData.set("size", size);
  formData.set(
    "image",
    blob,
    mediaType === "image/jpeg" ? "reference.jpg" : "reference.png"
  );

  const response = await fetch(`${MEDIA_LITELLM_BASE_URL}/images/edits`, {
    body: formData,
    headers: { Authorization: `Bearer ${MEDIA_LITELLM_API_KEY}` },
    method: "POST",
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2000);
    throw new Error(
      `Image edit gateway returned HTTP ${response.status}: ${detail}`
    );
  }

  const body = (await response.json()) as {
    data?: { b64_json?: string | null; url?: string | null }[];
  };
  const result = body.data?.[0];
  if (result?.b64_json) {
    return {
      bytes: new Uint8Array(Buffer.from(result.b64_json, "base64")),
      mediaType: "image/png",
    };
  }
  if (result?.url) {
    const imageResponse = await fetch(result.url);
    if (!imageResponse.ok) {
      throw new Error(
        `Generated image download returned HTTP ${imageResponse.status}`
      );
    }
    return {
      bytes: new Uint8Array(await imageResponse.arrayBuffer()),
      mediaType: imageResponse.headers.get("content-type") ?? "image/png",
    };
  }

  throw new Error("The image edit gateway returned no image");
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return litellm.chatModel(DEFAULT_CHAT_MODEL);
}
