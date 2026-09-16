// Client-safe model metadata.
//
// The live model list, capabilities, and availability are discovered at
// runtime from the LiteLLM proxy (see ./litellm.ts, which is server-only).
// This module only holds shared types, the default model, and a small static
// fallback list used by the client before /api/models has loaded.

export const DEFAULT_CHAT_MODEL =
  process.env.NEXT_PUBLIC_DEFAULT_CHAT_MODEL ?? "gpt-oss-20b";

export const titleModel = {
  description: "Fast model for title generation",
  gatewayOrder: [] as string[],
  id: DEFAULT_CHAT_MODEL,
  name: "GPT OSS 20B",
  provider: "openai",
};

export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
};

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
  gatewayOrder?: string[];
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
};

// Minimal static fallback so the model selector has something to show before
// the live LiteLLM list is fetched from /api/models. The authoritative list
// always comes from LiteLLM at runtime.
export const chatModels: ChatModel[] = [
  {
    description: "Local reasoning model served by vLLM",
    id: DEFAULT_CHAT_MODEL,
    name: "GPT OSS 20B",
    provider: "openai",
  },
];

export function getActiveModels(): ChatModel[] {
  return chatModels;
}
