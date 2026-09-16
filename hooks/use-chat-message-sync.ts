"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { useCallback, useEffect, useRef } from "react";
import type { ChatMessage } from "@/lib/types";

export function shouldHydrateServerMessages({
  chatId,
  isNewChat,
  locallyChanged,
  serverMessagesAvailable,
  status,
  visitChatId,
}: {
  chatId: string;
  isNewChat: boolean;
  locallyChanged: boolean;
  serverMessagesAvailable: boolean;
  status: UseChatHelpers<ChatMessage>["status"];
  visitChatId: string;
}) {
  return (
    !isNewChat &&
    serverMessagesAvailable &&
    status === "ready" &&
    visitChatId === chatId &&
    !locallyChanged
  );
}

/**
 * Hydrate a conversation from the server without letting a stale history
 * response replace messages created during the current visit.
 */
export function useChatMessageSync({
  chatId,
  isNewChat,
  serverMessages,
  setMessages,
  status,
}: {
  chatId: string;
  isNewChat: boolean;
  serverMessages: ChatMessage[] | undefined;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  status: UseChatHelpers<ChatMessage>["status"];
}) {
  const visit = useRef({ chatId, locallyChanged: isNewChat });

  if (visit.current.chatId !== chatId) {
    visit.current = { chatId, locallyChanged: isNewChat };
  }

  if (status === "submitted" || status === "streaming") {
    visit.current.locallyChanged = true;
  }

  const markLocalChange = useCallback(() => {
    if (visit.current.chatId === chatId) {
      visit.current.locallyChanged = true;
    }
  }, [chatId]);

  useEffect(() => {
    if (
      serverMessages &&
      shouldHydrateServerMessages({
        chatId,
        isNewChat,
        locallyChanged: visit.current.locallyChanged,
        serverMessagesAvailable: true,
        status,
        visitChatId: visit.current.chatId,
      })
    ) {
      setMessages(serverMessages);
    }
  }, [chatId, isNewChat, serverMessages, setMessages, status]);

  return markLocalChange;
}
