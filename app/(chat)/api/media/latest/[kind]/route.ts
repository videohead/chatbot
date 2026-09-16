import { auth } from "@/app/(auth)/auth";
import { latestOwnedMediaFilename } from "@/lib/media-storage";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { kind } = await params;
  if (kind !== "image" && kind !== "video") {
    return new Response("Not found", { status: 404 });
  }

  try {
    const filename = await latestOwnedMediaFilename(session.user.id, kind);
    if (!filename) {
      return new Response("Not found", { status: 404 });
    }
    const destination = new URL(
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/media/files/${filename}`,
      request.url
    );
    return Response.redirect(destination, 307);
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
