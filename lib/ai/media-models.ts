import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@/lib/logger";

const MEDIA_LITELLM_BASE_URL =
  process.env.MEDIA_LITELLM_BASE_URL ??
  "http://media-litellm-candidate:4000/v1";
const MEDIA_LITELLM_API_KEY = process.env.MEDIA_LITELLM_MASTER_KEY ?? "";
const CACHE_TTL_MS = 30_000;

let deploymentCache: { at: number; ids: Set<string> } | null = null;

const DIRECT_VIDEO_MODEL_IDS = [
  "gemini-omni-flash-preview",
  "nvidia/nvidia/cosmos3-nano",
  "nvidia/nvidia/cosmos3-super",
];

export type MediaKind = "audio" | "image_generation" | "video_generation";

export type MediaModel = {
  description: string;
  id: string;
  kind: MediaKind;
  name: string;
};

type CatalogModel = MediaModel & {
  chatSupported?: boolean;
  kinds?: MediaKind[];
};

function readCatalog(): CatalogModel[] {
  try {
    const parsed = JSON.parse(
      readFileSync(join(process.cwd(), "model-catalog.json"), "utf8")
    ) as { models?: CatalogModel[] };
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

async function getMediaDeploymentIds(): Promise<Set<string>> {
  if (deploymentCache && Date.now() - deploymentCache.at < CACHE_TTL_MS) {
    return deploymentCache.ids;
  }

  const response = await fetch(`${MEDIA_LITELLM_BASE_URL}/models`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${MEDIA_LITELLM_API_KEY}` },
  });
  if (!response.ok) {
    logger.warn("media.models.http_error", {
      status: response.status,
      statusText: response.statusText,
    });
    throw new Error("The media model gateway is unavailable");
  }

  const body = (await response.json()) as { data?: { id?: string }[] };
  const ids = new Set(
    (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string")
  );
  for (const id of DIRECT_VIDEO_MODEL_IDS) {
    ids.add(id);
  }
  deploymentCache = { at: Date.now(), ids };
  logger.info("media.models.refreshed", { deploymentCount: ids.size });
  return ids;
}

export async function getMediaModels(kind?: MediaKind): Promise<MediaModel[]> {
  const available = await getMediaDeploymentIds();
  return readCatalog()
    .filter((model) => available.has(model.id))
    .flatMap(({ description, id, kind: primaryKind, kinds, name }) =>
      (kinds ?? [primaryKind])
        .filter((modelKind) =>
          ["audio", "image_generation", "video_generation"].includes(modelKind)
        )
        .filter((modelKind) => !kind || modelKind === kind)
        .map((modelKind) => ({
          description,
          id,
          kind: modelKind,
          name,
        }))
    );
}

const IMAGE_MODEL_PRIORITY = [
  "openai/openai/gpt-image-2",
  "azure/openai/gpt-image-2",
  "gcp/google/gemini-3.1-flash-image",
  "gcp/google/gemini-3-pro-image",
];

const VIDEO_MODEL_PRIORITY = [
  "gcp/google/veo-3.1-generate-001",
  "gcp/google/veo-3.0-generate-001",
  "nvidia/nvidia/cosmos3-nano",
  "nvidia/nvidia/cosmos3-super",
  "gemini-omni-flash-preview",
];

export async function resolveImageModel(
  requested?: string
): Promise<MediaModel> {
  const models = await getMediaModels("image_generation");
  if (requested) {
    const selected = models.find((model) => model.id === requested);
    if (!selected) {
      throw new Error("The requested image model is unavailable");
    }
    return selected;
  }

  for (const id of IMAGE_MODEL_PRIORITY) {
    const selected = models.find((model) => model.id === id);
    if (selected) {
      return selected;
    }
  }

  if (!models[0]) {
    throw new Error("No image generation model is available");
  }
  return models[0];
}

export async function resolveVideoModel(
  requested?: string
): Promise<MediaModel> {
  const models = await getMediaModels("video_generation");
  if (requested) {
    const selected = models.find((model) => model.id === requested);
    if (!selected) {
      throw new Error("The requested video model is unavailable");
    }
    return selected;
  }

  for (const id of VIDEO_MODEL_PRIORITY) {
    const selected = models.find((model) => model.id === id);
    if (selected) {
      return selected;
    }
  }

  if (!models[0]) {
    throw new Error("No video generation model is available");
  }
  return models[0];
}
