"use server";

import { generateText, type UIMessage } from "ai";
import { cookies } from "next/headers";
import { auth } from "@/app/(auth)/auth";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { titleModel } from "@/lib/ai/models";
import { titlePrompt } from "@/lib/ai/prompts";
import { getTitleModel, refreshTitleModelId } from "@/lib/ai/providers";
import {
  deleteMessagesByChatIdAfterTimestamp,
  getChatById,
  getMessageById,
  updateChatVisibilityById,
} from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import { getTextFromMessage } from "@/lib/utils";

const refusalTitlePattern =
  /\b(?:i(?:'m| am) sorry|i can(?:not|'t) help|i can(?:not|'t) assist|unable to (?:help|assist|comply)|cannot (?:help|assist|comply)|not able to (?:help|assist))\b/i;

function localTitleFromText(text: string) {
  const normalized = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:make|create|generate|produce|render|show|draw|write)\s+(?:(?:me|us)\s+)?(?:(?:a|an|the)\s+)?/i,
      ""
    );
  const words = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  if (words.length === 0) {
    return "New Conversation";
  }
  const title = words.slice(0, 5).join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function usableGeneratedTitle(title: string) {
  const wordCount = title.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)?.length ?? 0;
  return (
    title.length > 0 &&
    title.length <= 100 &&
    wordCount > 0 &&
    wordCount <= 10 &&
    !refusalTitlePattern.test(title)
  );
}

export async function saveChatModelAsCookie(model: string) {
  const cookieStore = await cookies();
  cookieStore.set("chat-model", model);
}

export async function generateTitleFromUserMessage({
  message,
}: {
  message: UIMessage;
}) {
  const prompt = getTextFromMessage(message);
  const fallbackTitle = localTitleFromText(prompt);

  try {
    await refreshTitleModelId();
    const { text } = await generateText({
      instructions: titlePrompt,
      model: getTitleModel(),
      prompt,
      providerOptions: {
        gateway: { order: titleModel.gatewayOrder },
      },
    });
    const generatedTitle = text
      .replace(/^[#*"\s]+/, "")
      .replace(/["]+$/, "")
      .trim();

    if (usableGeneratedTitle(generatedTitle)) {
      return generatedTitle;
    }
    logger.warn("chat.title.fallback", {
      reason: refusalTitlePattern.test(generatedTitle)
        ? "model-refusal"
        : "invalid-model-output",
    });
  } catch (error) {
    logger.warn("chat.title.fallback", {
      error,
      reason: "model-error",
    });
  }

  return fallbackTitle;
}

export async function deleteTrailingMessages({ id }: { id: string }) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const [message] = await getMessageById({ id });
  if (!message) {
    throw new Error("Message not found");
  }

  const chat = await getChatById({ id: message.chatId });
  if (!chat || chat.userId !== session.user.id) {
    throw new Error("Unauthorized");
  }

  await deleteMessagesByChatIdAfterTimestamp({
    chatId: message.chatId,
    timestamp: message.createdAt,
  });
}

export async function updateChatVisibility({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: VisibilityType;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const chat = await getChatById({ id: chatId });
  if (!chat || chat.userId !== session.user.id) {
    throw new Error("Unauthorized");
  }

  await updateChatVisibilityById({ chatId, visibility });
}
