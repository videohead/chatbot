export const VLLM_BASE_URL =
  process.env.OPENAI_BASE_URL ?? "https://videohead.duckdns.org/vllm/v1";
export const QWEN_BASE_URL =
  process.env.QWEN_BASE_URL ?? "http://10.0.0.250:11434/v1";

export const DEFAULT_CHAT_MODEL = process.env.OPENAI_MODEL ?? "gpt-oss-20b";

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
  baseUrl: string;
  gatewayOrder?: string[];
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
};

export const chatModels: ChatModel[] = [
  {
    baseUrl: VLLM_BASE_URL,
    description: "Local vLLM on the DGX host. 8K context.",
    id: "gpt-oss-20b",
    name: "GPT-OSS 20B",
    provider: "vllm",
    reasoningEffort: "low",
  },
  {
    baseUrl: QWEN_BASE_URL,
    description: "Qwen3.8 27B on 10.0.0.250. 128K context, best for long sessions.",
    id: "unsloth/Qwen3.8-27B-NVFP4",
    name: "Qwen3.8 27B",
    provider: "qwen",
    reasoningEffort: "low",
  },
];

export function getModelConfig(modelId: string): ChatModel | undefined {
  return chatModels.find((model) => model.id === modelId);
}

export const titleModel = chatModels[0];

// Local vLLM exposes no capability discovery endpoint; declare them statically.
const LOCAL_CAPABILITIES: ModelCapabilities = {
  reasoning: true,
  tools: true,
  vision: false,
};

export function getCapabilities(): Promise<Record<string, ModelCapabilities>> {
  return Promise.resolve(
    Object.fromEntries(chatModels.map((model) => [model.id, LOCAL_CAPABILITIES]))
  );
}

export const isDemo = process.env.IS_DEMO === "1";

export type GatewayModelWithCapabilities = ChatModel & {
  capabilities: ModelCapabilities;
};

export function getAllGatewayModels(): Promise<GatewayModelWithCapabilities[]> {
  return Promise.resolve(
    chatModels.map((model) => ({ ...model, capabilities: LOCAL_CAPABILITIES }))
  );
}

export function getActiveModels(): ChatModel[] {
  return chatModels;
}

export const allowedModelIds = new Set(chatModels.map((m) => m.id));

export const modelsByProvider = chatModels.reduce(
  (acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  },
  {} as Record<string, ChatModel[]>
);

export type ModelAvailability = "healthy" | "impacted" | "unknown";

export function getModelAvailability(
  modelId: string
): Promise<ModelAvailability> {
  return Promise.resolve(
    chatModels.some((item) => item.id === modelId) ? "healthy" : "unknown"
  );
}
