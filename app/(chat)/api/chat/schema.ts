import { z } from "zod";
import { IMAGE_SIZE_IDS, VIDEO_QUALITY_IDS } from "@/lib/ai/media-settings";

const textPartSchema = z.object({
  text: z.string().min(1).max(2000),
  type: z.enum(["text"]),
});

const ownedMediaUrlSchema = z
  .string()
  .regex(
    /^\/(?:[^/?#]+\/)*api\/media\/files\/[0-9a-f-]{36}\.(?:jpg|png|webp|mp4|webm)$/i,
    "Invalid local media URL"
  );

const filePartSchema = z.object({
  mediaType: z.enum(["image/jpeg", "image/png", "video/mp4", "video/webm"]),
  name: z.string().min(1).max(100),
  type: z.enum(["file"]),
  url: z.union([z.url(), ownedMediaUrlSchema]),
});

const partSchema = z.union([textPartSchema, filePartSchema]);

const userMessageSchema = z.object({
  id: z.uuid(),
  parts: z.array(partSchema),
  role: z.enum(["user"]),
});

const toolApprovalMessageSchema = z.object({
  id: z.string(),
  parts: z.array(z.record(z.string(), z.unknown())),
  role: z.enum(["user", "assistant"]),
});

export const postRequestBodySchema = z.object({
  generationMode: z.enum(["chat", "image", "video"]).default("chat"),
  id: z.uuid(),
  message: userMessageSchema.optional(),
  messages: z.array(toolApprovalMessageSchema).optional(),
  selectedChatModel: z.string(),
  selectedImageModel: z.string().max(200).optional(),
  selectedImageSize: z.enum(IMAGE_SIZE_IDS).default("1024x1024"),
  selectedVideoModel: z.string().max(200).optional(),
  selectedVideoQuality: z.enum(VIDEO_QUALITY_IDS).default("auto"),
  selectedVisibilityType: z.enum(["public", "private"]),
});

export type PostRequestBody = z.infer<typeof postRequestBodySchema>;
