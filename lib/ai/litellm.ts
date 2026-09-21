// Server-only LiteLLM model discovery.
//
// LiteLLM is the source of truth for which models are available (its
// /v1/models list). model-catalog.json (at the project root) is the source of
// truth for capabilities and constraints, which LiteLLM does not expose.
//
// This module must never be imported from client components: it uses node:fs
// and fetches from the LiteLLM proxy.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@/lib/logger";
import {
  type ChatModel,
  getModelProvider,
  type ModelCapabilities,
} from "./models";

const LITELLM_BASE_URL =
  process.env.LITELLM_BASE_URL ?? "http://litellm:4000/v1";
const LITELLM_API_KEY = process.env.LITELLM_API_KEY ?? "";

const CACHE_TTL_MS = 30_000;

type CatalogCapabilities = {
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
};

type CatalogModel = {
  id: string;
  chatSupported?: boolean;
  contextWindowTokens?: number;
  name?: string;
  provider?: string;
  kind?: string;
  description?: string;
  capabilities?: CatalogCapabilities;
  maxInputTokens?: number;
  maxOutputTokens?: number;
};

type Catalog = {
  updatedAt?: string;
  models: CatalogModel[];
};

type LitellmState = {
  at: number;
  models: ChatModel[];
  capabilities: Record<string, ModelCapabilities>;
  ids: Set<string>;
  allIds: Set<string>;
};

let cache: LitellmState | null = null;

// Capability overrides for models that LiteLLM serves but the catalog does not
// list (the local vLLM models).
const CAPABILITY_OVERRIDES: Record<string, ModelCapabilities> = {
  "gpt-4o": { reasoning: false, tools: true, vision: true },
  "gpt-oss-20b": { reasoning: true, tools: true, vision: false },
};

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  reasoning: false,
  tools: true,
  vision: false,
};

function readCatalog(): CatalogModel[] {
  const catalogPath = join(process.cwd(), "model-catalog.json");
  try {
    const raw = readFileSync(catalogPath, "utf8");
    const parsed = JSON.parse(raw) as Catalog;
    if (!Array.isArray(parsed.models)) {
      logger.error("litellm.catalog.invalid", { catalogPath });
      return [];
    }
    return parsed.models;
  } catch (error) {
    logger.error("litellm.catalog.read_error", { catalogPath, error });
    return [];
  }
}

function prettifyName(id: string): string {
  const last = id.split("/").pop() ?? id;
  return last.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
}

function capabilitiesFor(
  id: string,
  catalog: CatalogModel | undefined
): ModelCapabilities {
  if (catalog?.capabilities) {
    return {
      reasoning: catalog.capabilities.reasoning ?? false,
      tools: catalog.capabilities.tools ?? false,
      vision: catalog.capabilities.vision ?? false,
    };
  }
  return CAPABILITY_OVERRIDES[id] ?? DEFAULT_CAPABILITIES;
}

async function fetchLitellmModelIds(): Promise<string[]> {
  const startedAt = Date.now();
  logger.debug("litellm.models.fetch.start", {
    baseUrl: LITELLM_BASE_URL,
    hasApiKey: Boolean(LITELLM_API_KEY),
  });

  const res = await fetch(`${LITELLM_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${LITELLM_API_KEY}` },
    // Keep the live list fresh without hammering the proxy.
    next: { revalidate: 30 },
  });
  if (!res.ok) {
    logger.warn("litellm.models.fetch.http_error", {
      baseUrl: LITELLM_BASE_URL,
      durationMs: Date.now() - startedAt,
      status: res.status,
      statusText: res.statusText,
    });
    throw new Error(`LiteLLM /models returned ${res.status}`);
  }
  const json = (await res.json()) as { data?: { id: string }[] };
  logger.info("litellm.models.fetch.success", {
    durationMs: Date.now() - startedAt,
    modelCount: json.data?.length ?? 0,
  });
  return (json.data ?? []).map((m) => m.id);
}

function buildState(ids: string[]): LitellmState {
  const catalog = readCatalog();
  const catalogById = new Map(catalog.map((m) => [m.id, m]));
  const chatIds = ids.filter((id) => {
    const entry = catalogById.get(id);
    if (entry) {
      return entry.chatSupported === true;
    }

    // Keep explicitly configured local chat models that are not in the
    // provider catalog. Unknown proxy deployments should not silently appear
    // in the conversational selector.
    return id in CAPABILITY_OVERRIDES;
  });

  logger.info("litellm.catalog.filtered", {
    catalogModelCount: catalog.length,
    chatModelCount: chatIds.length,
    excludedDeploymentCount: ids.length - chatIds.length,
    proxyDeploymentCount: ids.length,
  });

  const models: ChatModel[] = chatIds.map((id) => {
    const entry = catalogById.get(id);
    return {
      description: entry?.description ?? "",
      id,
      name: entry?.name ?? prettifyName(id),
      provider: getModelProvider(id),
    };
  });

  const capabilities: Record<string, ModelCapabilities> = {};
  for (const id of chatIds) {
    capabilities[id] = capabilitiesFor(id, catalogById.get(id));
  }

  return {
    allIds: new Set(ids),
    at: Date.now(),
    capabilities,
    ids: new Set(chatIds),
    models,
  };
}

/** Every deployment currently advertised by LiteLLM, including media models. */
export async function getAvailableDeploymentIds(): Promise<Set<string>> {
  return new Set((await getLitellmState()).allIds);
}

async function getLitellmState(): Promise<LitellmState> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache;
  }
  try {
    const ids = await fetchLitellmModelIds();
    if (ids.length === 0) {
      throw new Error("LiteLLM returned no models");
    }
    cache = buildState(ids);
    logger.info("litellm.state.refreshed", {
      cacheTtlMs: CACHE_TTL_MS,
      chatModelCount: cache.models.length,
      proxyDeploymentCount: ids.length,
    });
    return cache;
  } catch (error) {
    // Degrade gracefully: if the proxy is unreachable, keep serving the last
    // known list (or the static fallback) so the app stays usable.
    if (cache) {
      logger.warn("litellm.state.using_cached_after_error", {
        error,
        modelCount: cache.models.length,
      });
      return cache;
    }
    const fallbackIds = ["gpt-oss-20b"];
    logger.error("litellm.state.using_fallback_after_error", {
      error,
      fallbackIds,
    });
    return buildState(fallbackIds);
  }
}

/** Live list of chat models available through LiteLLM. */
export async function getLitellmModels(): Promise<ChatModel[]> {
  return (await getLitellmState()).models;
}

/** Capabilities for every available model, keyed by model id. */
export async function getCapabilities(): Promise<
  Record<string, ModelCapabilities>
> {
  return (await getLitellmState()).capabilities;
}

/** Set of model ids that are currently selectable. */
export async function getAllowedModelIds(): Promise<Set<string>> {
  return (await getLitellmState()).ids;
}

/** Look up a single model's config by id. */
export async function getModelConfig(
  modelId: string
): Promise<ChatModel | undefined> {
  const state = await getLitellmState();
  return state.models.find((m) => m.id === modelId);
}

export type ModelAvailability = "healthy" | "impacted" | "unknown";

/** A model is healthy if LiteLLM currently lists it. */
export async function getModelAvailability(
  modelId: string
): Promise<ModelAvailability> {
  const state = await getLitellmState();
  return state.ids.has(modelId) ? "healthy" : "unknown";
}
