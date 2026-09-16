import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import { logger } from "@/lib/logger";
import { storeUploadedImage, storeUploadedVideo } from "@/lib/media-storage";

const IMAGE_UPLOAD_LIMIT = 5 * 1024 * 1024;
const VIDEO_UPLOAD_LIMIT = 25 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "video/mp4",
  "video/webm",
];

const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => ALLOWED_UPLOAD_TYPES.includes(file.type), {
      message: "File type should be JPEG, PNG, MP4, or WebM",
    })
    .refine(
      (file) =>
        file.size <=
        (file.type.startsWith("video/")
          ? VIDEO_UPLOAD_LIMIT
          : IMAGE_UPLOAD_LIMIT),
      { message: "Images must be under 5MB and videos under 25MB" }
    ),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.body === null) {
    return new Response("Request body is empty", { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file") as Blob;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.issues
        .map((error) => error.message)
        .join(", ");

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    const originalFilename = (formData.get("file") as File).name;
    const fileBuffer = new Uint8Array(await file.arrayBuffer());

    try {
      const stored = file.type.startsWith("video/")
        ? await storeUploadedVideo({
            bytes: fileBuffer,
            mediaType: file.type,
            userId: session.user.id,
          })
        : await storeUploadedImage({
            bytes: fileBuffer,
            mediaType: file.type,
            userId: session.user.id,
          });
      const url = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${stored.url}`;
      logger.info("file.upload.complete", {
        byteLength: fileBuffer.byteLength,
        mediaType: file.type,
        originalFilename,
        storedFilename: stored.filename,
        userId: session.user.id,
      });
      return NextResponse.json({
        contentType: file.type,
        pathname: stored.filename,
        url,
      });
    } catch (error) {
      logger.error("file.upload.storage_error", {
        error,
        mediaType: file.type,
        originalFilename,
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }
  } catch (error) {
    logger.error("file.upload.request_error", { error });
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
