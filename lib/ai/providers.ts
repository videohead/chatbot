import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { customProvider } from "ai";
import { isTestEnvironment } from "../constants";
import { DEFAULT_CHAT_MODEL, getModelConfig, titleModel } from "./models";

const providerCache = new Map<
  string,
  ReturnType<typeof createOpenAICompatible>
>();

function providerFor(baseURL: string, apiKey: string) {
  const cacheKey = `${baseURL}:${apiKey}`;
  const cached = providerCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const provider = createOpenAICompatible({
    apiKey,
    baseURL,
    name: "vllm",
  });
  providerCache.set(cacheKey, provider);
  return provider;
}

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

  const config = getModelConfig(modelId) ?? getModelConfig(DEFAULT_CHAT_MODEL);
  if (!config) {
    throw new Error(`Unknown chat model: ${modelId}`);
  }

  return providerFor(
    config.baseUrl,
    process.env[config.apiKeyEnv ?? "OPENAI_API_KEY"] ?? "not-needed"
  ).chatModel(config.id);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return providerFor(
    titleModel.baseUrl,
    process.env[titleModel.apiKeyEnv ?? "OPENAI_API_KEY"] ?? "not-needed"
  ).chatModel(titleModel.id);
}
