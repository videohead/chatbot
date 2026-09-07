import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import { UPLOAD_DIR } from "@/lib/storage";

const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= 5 * 1024 * 1024, {
      message: "File size should be less than 5MB",
    })
    .refine((file) => ["image/jpeg", "image/png"].includes(file.type), {
      message: "File type should be JPEG or PNG",
    }),
});

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
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

    const originalName = (formData.get("file") as File).name;
    // Keep only the basename so a crafted name cannot escape the upload directory.
    const safeName = path
      .basename(originalName)
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(-100);
    const storedName = `${randomUUID()}-${safeName}`;

    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(
      path.join(UPLOAD_DIR, storedName),
      Buffer.from(await file.arrayBuffer())
    );

    const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

    return NextResponse.json({
      contentType: file.type,
      downloadUrl: `${basePath}/api/files/${storedName}`,
      pathname: storedName,
      url: `${basePath}/api/files/${storedName}`,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 }
    );
  }
}
