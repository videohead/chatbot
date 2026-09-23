import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tool } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { storeGeneratedVideo } from "@/lib/media-storage";
import { resolveVideoModel } from "../media-models";
import {
  getCosmosSuperResolution,
  getVeoRequestSettings,
  getVideoInputCapabilities,
  normalizeVideoQuality,
  type VideoQuality,
} from "../media-settings";

const MEDIA_LITELLM_BASE_URL = (
  process.env.MEDIA_LITELLM_BASE_URL ?? "http://media:4000/v1"
).replace(/\/$/, "");
const MEDIA_LITELLM_ORIGIN = MEDIA_LITELLM_BASE_URL.replace(/\/v1$/, "");
const MEDIA_LITELLM_API_KEY = process.env.MEDIA_LITELLM_MASTER_KEY ?? "";
const VIDEO_TIMEOUT_MS = 9 * 60 * 1000;
const VIDEO_POLL_INTERVAL_MS = 3000;

type VideoJob = {
  error?: { message?: string } | null;
  id?: string;
  progress?: number | null;
  status?: string;
};

type DirectVideoPayload = {
  b64_video?: string;
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string } | null;
  generatedVideo?: {
    video?: { bytesBase64Encoded?: string; uri?: string };
  };
  id?: string;
  output_video?: { data?: string; mime_type?: string; uri?: string };
  outputs?: Array<{
    content?: Array<{
      data?: string;
      mime_type?: string;
      type?: string;
      uri?: string;
    }>;
    data?: string;
    mime_type?: string;
    type?: string;
    uri?: string;
  }>;
  output?: { video?: { bytesBase64Encoded?: string; uri?: string } };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{
        video?: { bytesBase64Encoded?: string; uri?: string };
      }>;
    };
  };
  status?: string;
  steps?: Array<{
    content?: Array<{
      data?: string;
      mime_type?: string;
      type?: string;
      uri?: string;
    }>;
  }>;
  video?: string | { bytesBase64Encoded?: string; uri?: string };
};

class VideoGatewayError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "VideoGatewayError";
    this.status = status;
  }
}

function gatewayHeaders(contentType = false) {
  return {
    Authorization: `Bearer ${MEDIA_LITELLM_API_KEY}`,
    ...(contentType ? { "Content-Type": "application/json" } : {}),
  };
}

async function readGatewayError(response: Response) {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as {
      detail?: { error?: { message?: string } } | string;
      error?: { message?: string };
    };
    if (typeof parsed.detail === "string") {
      return parsed.detail.slice(0, 500);
    }
    return (
      parsed.error?.message ??
      parsed.detail?.error?.message ??
      `${response.status} ${response.statusText}`
    );
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

async function gatewayJson(
  path: string,
  init?: RequestInit
): Promise<VideoJob> {
  const response = await fetch(`${MEDIA_LITELLM_BASE_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...gatewayHeaders(Boolean(init?.body)),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new VideoGatewayError(
      await readGatewayError(response),
      response.status
    );
  }
  return (await response.json()) as VideoJob;
}

function nvidiaVideoFetch(videoId: string, content = false) {
  const suffix = content ? "/content" : "";
  return fetch(
    `${MEDIA_LITELLM_ORIGIN}/nvidia-videos/${encodeURIComponent(videoId)}${suffix}`,
    { cache: "no-store", headers: gatewayHeaders() }
  );
}

function mediaPassThroughFetch(path: string, init: RequestInit) {
  return fetch(`${MEDIA_LITELLM_ORIGIN}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...gatewayHeaders(false),
      ...init.headers,
    },
  });
}

