import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";

import { auth } from "@/app/(auth)/auth";
import { resolveUploadPath } from "@/lib/storage";

const CONTENT_TYPES: Record<string, string> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await params;
  const filePath = resolveUploadPath(name);

  if (!filePath) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const stats = await stat(filePath);
    const extension = name.slice(name.lastIndexOf(".")).toLowerCase();

    return new NextResponse(
      Readable.toWeb(createReadStream(filePath)) as ReadableStream,
      {
        headers: {
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Length": String(stats.size),
          "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
        },
      }
    );
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
