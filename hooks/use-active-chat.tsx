"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { usePathname } from "next/navigation";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import useSWR, { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { useDataStream } from "@/components/chat/data-stream-provider";
import { getChatHistoryPaginationKey } from "@/components/chat/sidebar-history";
import { toast } from "@/components/chat/toast";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { useAutoResume } from "@/hooks/use-auto-resume";
import { useChatMessageSync } from "@/hooks/use-chat-message-sync";
import {
  normalizeImageSize,
  normalizeVideoQuality,
} from "@/lib/ai/media-settings";
import type { Vote } from "@/lib/db/schema";
import { ChatbotError } from "@/lib/errors";
import type { ChatMessage } from "@/lib/types";
import { fetcher, fetchWithErrorHandlers, generateUUID } from "@/lib/utils";

type ActiveChatContextValue = {
  chatId: string;
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  status: UseChatHelpers<ChatMessage>["status"];
  stop: UseChatHelpers<ChatMessage>["stop"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  visibilityType: VisibilityType;
  isReadonly: boolean;
  isLoading: boolean;
  votes: Vote[] | undefined;
  currentModelId: string;
  setCurrentModelId: (id: string) => void;
  showCreditCardAlert: boolean;
  setShowCreditCardAlert: Dispatch<SetStateAction<boolean>>;
  chatErrorMessage: string | null;
};

const ActiveChatContext = createContext<ActiveChatContextValue | null>(null);

function extractChatId(pathname: string): string | null {
  const match = pathname.match(/\/chat\/([^/]+)/);
  return match ? match[1] : null;
}

function hasPendingMedia(messages: ChatMessage[] | undefined) {
  return Boolean(
    messages?.some(
      (message) =>
        message.role === "assistant" &&
        message.parts.some((part) => {
          if (
            part.type !== "tool-generateImage" &&
            part.type !== "tool-generateVideo"
          ) {
            return false;
          }
          return (
            part.state === "input-available" || part.state === "input-streaming"
          );
        })
    )
  );
}

type StoredChatModel = {
  id: string;
  selectedAt: number;
};

function readStoredChatModel(chatId: string): StoredChatModel | undefined {
  const value = window.localStorage.getItem(`chat-model:${chatId}`);
  if (!value) {
    return;
  }

  try {
    const parsed = JSON.parse(value) as Partial<StoredChatModel> | null;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.id === "string" &&
      parsed.id
    ) {
      return {
        id: parsed.id,
        selectedAt:
          typeof parsed.selectedAt === "number" ? parsed.selectedAt : 0,
      };
    }
  } catch {
    // Accept the earlier plain-string format if one exists in local storage.
    return { id: value, selectedAt: 0 };
  }
}

function latestChatResponseModel(messages: ChatMessage[] | undefined) {
  if (!messages) {
    return;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const isDirectMedia = message.parts.some(
      (part) =>
        part.type === "tool-generateImage" || part.type === "tool-generateVideo"
    );
    if (
      message.role === "assistant" &&
      !isDirectMedia &&
      message.metadata?.model
    ) {
      return {
        id: message.metadata.model,
        usedAt: Date.parse(message.metadata.createdAt) || 0,
      };
    }
  }
}

function writeChatModelCookie(modelId: string) {
  const maxAge = 60 * 60 * 24 * 365;
  // biome-ignore lint/suspicious/noDocumentCookie: client preference cookie
  document.cookie = `chat-model=${encodeURIComponent(modelId)}; path=/; max-age=${maxAge}`;
}

export function ActiveChatProvider({
  children,
  initialModelId,
}: {
  children: ReactNode;
  initialModelId: string;
}) {
  const pathname = usePathname();
  const [recentModelId, setRecentModelId] = useState(initialModelId);
  const chatIdFromUrl = extractChatId(pathname);
  const isNewChat = !chatIdFromUrl;
  const newChatIdRef = useRef(generateUUID());
  const prevPathnameRef = useRef(pathname);

  if (isNewChat && prevPathnameRef.current !== pathname) {
    newChatIdRef.current = generateUUID();
  }
  prevPathnameRef.current = pathname;

  const chatId = chatIdFromUrl ?? newChatIdRef.current;

  return (
    <ActiveChatSessionProvider
      chatId={chatId}
      initialModelId={recentModelId}
      isNewChat={isNewChat}
      key={chatId}
      onRecentModelChange={setRecentModelId}
    >
      {children}
    </ActiveChatSessionProvider>
  );
}

