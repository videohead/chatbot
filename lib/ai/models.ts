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
  apiKeyEnv?: string;
  gatewayOrder?: string[];
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
};

type AgentModelPool = {
  api_key_env?: string;
  base_url: string;
  model: string;
  name: string;
  primary?: boolean;
  project?: string;
  provider: string;
};

const fallbackModels: ChatModel[] = [
  {
    apiKeyEnv: "OPENHARNESS_QWEN_API_KEY",
    baseUrl: "http://10.0.0.105:11434/v1",
    description: "OpenHarness Qwen3.8 agent pool.",
    id: "unsloth/Qwen3.8-27B-NVFP4",
    name: "Qwen3.8 27B",
    provider: "qwen",
    reasoningEffort: "low",
  },
];

function loadAgentModelPools(): ChatModel[] {
  try {
    const pools = JSON.parse(process.env.OPENHARNESS_AGENT_MODEL_POOLS ?? "[]") as AgentModelPool[];
    const models = pools.map((pool) => ({
      apiKeyEnv: pool.api_key_env,
      baseUrl: pool.base_url,
      description: `OpenHarness ${pool.project ?? "default"} agent pool.`,
      id: pool.model,
      name: pool.name,
      provider: pool.provider,
      reasoningEffort: "low" as const,
    }));
    return models.length > 0 ? models : fallbackModels;
  } catch {
    return fallbackModels;
  }
}

export const chatModels = loadAgentModelPools();
export const DEFAULT_CHAT_MODEL =
  process.env.OPENHARNESS_PRIMARY_MODEL ?? chatModels[0]?.id ?? fallbackModels[0].id;

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
