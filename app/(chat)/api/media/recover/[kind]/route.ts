import { randomUUID } from "node:crypto";
import { auth } from "@/app/(auth)/auth";
import {
  getChatById,
  getMessagesByChatId,
  saveMessages,
  updateMessage,
} from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { closestOwnedMediaFilename } from "@/lib/media-storage";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { kind } = await params;
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chatId") ?? "";
  const completedAt = new Date(searchParams.get("completedAt") ?? "");
  if (kind !== "video" || !UUID_PATTERN.test(chatId)) {
    return new Response("Not found", { status: 404 });
  }
  if (!Number.isFinite(completedAt.getTime())) {
    return new Response("A valid completion time is required", { status: 400 });
  }

  const chat = await getChatById({ id: chatId });
  if (!chat || chat.userId !== session.user.id) {
    return new Response("Not found", { status: 404 });
  }

  const filename = await closestOwnedMediaFilename(
    session.user.id,
    "video",
    completedAt
  );
  if (!filename) {
    return new Response("No generated video was found", { status: 404 });
  }

  const url = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/media/files/${filename}`;
  const messages = await getMessagesByChatId({ id: chatId });
  const recoveredMessage = messages.find((message) =>
    JSON.stringify(message.parts).includes("Recovered generated video")
  );
  const alreadyAttached = messages.some((message) =>
    JSON.stringify(message.parts).includes(url)
  );

  if (!alreadyAttached || recoveredMessage) {
    const toolCallId = randomUUID();
    const parts = [
      {
        input: {
          model: "gcp/google/veo-3.1-generate-001",
          prompt: "Recovered generated video",
        },
        output: {
          mediaType: "video/mp4",
          model: "gcp/google/veo-3.1-generate-001",
          modelName: "Veo 3.1",
          prompt: "Recovered generated video",
          url,
        },
        state: "output-available",
        toolCallId,
        type: "tool-generateVideo",
      },
      {
        data: {
          model: "gcp/google/gemini-3.5-flash",
          modelName: "Gemini 3.5 Flash",
        },
        type: "data-model-attribution",
      },
    ] as DBMessage["parts"];

    if (recoveredMessage) {
      await updateMessage({ id: recoveredMessage.id, parts });
    } else {
      await saveMessages({
        messages: [
          {
            attachments: [],
            chatId,
            createdAt: new Date(),
            id: randomUUID(),
            parts,
            role: "assistant",
          },
        ],
      });
    }
  }

  return Response.redirect(new URL(`/chat/${chatId}`, request.url), 303);
}
