import { generateImage as generateImageWithAi, tool } from "ai";
import type { Session } from "next-auth";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { storeGeneratedImage } from "@/lib/media-storage";
import { resolveImageModel } from "../media-models";
import {
  IMAGE_SIZE_IDS,
  type ImageSize,
  supportsImageInput,
} from "../media-settings";
import { editImageWithMediaGateway, getImageModel } from "../providers";

const imageSizeSchema = z.enum(IMAGE_SIZE_IDS);

export function createGenerateImageTool(
  session: Session,
  preferredModel?: string
) {
  return tool({
    description:
      "Generate an image from a text prompt and return it in this chat. Use this when the user asks to create, draw, render, or generate an image.",
    execute: ({ model: requestedModel, prompt, size }) =>
      generateImageForChat({
        preferredModel,
        prompt,
        requestedModel,
        session,
        size,
      }),
    inputSchema: z.object({
      model: z
        .string()
        .optional()
        .describe(
          "Optional exact image model ID; omit to use the preferred model"
        ),
      prompt: z.string().min(1).max(4000),
      size: imageSizeSchema.optional().default("1024x1024"),
    }),
  });
}

export async function generateImageForChat({
  preferredModel,
  prompt,
  requestedModel,
  session,
  size = "1024x1024",
  sourceImage,
}: {
  preferredModel?: string;
  prompt: string;
  requestedModel?: string;
  session: Session;
  size?: ImageSize;
  sourceImage?: string;
}) {
  const startedAt = Date.now();
  const selected = await resolveImageModel(preferredModel ?? requestedModel);
  logger.info("media.image.start", {
    model: selected.id,
    promptLength: prompt.length,
    referenceImage: Boolean(sourceImage),
    size,
    userId: session.user.id,
  });

  try {
    if (sourceImage && !supportsImageInput(selected.id)) {
      throw new Error(
        "The selected image model does not support reference images"
      );
    }
    const generated = sourceImage
      ? await editImageWithMediaGateway({
          modelId: selected.id,
          prompt,
          size,
          sourceImage,
        })
      : await generateImageWithAi({
          model: getImageModel(selected.id),
          prompt,
          providerOptions: {
            media: { response_format: "b64_json" },
          },
          size,
        }).then(({ image }) => ({
          bytes: image.uint8Array,
          mediaType: image.mediaType,
        }));
    const stored = await storeGeneratedImage({
      bytes: generated.bytes,
      mediaType: generated.mediaType,
      userId: session.user.id,
    });
    logger.info("media.image.complete", {
      byteLength: generated.bytes.byteLength,
      durationMs: Date.now() - startedAt,
      mediaType: generated.mediaType,
      model: selected.id,
      referenceImage: Boolean(sourceImage),
      userId: session.user.id,
    });
    return {
      mediaType: generated.mediaType,
      model: selected.id,
      modelName: selected.name,
      prompt,
      referenceImage: Boolean(sourceImage),
      size,
      url: stored.url,
    };
  } catch (error) {
    logger.error("media.image.error", {
      durationMs: Date.now() - startedAt,
      error,
      model: selected.id,
      userId: session.user.id,
    });
    return {
      error: "Image generation failed for this model. Try another image model.",
      model: selected.id,
      modelName: selected.name,
    };
  }
}
