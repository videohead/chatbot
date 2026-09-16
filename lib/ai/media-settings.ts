export const IMAGE_SIZE_IDS = ["1024x1024", "1536x1024", "1024x1536"] as const;

export type ImageSize = (typeof IMAGE_SIZE_IDS)[number];

export type ImageSizeOption = {
  id: ImageSize;
  label: string;
  resolution: string;
};

const IMAGE_EDIT_MODEL_IDS = new Set([
  "gcp/google/gemini-3-pro-image",
  "gcp/google/gemini-3.1-flash-image",
  "openai/openai/gpt-image-2",
]);

export type VideoInputCapabilities = {
  image: boolean;
  video: boolean;
};

const NO_VIDEO_INPUT: VideoInputCapabilities = {
  image: false,
  video: false,
};

const VIDEO_INPUT_CAPABILITIES: Record<string, VideoInputCapabilities> = {
  "gcp/google/veo-3.1-generate-001": { image: true, video: false },
  "gemini-omni-flash-preview": { image: true, video: true },
  "nvidia/nvidia/cosmos3-nano": { image: true, video: false },
  "nvidia/nvidia/cosmos3-super": { image: true, video: false },
};

export function supportsImageInput(modelId?: string | null) {
  return typeof modelId === "string" && IMAGE_EDIT_MODEL_IDS.has(modelId);
}

export function getVideoInputCapabilities(
  modelId?: string | null
): VideoInputCapabilities {
  if (!modelId) {
    return NO_VIDEO_INPUT;
  }
  return VIDEO_INPUT_CAPABILITIES[modelId] ?? NO_VIDEO_INPUT;
}

export function supportsVideoImageInput(modelId?: string | null) {
  return getVideoInputCapabilities(modelId).image;
}

export function supportsVideoFileInput(modelId?: string | null) {
  return getVideoInputCapabilities(modelId).video;
}

const gptImageSizeOptions: ImageSizeOption[] = [
  { id: "1024x1024", label: "Square", resolution: "1024×1024" },
  { id: "1536x1024", label: "Landscape", resolution: "1536×1024" },
  { id: "1024x1536", label: "Portrait", resolution: "1024×1536" },
];

const geminiImageSizeOptions: ImageSizeOption[] = [
  { id: "1024x1024", label: "Current route", resolution: "1K" },
];

export function getImageSizeOptions(
  modelId?: string | null
): ImageSizeOption[] {
  if (modelId?.includes("gemini-")) {
    return geminiImageSizeOptions;
  }
  return gptImageSizeOptions;
}

export function normalizeImageSize(
  modelId: string | null | undefined,
  value?: string | null
): ImageSize {
  return getImageSizeOptions(modelId).some((option) => option.id === value)
    ? (value as ImageSize)
    : "1024x1024";
}

export const VIDEO_QUALITY_IDS = [
  "auto",
  "draft",
  "standard",
  "high",
  "ultra",
] as const;

export type VideoQuality = (typeof VIDEO_QUALITY_IDS)[number];

export type VideoQualityOption = {
  id: VideoQuality;
  label: string;
  resolution: string;
};

const providerVideoOptions: VideoQualityOption[] = [
  { id: "auto", label: "Provider", resolution: "Provider default" },
];

const cosmosNanoOptions: VideoQualityOption[] = [
  { id: "draft", label: "Hosted", resolution: "320×192" },
];

const cosmosSuperOptions: VideoQualityOption[] = [
  { id: "draft", label: "Draft", resolution: "320×192" },
  { id: "standard", label: "Standard", resolution: "832×480" },
  { id: "high", label: "High", resolution: "1280×720" },
];

const veo30Options: VideoQualityOption[] = [
  { id: "standard", label: "HD", resolution: "1280×720" },
  { id: "high", label: "Full HD", resolution: "1920×1080" },
];

const veo31Options: VideoQualityOption[] = [
  ...veo30Options,
  { id: "ultra", label: "4K", resolution: "3840×2160" },
];

export function getVideoQualityOptions(
  modelId?: string | null
): VideoQualityOption[] {
  if (modelId?.includes("cosmos3-super")) {
    return cosmosSuperOptions;
  }
  if (modelId?.includes("cosmos3-nano")) {
    return cosmosNanoOptions;
  }
  if (modelId?.includes("veo-3.1")) {
    return veo31Options;
  }
  if (modelId?.includes("veo-3.0")) {
    return veo30Options;
  }
  return providerVideoOptions;
}

export function getDefaultVideoQuality(modelId?: string | null): VideoQuality {
  if (modelId?.includes("cosmos3-super")) {
    return "high";
  }
  if (modelId?.includes("cosmos3-nano")) {
    return "draft";
  }
  if (modelId?.includes("veo-3.")) {
    return "standard";
  }
  return "auto";
}

export function normalizeVideoQuality(
  modelId: string | null | undefined,
  value?: string | null
): VideoQuality {
  const options = getVideoQualityOptions(modelId);
  return options.some((option) => option.id === value)
    ? (value as VideoQuality)
    : getDefaultVideoQuality(modelId);
}

export function getCosmosSuperResolution(quality: VideoQuality) {
  if (quality === "draft") {
    return "256_16_9";
  }
  if (quality === "standard") {
    return "480_16_9";
  }
  return "720_16_9";
}

export function getVeoRequestSettings(
  modelId: string,
  quality: VideoQuality
): { seconds?: string; size?: string } {
  if (!modelId.includes("veo-3.")) {
    return {};
  }
  if (quality === "ultra" && modelId.includes("veo-3.1")) {
    return { seconds: "8", size: "3840x2160" };
  }
  if (quality === "high") {
    return { seconds: "8", size: "1920x1080" };
  }
  return { seconds: "8", size: "1280x720" };
}