// Node's built-in fetch gives up if an upstream sends no response headers for
// about five minutes. Cosmos3 Super is a synchronous generator and can
// legitimately take longer, so use the core HTTP client for this one route.
// The response is still capped by the same end-to-end video deadline.
function longMediaJsonPost(path: string, payload: Record<string, unknown>) {
  const url = new URL(`${MEDIA_LITELLM_ORIGIN}${path}`);
  const body = JSON.stringify(payload);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const startedAt = Date.now();

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout>;
    const finishWithError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      reject(error);
    };
    const outgoing = request(
      url,
      {
        headers: {
          ...gatewayHeaders(false),
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Content-Type": "application/json",
        },
        method: "POST",
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        incoming.on("error", finishWithError);
        incoming.on("end", () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(deadline);
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) {
                headers.append(name, item);
              }
            } else if (value !== undefined) {
              headers.set(name, String(value));
            }
          }
          logger.info("media.video.upstream_response", {
            durationMs: Date.now() - startedAt,
            path,
            status: incoming.statusCode ?? 500,
          });
          resolve(
            new Response(new Uint8Array(Buffer.concat(chunks)), {
              headers,
              status: incoming.statusCode ?? 500,
              statusText: incoming.statusMessage,
            })
          );
        });
      }
    );

    deadline = setTimeout(() => {
      outgoing.destroy(
        new Error("Video provider did not respond before the deadline")
      );
    }, VIDEO_TIMEOUT_MS);
    outgoing.on("error", finishWithError);
    outgoing.end(body);
  });
}

function base64VideoFromPayload(payload: DirectVideoPayload) {
  const { video } = payload;
  const interactionVideos = [
    ...(payload.steps ?? []).flatMap((step) => step.content ?? []),
    ...(payload.outputs ?? []).flatMap((output) => output.content ?? [output]),
  ].filter((content) => content.type === "video");
  return (
    payload.b64_video ??
    (typeof video === "string" ? video : video?.bytesBase64Encoded) ??
    payload.output_video?.data ??
    interactionVideos.find((content) => content.data)?.data ??
    payload.data?.[0]?.b64_json ??
    payload.generatedVideo?.video?.bytesBase64Encoded ??
    payload.output?.video?.bytesBase64Encoded ??
    payload.response?.generateVideoResponse?.generatedSamples?.[0]?.video
      ?.bytesBase64Encoded
  );
}

function videoUrlFromPayload(payload: DirectVideoPayload) {
  const { video } = payload;
  const interactionVideos = [
    ...(payload.steps ?? []).flatMap((step) => step.content ?? []),
    ...(payload.outputs ?? []).flatMap((output) => output.content ?? [output]),
  ].filter((content) => content.type === "video");
  return (
    (typeof video === "object" ? video?.uri : undefined) ??
    payload.output_video?.uri ??
    interactionVideos.find((content) => content.uri)?.uri ??
    payload.data?.[0]?.url ??
    payload.generatedVideo?.video?.uri ??
    payload.output?.video?.uri ??
    payload.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
  );
}

async function readDirectVideoPayload(payload: DirectVideoPayload) {
  const encoded = base64VideoFromPayload(payload);
  if (encoded) {
    const normalized = encoded.includes(",")
      ? (encoded.split(",").at(-1) ?? "")
      : encoded;
    return {
      bytes: new Uint8Array(Buffer.from(normalized, "base64")),
      mediaType: "video/mp4",
    };
  }

  const url = videoUrlFromPayload(payload);
  if (url && /^https:\/\//i.test(url)) {
    const downloaded = await fetch(url, { cache: "no-store" });
    if (!downloaded.ok) {
      throw new Error("The generated video download failed");
    }
    return {
      bytes: new Uint8Array(await downloaded.arrayBuffer()),
      mediaType:
        downloaded.headers.get("content-type") === "video/webm"
          ? "video/webm"
          : "video/mp4",
    };
  }

  throw new Error(
    `Video provider returned no playable media (fields: ${Object.keys(payload)
      .sort()
      .join(", ")})`
  );
}

async function readDirectVideoResponse(response: Response) {
  if (!response.ok) {
    throw new VideoGatewayError(
      await readGatewayError(response),
      response.status
    );
  }
  const contentType = response.headers.get("content-type")?.split(";")[0];
  if (contentType?.startsWith("video/")) {
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mediaType: contentType === "video/webm" ? "video/webm" : "video/mp4",
    };
  }

  return readDirectVideoPayload((await response.json()) as DirectVideoPayload);
}

