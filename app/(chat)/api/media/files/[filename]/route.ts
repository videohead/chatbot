import { auth } from "@/app/(auth)/auth";
import { mediaTypeForFilename, readOwnedMedia } from "@/lib/media-storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { filename } = await params;
  try {
    const bytes = await readOwnedMedia(session.user.id, filename);
    return new Response(bytes, {
      headers: {
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Content-Type": mediaTypeForFilename(filename),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