function ActiveChatSessionProvider({
  children,
  chatId,
  initialModelId,
  isNewChat,
  onRecentModelChange,
}: {
  children: ReactNode;
  chatId: string;
  initialModelId: string;
  isNewChat: boolean;
  onRecentModelChange: (modelId: string) => void;
}) {
  const { setDataStream, setWaitingStatus } = useDataStream();
  const { mutate } = useSWRConfig();

  const [currentModelId, setCurrentModelIdState] = useState(initialModelId);
  const currentModelIdRef = useRef(currentModelId);
  useEffect(() => {
    currentModelIdRef.current = currentModelId;
  }, [currentModelId]);

  const setCurrentModelId = useCallback(
    (modelId: string) => {
      currentModelIdRef.current = modelId;
      setCurrentModelIdState(modelId);
      window.localStorage.setItem(
        `chat-model:${chatId}`,
        JSON.stringify({ id: modelId, selectedAt: Date.now() })
      );
      writeChatModelCookie(modelId);
      onRecentModelChange(modelId);
    },
    [chatId, onRecentModelChange]
  );

  const [input, setInput] = useState("");
  const [showCreditCardAlert, setShowCreditCardAlert] = useState(false);
  const [chatErrorMessage, setChatErrorMessage] = useState<string | null>(null);

  const messagesApiUrl = isNewChat
    ? null
    : `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/messages?chatId=${chatId}`;
  const { data: chatData, isLoading } = useSWR(messagesApiUrl, fetcher, {
    dedupingInterval: 1000,
    refreshInterval: (latestData) =>
      hasPendingMedia(latestData?.messages) ? 3000 : 0,
    revalidateOnFocus: false,
  });

  const initialMessages: ChatMessage[] = isNewChat
    ? []
    : (chatData?.messages ?? []);
  const visibility: VisibilityType = isNewChat
    ? "private"
    : (chatData?.visibility ?? "private");

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    resumeStream,
    addToolApprovalResponse,
  } = useChat<ChatMessage>({
    generateId: generateUUID,
    id: chatId,
    messages: initialMessages,
    onData: (dataPart) => {
      if (dataPart.type === "data-waiting-status") {
        setWaitingStatus(dataPart.data);
        return;
      }
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));
    },
    onError: (error) => {
      const message = error.message || "Oops, an error occurred!";
      setChatErrorMessage(message);
      if (error.message?.includes("AI Gateway requires a valid credit card")) {
        setShowCreditCardAlert(true);
      } else if (error instanceof ChatbotError) {
        toast({ description: message, type: "error" });
      } else {
        toast({
          description: message,
          type: "error",
        });
      }
    },
    onFinish: () => {
      setChatErrorMessage(null);
      mutate(unstable_serialize(getChatHistoryPaginationKey));
    },
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const lastMessage = currentMessages.at(-1);
      return (
        lastMessage?.parts?.some(
          (part) =>
            "state" in part &&
            part.state === "approval-responded" &&
            "approval" in part &&
            (part.approval as { approved?: boolean })?.approved === true
        ) ?? false
      );
    },
    transport: new DefaultChatTransport({
      api: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/chat`,
      fetch: fetchWithErrorHandlers,
      prepareSendMessagesRequest(request) {
        const lastMessage = request.messages.at(-1);
        const isToolApprovalContinuation =
          lastMessage?.role !== "user" ||
          request.messages.some((msg) =>
            msg.parts?.some((part) => {
              const { state } = part as { state?: string };
              return (
                state === "approval-responded" || state === "output-denied"
              );
            })
          );

        return {
          body: {
            id: request.id,
            ...(isToolApprovalContinuation
              ? { messages: request.messages }
              : { message: lastMessage }),
            generationMode: (() => {
              const stored = window.localStorage.getItem(
                `generation-mode:${request.id}`
              );
              return stored === "image" || stored === "video" ? stored : "chat";
            })(),
            selectedChatModel: currentModelIdRef.current,
            selectedImageModel:
              window.localStorage.getItem(`image-model:${request.id}`) ||
              undefined,
            selectedImageSize: (() => {
              const modelId = window.localStorage.getItem(
                `image-model:${request.id}`
              );
              return normalizeImageSize(
                modelId,
                window.localStorage.getItem(`image-size:${request.id}`)
              );
            })(),
            selectedVideoModel:
              window.localStorage.getItem(`video-model:${request.id}`) ||
              undefined,
            selectedVideoQuality: (() => {
              const modelId = window.localStorage.getItem(
                `video-model:${request.id}`
              );
              return normalizeVideoQuality(
                modelId,
                window.localStorage.getItem(`video-quality:${request.id}`)
              );
            })(),
            selectedVisibilityType: visibility,
            ...request.body,
          },
        };
      },
    }),
  });

  useEffect(() => {
    if (status === "submitted") {
      setChatErrorMessage(null);
    }
    if (status === "submitted" || status === "ready" || status === "error") {
      setWaitingStatus(undefined);
    }
  }, [status, setWaitingStatus]);

  const markLocalChange = useChatMessageSync({
    chatId,
    isNewChat,
    serverMessages: chatData?.messages,
    setMessages,
    status,
  });
  const updateCurrentMessages = useCallback(
    (...args: Parameters<typeof setMessages>) => {
      markLocalChange();
      return setMessages(...args);
    },
    [markLocalChange, setMessages]
  );
  const sendCurrentMessage = useCallback(
    (...args: Parameters<typeof sendMessage>) => {
      markLocalChange();
      return sendMessage(...args);
    },
    [markLocalChange, sendMessage]
  );
  const regenerateCurrentMessage = useCallback(
    (...args: Parameters<typeof regenerate>) => {
      markLocalChange();
      return regenerate(...args);
    },
    [markLocalChange, regenerate]
  );
  const approveCurrentTool = useCallback(
    (...args: Parameters<typeof addToolApprovalResponse>) => {
      markLocalChange();
      return addToolApprovalResponse(...args);
    },
    [addToolApprovalResponse, markLocalChange]
  );

  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      setChatErrorMessage(null);
      if (isNewChat) {
        setMessages([]);
      }
    }
  }, [chatId, isNewChat, setMessages]);

  useEffect(() => {
    const stored = readStoredChatModel(chatId);
    const responseModel = latestChatResponseModel(chatData?.messages);
    const nextModel =
      stored && (!responseModel || stored.selectedAt >= responseModel.usedAt)
        ? stored.id
        : (responseModel?.id ?? initialModelId);

    if (currentModelIdRef.current !== nextModel) {
      currentModelIdRef.current = nextModel;
      setCurrentModelIdState(nextModel);
    }
    writeChatModelCookie(nextModel);
    onRecentModelChange(nextModel);
  }, [chatData?.messages, chatId, initialModelId, onRecentModelChange]);

  const hasAppendedQueryRef = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("query");
    if (query && !hasAppendedQueryRef.current) {
      hasAppendedQueryRef.current = true;
      window.history.replaceState(
        {},
        "",
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}`
      );
      sendCurrentMessage({
        parts: [{ text: query, type: "text" }],
        role: "user" as const,
      });
    }
  }, [sendCurrentMessage, chatId]);

  useAutoResume({
    autoResume: !isNewChat && !!chatData,
    initialMessages,
    resumeStream,
    setMessages: updateCurrentMessages,
  });

  const isReadonly = isNewChat ? false : (chatData?.isReadonly ?? false);

  const { data: votes } = useSWR<Vote[]>(
    !isReadonly && messages.length >= 2
      ? `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/vote?chatId=${chatId}`
      : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const value = useMemo<ActiveChatContextValue>(
    () => ({
      addToolApprovalResponse: approveCurrentTool,
      chatErrorMessage,
      chatId,
      currentModelId,
      input,
      isLoading: !isNewChat && isLoading,
      isReadonly,
      messages,
      regenerate: regenerateCurrentMessage,
      sendMessage: sendCurrentMessage,
      setCurrentModelId,
      setInput,
      setMessages: updateCurrentMessages,
      setShowCreditCardAlert,
      showCreditCardAlert,
      status,
      stop,
      visibilityType: visibility,
      votes,
    }),
    [
      chatId,
      chatErrorMessage,
      messages,
      updateCurrentMessages,
      sendCurrentMessage,
      status,
      stop,
      regenerateCurrentMessage,
      approveCurrentTool,
      input,
      visibility,
      isReadonly,
      isNewChat,
      isLoading,
      votes,
      currentModelId,
      setCurrentModelId,
      showCreditCardAlert,
    ]
  );

  return (
    <ActiveChatContext.Provider value={value}>
      {children}
    </ActiveChatContext.Provider>
  );
}

export function useActiveChat() {
  const context = useContext(ActiveChatContext);
  if (!context) {
    throw new Error("useActiveChat must be used within ActiveChatProvider");
  }
  return context;
}