async function waitForGeminiInteraction(interactionId: string) {
  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Polling is sequential because each lookup follows a provider-side wait.
    // biome-ignore lint/performance/noAwaitInLoops: intentionally sequential polling
    const response = await mediaPassThroughFetch(
      `/nvidia-interactions/${encodeURIComponent(interactionId)}`,
      { method: "GET" }
    );
    if (!response.ok) {
      throw new VideoGatewayError(
        await readGatewayError(response),
        response.status
      );
    }
    const payload = (await response.json()) as DirectVideoPayload;
    const status = payload.status?.toLowerCase();
    if (status === "completed" || base64VideoFromPayload(payload)) {
      return readDirectVideoPayload(payload);
    }
    if (["failed", "cancelled", "incomplete"].includes(status ?? "")) {
      throw new Error(payload.error?.message ?? `Gemini interaction ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
  }
  throw new Error("Gemini video generation timed out");
}

function imageFileFromDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s);
  if (!match) {
    return null;
  }
  const [, mediaType, encoded] = match;
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  const extension =
    mediaType === "image/jpeg" ? "jpg" : mediaType.split("/")[1];
  return { bytes, filename: `source.${extension}`, mediaType };
}

function interactionMediaFromDataUrl(dataUrl: string, type: "image" | "video") {
  const match = dataUrl.match(
    /^data:((?:image\/(?:jpeg|png|webp))|(?:video\/(?:mp4|webm)));base64,(.+)$/s
  );
  if (!match?.[1] || !match[2] || !match[1].startsWith(`${type}/`)) {
    throw new Error(`The ${type} input could not be read`);
  }
  return {
    data: match[2],
    mime_type: match[1],
    type,
  };
}

async function createGatewayVideo({
  inputImage,
  model,
  prompt,
  settings,
}: {
  inputImage?: string;
  model: string;
  prompt: string;
  settings: { seconds?: string; size?: string };
}): Promise<VideoJob> {
  if (!inputImage) {
    return gatewayJson("/videos", {
      body: JSON.stringify({ model, prompt, ...settings }),
      method: "POST",
    });
  }

  const imageFile = imageFileFromDataUrl(inputImage);
  if (!imageFile) {
    throw new Error("The video reference image could not be read");
  }
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  if (settings.seconds) {
    form.set("seconds", settings.seconds);
  }
  if (settings.size) {
    form.set("size", settings.size);
  }
  form.set(
    "input_reference",
    new Blob([imageFile.bytes], { type: imageFile.mediaType }),
    imageFile.filename
  );
  const response = await fetch(`${MEDIA_LITELLM_BASE_URL}/videos`, {
    body: form,
    cache: "no-store",
    headers: gatewayHeaders(),
    method: "POST",
  });
  if (!response.ok) {
    throw new VideoGatewayError(
      await readGatewayError(response),
      response.status
    );
  }
  return (await response.json()) as VideoJob;
}

async function generateDirectVideo(
  model: string,
  prompt: string,
  inputImage?: string,
  inputVideo?: string,
  quality: VideoQuality = "high"
) {
  if (model === "nvidia/nvidia/cosmos3-nano") {
    const form = new FormData();
    form.set("prompt", prompt);
    const imageFile = inputImage ? imageFileFromDataUrl(inputImage) : null;
    if (imageFile) {
      form.set(
        "input_reference",
        new Blob([imageFile.bytes], { type: imageFile.mediaType }),
        imageFile.filename
      );
    }
    // Inference Hub accepts a prompt-only request but currently resolves it to
    // a single-frame MP4. Send the complete vLLM-Omni generation controls from
    // NVIDIA's Cosmos3 Nano example so this endpoint produces motion.
    form.set("negative_prompt", "blurry, distorted, low quality, static image");
    // NVIDIA's hosted gateway returns a 504 at roughly one minute. Use the
    // supported 256p profile so a real multi-frame result can finish inside
    // that gateway window; the former 720p request exceeded it.
    form.set("size", "320x192");
    form.set("num_frames", "189");
    form.set("fps", "24");
    form.set("num_inference_steps", "35");
    form.set("guidance_scale", "4.0");
    form.set("seed", "42");
    let response = await mediaPassThroughFetch("/nvidia-cosmos-nano-video", {
      body: form,
      method: "POST",
    });
    if (response.status === 415 || response.status === 422) {
      response = await mediaPassThroughFetch("/nvidia-cosmos-nano-video", {
        body: JSON.stringify({
          fps: 24,
          guidance_scale: 4,
          negative_prompt: "blurry, distorted, low quality, static image",
          num_frames: 189,
          num_inference_steps: 35,
          prompt,
          ...(inputImage ? { input_reference: inputImage } : {}),
          seed: 42,
          size: "320x192",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    }
    return readDirectVideoResponse(response);
  }

  if (model === "nvidia/nvidia/cosmos3-super") {
    const response = await longMediaJsonPost("/nvidia-cosmos-super-video", {
      fps: 24,
      guidance_scale: 6,
      ...(inputImage ? { image: inputImage } : {}),
      num_output_frames: 121,
      prompt,
      resolution: getCosmosSuperResolution(quality),
      seed: 42,
      steps: 35,
    });
    return readDirectVideoResponse(response);
  }

  if (model === "gemini-omni-flash-preview") {
    const mediaInput = [
      ...(inputImage ? [interactionMediaFromDataUrl(inputImage, "image")] : []),
      ...(inputVideo ? [interactionMediaFromDataUrl(inputVideo, "video")] : []),
      { text: prompt, type: "text" },
    ];
    const input = inputVideo
      ? [{ content: mediaInput, type: "user_input" }]
      : inputImage
        ? mediaInput
        : prompt;
    let interactionModel = "gcp/google/gemini-omni-flash-preview";
    let response = await mediaPassThroughFetch("/nvidia-interactions", {
      body: JSON.stringify({
        background: true,
        input,
        model: interactionModel,
        response_format: {
          aspect_ratio: "16:9",
          delivery: "inline",
          type: "video",
        },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if ([400, 404, 422].includes(response.status)) {
      interactionModel = model;
      response = await mediaPassThroughFetch("/nvidia-interactions", {
        body: JSON.stringify({
          background: true,
          input,
          model: interactionModel,
          response_format: {
            aspect_ratio: "16:9",
            delivery: "inline",
            type: "video",
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    }
    if (!response.ok) {
      throw new VideoGatewayError(
        await readGatewayError(response),
        response.status
      );
    }
    const payload = (await response.json()) as DirectVideoPayload;
    const status = payload.status?.toLowerCase();
    if ((status === "in_progress" || status === "queued") && payload.id) {
      return waitForGeminiInteraction(payload.id);
    }
    return readDirectVideoPayload(payload);
  }

  return null;
}

function isPendingLookupError(error: unknown) {
  return (
    error instanceof VideoGatewayError &&
    (error.status === 404 ||
      error.status === 409 ||
      error.message.toLowerCase().includes("not found"))
  );
}

async function waitForVideo(videoId: string): Promise<VideoJob> {
  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  let lastProgress = -1;
  let loggedPendingLookup = false;
  while (Date.now() < deadline) {
    // Each status request depends on the preceding wait; parallel polling would
    // increase load without making the provider job finish sooner.
    // biome-ignore lint/performance/noAwaitInLoops: intentionally sequential polling
    const response = await nvidiaVideoFetch(videoId);
    if (!response.ok) {
      const error = new VideoGatewayError(
        await readGatewayError(response),
        response.status
      );
      if (isPendingLookupError(error)) {
        if (!loggedPendingLookup) {
          logger.info("media.video.pending_registration", {
            status: error.status,
            videoIdLength: videoId.length,
          });
          loggedPendingLookup = true;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, VIDEO_POLL_INTERVAL_MS)
        );
        continue;
      }
      throw error;
    }
    const job = (await response.json()) as VideoJob;
    const status = job.status?.toLowerCase();
    if (status === "completed" || status === "succeeded") {
      return job;
    }
    if (status === "failed" || status === "cancelled" || status === "expired") {
      throw new Error(job.error?.message ?? `Video job ${status}`);
    }
    const progress = job.progress ?? -1;
    if (progress !== lastProgress) {
      logger.debug("media.video.progress", {
        progress,
        status: status ?? "unknown",
        videoId,
      });
      lastProgress = progress;
    }
    await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
  }
  throw new Error("Video generation timed out");
}

export function createGenerateVideoTool(
  session: Session,
  preferredModel?: string
) {
  return tool({
    description:
      "Generate a video from a text prompt and return a playable video in this chat. Use this when the user asks to create, render, or generate a video.",
    execute: ({ model: requestedModel, prompt }) =>
      generateVideo({ preferredModel, prompt, requestedModel, session }),
    inputSchema: z.object({
      model: z
        .string()
        .optional()
        .describe(
          "Optional exact video model ID; omit to use the preferred model"
        ),
      prompt: z.string().min(1).max(4000),
    }),
  });
}

export async function generateVideo({
  inputImage,
  inputVideo,
  preferredModel,
  prompt,
  quality: requestedQuality,
  requestedModel,
  session,
}: {
  inputImage?: string;
  inputVideo?: string;
  preferredModel?: string;
  prompt: string;
  quality?: VideoQuality;
  requestedModel?: string;
  session: Session;
}) {
  const startedAt = Date.now();
  // A UI selection is authoritative. The conversational model may still
  // suggest a model when the user leaves the selector on its default.
  const selected = await resolveVideoModel(preferredModel ?? requestedModel);
  const quality = normalizeVideoQuality(selected.id, requestedQuality);
  const inputCapabilities = getVideoInputCapabilities(selected.id);
  logger.info("media.video.start", {
    inputImage: Boolean(inputImage),
    inputVideo: Boolean(inputVideo),
    model: selected.id,
    promptLength: prompt.length,
    quality,
    userId: session.user.id,
  });

  try {
    if (inputImage && !inputCapabilities.image) {
      throw new Error("The selected video model does not accept image input");
    }
    if (inputVideo && !inputCapabilities.video) {
      throw new Error("The selected video model does not accept video input");
    }
    const direct = await generateDirectVideo(
      selected.id,
      prompt,
      inputImage,
      inputVideo,
      quality
    );
    if (direct) {
      const stored = await storeGeneratedVideo({
        bytes: direct.bytes,
        mediaType: direct.mediaType,
        userId: session.user.id,
      });
      logger.info("media.video.complete", {
        byteLength: direct.bytes.byteLength,
        durationMs: Date.now() - startedAt,
        mediaType: direct.mediaType,
        model: selected.id,
        quality,
        sourceImage: Boolean(inputImage),
        sourceVideo: Boolean(inputVideo),
        transport: "nvidia-passthrough",
        userId: session.user.id,
      });
      return {
        mediaType: direct.mediaType,
        model: selected.id,
        modelName: selected.name,
        prompt,
        quality,
        url: stored.url,
      };
    }

    const created = await createGatewayVideo({
      inputImage,
      model: selected.id,
      prompt,
      settings: getVeoRequestSettings(selected.id, quality),
    });
    if (!created.id) {
      throw new Error("Video gateway returned no job ID");
    }
    logger.info("media.video.accepted", {
      encodedJobId: created.id.startsWith("video_"),
      model: selected.id,
      quality,
      status: created.status ?? "unknown",
      videoIdLength: created.id.length,
    });
    const completed =
      created.status?.toLowerCase() === "completed"
        ? created
        : await waitForVideo(created.id);
    const videoId = completed.id ?? created.id;
    const response = await nvidiaVideoFetch(videoId, true);
    if (!response.ok) {
      throw new Error(await readGatewayError(response));
    }
    const contentType = response.headers.get("content-type")?.split(";")[0];
    const mediaType = contentType === "video/webm" ? "video/webm" : "video/mp4";
    const bytes = new Uint8Array(await response.arrayBuffer());
    const stored = await storeGeneratedVideo({
      bytes,
      mediaType,
      userId: session.user.id,
    });
    logger.info("media.video.complete", {
      byteLength: bytes.byteLength,
      durationMs: Date.now() - startedAt,
      mediaType,
      model: selected.id,
      quality,
      userId: session.user.id,
    });
    return {
      mediaType,
      model: selected.id,
      modelName: selected.name,
      prompt,
      quality,
      url: stored.url,
    };
  } catch (error) {
    logger.error("media.video.error", {
      durationMs: Date.now() - startedAt,
      error,
      model: selected.id,
      quality,
      userId: session.user.id,
    });
    const clientTimedOut =
      error instanceof Error &&
      (error.message.includes("before the deadline") ||
        error.name === "HeadersTimeoutError" ||
        error.message.includes("Headers Timeout Error"));
    const gatewayTimedOut =
      error instanceof VideoGatewayError && error.status === 504;
    return {
      error: clientTimedOut
        ? `${selected.name} did not return a video within nine minutes. The request reached the provider but timed out.`
        : gatewayTimedOut
          ? `${selected.name} reached the provider, but its gateway timed out before the video finished.`
          : "Video generation failed for this model. Try another video model.",
      mediaKind: "video" as const,
      model: selected.id,
      modelName: selected.name,
      retryable: clientTimedOut || gatewayTimedOut,
    };
  }
}
