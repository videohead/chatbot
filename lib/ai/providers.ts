import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { customProvider } from "ai";
import { isTestEnvironment } from "../constants";
import { DEFAULT_CHAT_MODEL, getModelConfig, titleModel } from "./models";

const providerCache = new Map<
  string,
  ReturnType<typeof createOpenAICompatible>
>();

function providerFor(baseURL: string) {
  const cached = providerCache.get(baseURL);
  if (cached) {
    return cached;
  }

  const provider = createOpenAICompatible({
    apiKey: process.env.OPENAI_API_KEY ?? "not-needed",
    baseURL,
    name: "vllm",
  });
  providerCache.set(baseURL, provider);
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

  return providerFor(config.baseUrl).chatModel(config.id);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return providerFor(titleModel.baseUrl).chatModel(titleModel.id);
}
