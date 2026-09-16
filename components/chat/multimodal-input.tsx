"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import equal from "fast-deep-equal";
import {
  ArrowUpIcon,
  BrainIcon,
  EyeIcon,
  ImageIcon,
  VideoIcon,
  WrenchIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  type ChangeEvent,
  type Dispatch,
  memo,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { useLocalStorage, useWindowSize } from "usehooks-ts";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  getDefaultVideoQuality,
  getImageSizeOptions,
  getVideoQualityOptions,
  normalizeImageSize,
  normalizeVideoQuality,
  supportsImageInput,
  supportsVideoFileInput,
  supportsVideoImageInput,
  type VideoQuality,
} from "@/lib/ai/media-settings";
import {
  type ChatModel,
  chatModels,
  DEFAULT_CHAT_MODEL,
  type ModelCapabilities,
} from "@/lib/ai/models";
import type { Attachment, ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "../ai-elements/prompt-input";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { PaperclipIcon, StopIcon } from "./icons";
import { PreviewAttachment } from "./preview-attachment";
import {
  type SlashCommand,
  SlashCommandMenu,
  slashCommands,
} from "./slash-commands";
import { SuggestedActions } from "./suggested-actions";
import type { VisibilityType } from "./visibility-selector";

type GenerationMode = "chat" | "image" | "video";

function setCookie(name: string, value: string) {
  const maxAge = 60 * 60 * 24 * 365;
  // biome-ignore lint/suspicious/noDocumentCookie: needed for client-side cookie setting
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}`;
}

function PureMultimodalInput({
  chatId,
  input,
  setInput,
  status,
  stop,
  attachments,
  setAttachments,
  messages,
  setMessages,
  sendMessage,
  className,
  selectedVisibilityType,
  selectedModelId,
  onModelChange,
  editingMessage,
  onCancelEdit,
  isLoading,
}: {
  chatId: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  status: UseChatHelpers<ChatMessage>["status"];
  stop: () => void;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  messages: UIMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage:
    | UseChatHelpers<ChatMessage>["sendMessage"]
    | (() => Promise<void>);
  className?: string;
  selectedVisibilityType: VisibilityType;
  selectedModelId: string;
  onModelChange?: (modelId: string) => void;
  editingMessage?: ChatMessage | null;
  onCancelEdit?: () => void;
  isLoading?: boolean;
}) {
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { width } = useWindowSize();
  const hasAutoFocused = useRef(false);
  useEffect(() => {
    if (!hasAutoFocused.current && width) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
        hasAutoFocused.current = true;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [width]);

  const [localStorageInput, setLocalStorageInput] = useLocalStorage(
    "input",
    ""
  );

  useEffect(() => {
    if (textareaRef.current) {
      const domValue = textareaRef.current.value;
      const finalValue = domValue || localStorageInput || "";
      setInput(finalValue);
    }
  }, [localStorageInput, setInput]);

  useEffect(() => {
    setLocalStorageInput(input);
  }, [input, setLocalStorageInput]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadQueue, setUploadQueue] = useState<string[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const [generationMode, setGenerationModeState] =
    useState<GenerationMode>("chat");
  const [selectedImageModelId, setSelectedImageModelId] = useState("");
  const [selectedVideoModelId, setSelectedVideoModelId] = useState("");
  const acceptedAttachmentTypes = useMemo(() => {
    if (generationMode !== "video") {
      return "image/jpeg,image/png";
    }
    const types: string[] = [];
    if (supportsVideoImageInput(selectedVideoModelId)) {
      types.push("image/jpeg", "image/png");
    }
    if (supportsVideoFileInput(selectedVideoModelId)) {
      types.push("video/mp4", "video/webm");
    }
    return types.join(",");
  }, [generationMode, selectedVideoModelId]);

  useEffect(() => {
    const stored = window.localStorage.getItem(`generation-mode:${chatId}`);
    setGenerationModeState(
      stored === "image" || stored === "video" ? stored : "chat"
    );
  }, [chatId]);

  const setGenerationMode = useCallback(
    (mode: GenerationMode) => {
      setGenerationModeState(mode);
      window.localStorage.setItem(`generation-mode:${chatId}`, mode);
      textareaRef.current?.focus();
    },
    [chatId]
  );
  const handleChatMode = useCallback(
    () => setGenerationMode("chat"),
    [setGenerationMode]
  );
  const handleImageMode = useCallback(
    () => setGenerationMode("image"),
    [setGenerationMode]
  );
  const handleVideoMode = useCallback(
    () => setGenerationMode("video"),
    [setGenerationMode]
  );

  const handleInput = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const val = event.target.value;
      setInput(val);

      if (val.startsWith("/") && !val.includes(" ")) {
        setSlashOpen(true);
        setSlashQuery(val.slice(1));
        setSlashIndex(0);
      } else {
        setSlashOpen(false);
      }
    },
    [setInput]
  );

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      setSlashOpen(false);
      setInput("");
      switch (cmd.action) {
        case "new":
          router.push("/");
          break;
        case "clear":
          setMessages(() => []);
          break;
        case "rename":
          toast("Rename is available from the sidebar chat menu.");
          break;
        case "model": {
          const modelBtn = document.querySelector<HTMLButtonElement>(
            "[data-testid='model-selector']"
          );
          modelBtn?.click();
          break;
        }
        case "theme":
          setTheme(resolvedTheme === "dark" ? "light" : "dark");
          break;
        case "delete":
          toast("Delete this chat?", {
            action: {
              label: "Delete",
              onClick: async () => {
                const response = await fetch(
                  `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/chat?id=${chatId}`,
                  { method: "DELETE" }
                );
                if (!response.ok) {
                  const error = (await response.json().catch(() => null)) as {
                    message?: string;
                  } | null;
                  toast.error(error?.message ?? "Chat could not be deleted");
                  return;
                }
                router.push("/");
                toast.success("Chat deleted");
              },
            },
          });
          break;
        case "purge":
          toast("Delete all chats?", {
            action: {
              label: "Delete all",
              onClick: () => {
                fetch(
                  `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/history`,
                  {
                    method: "DELETE",
                  }
                );
                router.push("/");
                toast.success("All chats deleted");
              },
            },
          });
          break;
        default:
          break;
      }
    },
    [chatId, resolvedTheme, router, setInput, setMessages, setTheme]
  );

  const submitForm = useCallback(() => {
    if (generationMode === "image") {
      const invalidAttachment = attachments.some(
        (attachment) => !attachment.contentType.startsWith("image/")
      );
      if (invalidAttachment) {
        toast.error("Image generation accepts a JPEG or PNG reference image");
        return;
      }
    }
    if (generationMode === "video") {
      const invalidAttachment = attachments.some((attachment) => {
        if (attachment.contentType.startsWith("image/")) {
          return !supportsVideoImageInput(selectedVideoModelId);
        }
        if (attachment.contentType.startsWith("video/")) {
          return !supportsVideoFileInput(selectedVideoModelId);
        }
        return true;
      });
      if (invalidAttachment) {
        toast.error("The selected video model does not accept that input type");
        return;
      }
    }

    window.history.pushState(
      {},
      "",
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}`
    );

    sendMessage({
      parts: [
        ...attachments.map((attachment) => ({
          mediaType: attachment.contentType,
          name: attachment.name,
          type: "file" as const,
          url: attachment.url,
        })),
        {
          text: input,
          type: "text",
        },
      ],
      role: "user",
    });

    setAttachments([]);
    setLocalStorageInput("");
    setInput("");

    if (width && width > 768) {
      textareaRef.current?.focus();
    }
  }, [
    input,
    setInput,
    attachments,
    sendMessage,
    setAttachments,
    setLocalStorageInput,
    width,
    chatId,
    generationMode,
    selectedVideoModelId,
  ]);

  const uploadFile = useCallback(async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/files/upload`,
        {
          body: formData,
          method: "POST",
        }
      );

      if (response.ok) {
        const data = await response.json();
        const { url, pathname, contentType } = data;

        return {
          contentType,
          name: pathname,
          url,
        };
      }
      const { error } = await response.json();
      toast.error(error);
    } catch {
      toast.error("Failed to upload file, please try again!");
    }
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);

      setUploadQueue(files.map((file) => file.name));

      try {
        const uploadPromises = files.map((file) => uploadFile(file));
        const uploadedAttachments = await Promise.all(uploadPromises);
        const successfullyUploadedAttachments = uploadedAttachments.filter(
          (attachment) => attachment !== undefined
        );

        setAttachments((currentAttachments) => [
          ...currentAttachments,
          ...successfullyUploadedAttachments,
        ]);
      } catch {
        toast.error("Failed to upload files");
      } finally {
        setUploadQueue([]);
      }
    },
    [setAttachments, uploadFile]
  );

  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) {
        return;
      }

      const imageItems = Array.from(items).filter((item) =>
        item.type.startsWith("image/")
      );

      if (imageItems.length === 0) {
        return;
      }

      event.preventDefault();

      setUploadQueue((prev) => [...prev, "Pasted image"]);

      try {
        const uploadPromises = imageItems
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null)
          .map((file) => uploadFile(file));

        const uploadedAttachments = await Promise.all(uploadPromises);
        const successfullyUploadedAttachments = uploadedAttachments.filter(
          (attachment) =>
            attachment !== undefined &&
            attachment.url !== undefined &&
            attachment.contentType !== undefined
        );

        setAttachments((curr) => [
          ...curr,
          ...(successfullyUploadedAttachments as Attachment[]),
        ]);
      } catch {
        toast.error("Failed to upload pasted image(s)");
      } finally {
        setUploadQueue([]);
      }
    },
    [setAttachments, uploadFile]
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.addEventListener("paste", handlePaste);
    return () => textarea.removeEventListener("paste", handlePaste);
  }, [handlePaste]);

  const handleCancelEditMouseDown = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      onCancelEdit?.();
    },
    [onCancelEdit]
  );

  const handleSlashClose = useCallback(() => {
    setSlashOpen(false);
  }, []);

  const handlePromptSubmit = useCallback(() => {
    if (input.startsWith("/")) {
      const query = input.slice(1).trim();
      const cmd = slashCommands.find((c) => c.name === query);
      if (cmd) {
        handleSlashSelect(cmd);
      }
      return;
    }
    if (!input.trim() && attachments.length === 0) {
      return;
    }
    if (status === "ready" || status === "error") {
      submitForm();
    } else {
      toast.error("Please wait for the model to finish its response!");
    }
  }, [attachments.length, handleSlashSelect, input, status, submitForm]);

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashOpen) {
        const filtered = slashCommands.filter((cmd) =>
          cmd.name.startsWith(slashQuery.toLowerCase())
        );
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((i) => Math.min(i + 1, filtered.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (filtered[slashIndex]) {
            handleSlashSelect(filtered[slashIndex]);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashOpen(false);
          return;
        }
      }
      if (e.key === "Escape" && editingMessage && onCancelEdit) {
        e.preventDefault();
        onCancelEdit();
      }
    },
    [
      editingMessage,
      handleSlashSelect,
      onCancelEdit,
      slashIndex,
      slashOpen,
      slashQuery,
    ]
  );

  return (
    <div className={cn("relative flex w-full flex-col gap-4", className)}>
      {editingMessage && onCancelEdit ? (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>Editing message</span>
          <button
            className="rounded px-1.5 py-0.5 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
            onMouseDown={handleCancelEditMouseDown}
            type="button"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {!editingMessage &&
        !isLoading &&
        messages.length === 0 &&
        attachments.length === 0 &&
        uploadQueue.length === 0 && (
          <SuggestedActions
            chatId={chatId}
            selectedVisibilityType={selectedVisibilityType}
            sendMessage={sendMessage}
          />
        )}

      <input
        accept={acceptedAttachmentTypes}
        className="pointer-events-none fixed -top-4 -left-4 size-0.5 opacity-0"
        multiple={generationMode === "chat"}
        onChange={handleFileChange}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />

      <div className="relative">
        {slashOpen ? (
          <SlashCommandMenu
            onClose={handleSlashClose}
            onSelect={handleSlashSelect}
            query={slashQuery}
            selectedIndex={slashIndex}
          />
        ) : null}
      </div>

      <PromptInput
        className="[&>div]:rounded-2xl [&>div]:border [&>div]:border-border/30 [&>div]:bg-card/70 [&>div]:shadow-[var(--shadow-composer)] [&>div]:transition-shadow [&>div]:duration-300 [&>div]:focus-within:shadow-[var(--shadow-composer-focus)]"
        onSubmit={handlePromptSubmit}
      >
        {(attachments.length > 0 || uploadQueue.length > 0) && (
          <div
            className="flex w-full self-start flex-row gap-2 overflow-x-auto px-3 pt-3 no-scrollbar"
            data-testid="attachments-preview"
          >
            {attachments.map((attachment) => (
              <AttachmentPreviewItem
                attachment={attachment}
                fileInputRef={fileInputRef}
                key={attachment.url}
                setAttachments={setAttachments}
              />
            ))}

            {uploadQueue.map((filename) => (
              <PreviewAttachment
                attachment={{
                  contentType: "",
                  name: filename,
                  url: "",
                }}
                isUploading={true}
                key={filename}
              />
            ))}
          </div>
        )}
        <PromptInputTextarea
          className="min-h-24 text-[13px] leading-relaxed px-4 pt-3.5 pb-1.5 placeholder:text-muted-foreground/35"
          data-testid="multimodal-input"
          onChange={handleInput}
          onKeyDown={handleTextareaKeyDown}
          placeholder={
            editingMessage
              ? "Edit your message..."
              : generationMode === "image"
                ? "Describe the image to generate..."
                : generationMode === "video"
                  ? "Describe the video to generate..."
                  : "Ask anything..."
          }
          ref={textareaRef}
          value={input}
        />
        <PromptInputFooter className="px-3 pb-3">
          <PromptInputTools>
            <AttachmentsButton
              fileInputRef={fileInputRef}
              generationMode={generationMode}
              selectedImageModelId={selectedImageModelId}
              selectedModelId={selectedModelId}
              selectedVideoModelId={selectedVideoModelId}
              status={status}
            />
            <div className="flex items-center rounded-lg bg-muted/60 p-0.5">
              <Button
                aria-pressed={generationMode === "chat"}
                className="h-6 rounded-md px-2 text-[11px]"
                onClick={handleChatMode}
                type="button"
                variant={generationMode === "chat" ? "secondary" : "ghost"}
              >
                Chat
              </Button>
              <Button
                aria-pressed={generationMode === "image"}
                className="h-6 rounded-md px-2 text-[11px]"
                onClick={handleImageMode}
                type="button"
                variant={generationMode === "image" ? "secondary" : "ghost"}
              >
                <ImageIcon className="mr-1 size-3" />
                Image
              </Button>
              <Button
                aria-pressed={generationMode === "video"}
                className="h-6 rounded-md px-2 text-[11px]"
                onClick={handleVideoMode}
                type="button"
                variant={generationMode === "video" ? "secondary" : "ghost"}
              >
                <VideoIcon className="mr-1 size-3" />
                Video
              </Button>
            </div>
            {generationMode === "chat" ? (
              <ModelSelectorCompact
                onModelChange={onModelChange}
                selectedModelId={selectedModelId}
              />
            ) : generationMode === "image" ? (
              <>
                <MediaModelSelector
                  chatId={chatId}
                  kind="image_generation"
                  onSelectionChange={setSelectedImageModelId}
                />
                <ImageSizeSelector
                  chatId={chatId}
                  modelId={selectedImageModelId}
                />
              </>
            ) : (
              <>
                <MediaModelSelector
                  chatId={chatId}
                  kind="video_generation"
                  onSelectionChange={setSelectedVideoModelId}
                />
                <VideoQualitySelector
                  chatId={chatId}
                  modelId={selectedVideoModelId}
                />
              </>
            )}
          </PromptInputTools>

          {status === "submitted" ? (
            <StopButton setMessages={setMessages} stop={stop} />
          ) : (
            <PromptInputSubmit
              className={cn(
                "h-7 w-7 rounded-xl transition-all duration-200",
                input.trim()
                  ? "bg-foreground text-background hover:opacity-85 active:scale-95"
                  : "bg-muted text-muted-foreground/25 cursor-not-allowed"
              )}
              data-testid="send-button"
              disabled={!input.trim() || uploadQueue.length > 0}
              status={status}
              variant="secondary"
            >
              <ArrowUpIcon className="size-4" />
            </PromptInputSubmit>
          )}
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

export const MultimodalInput = memo(
  PureMultimodalInput,
  (prevProps, nextProps) => {
    if (prevProps.input !== nextProps.input) {
      return false;
    }
    if (prevProps.status !== nextProps.status) {
      return false;
    }
    if (!equal(prevProps.attachments, nextProps.attachments)) {
      return false;
    }
    if (prevProps.selectedVisibilityType !== nextProps.selectedVisibilityType) {
      return false;
    }
    if (prevProps.selectedModelId !== nextProps.selectedModelId) {
      return false;
    }
    if (prevProps.editingMessage !== nextProps.editingMessage) {
      return false;
    }
    if (prevProps.isLoading !== nextProps.isLoading) {
      return false;
    }
    if (prevProps.messages.length !== nextProps.messages.length) {
      return false;
    }

    return true;
  }
);

function PureAttachmentPreviewItem({
  attachment,
  fileInputRef,
  setAttachments,
}: {
  attachment: Attachment;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
}) {
  const handleRemove = useCallback(() => {
    setAttachments((currentAttachments) =>
      currentAttachments.filter((a) => a.url !== attachment.url)
    );
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [attachment.url, fileInputRef, setAttachments]);

  return <PreviewAttachment attachment={attachment} onRemove={handleRemove} />;
}

const AttachmentPreviewItem = memo(PureAttachmentPreviewItem);

function PureAttachmentsButton({
  fileInputRef,
  generationMode,
  status,
  selectedImageModelId,
  selectedModelId,
  selectedVideoModelId,
}: {
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  generationMode: GenerationMode;
  status: UseChatHelpers<ChatMessage>["status"];
  selectedImageModelId: string;
  selectedModelId: string;
  selectedVideoModelId: string;
}) {
  const { data: modelsResponse } = useSWR(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/models`,
    (url: string) => fetch(url).then((r) => r.json()),
    { dedupingInterval: 3_600_000, revalidateOnFocus: false }
  );

  const caps: Record<string, ModelCapabilities> | undefined =
    modelsResponse?.capabilities ?? modelsResponse;
  const hasVision = caps?.[selectedModelId]?.vision ?? false;
  const videoAcceptsImage = supportsVideoImageInput(selectedVideoModelId);
  const videoAcceptsVideo = supportsVideoFileInput(selectedVideoModelId);
  const canAttachMedia =
    (generationMode === "video" && (videoAcceptsImage || videoAcceptsVideo)) ||
    (generationMode === "image" && supportsImageInput(selectedImageModelId)) ||
    (generationMode === "chat" && hasVision);
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      fileInputRef.current?.click();
    },
    [fileInputRef]
  );

  return (
    <Button
      className={cn(
        "h-7 w-7 rounded-lg border border-border/40 p-1 transition-colors",
        canAttachMedia
          ? "text-foreground hover:border-border hover:text-foreground"
          : "text-muted-foreground/30 cursor-not-allowed"
      )}
      data-testid="attachments-button"
      disabled={status !== "ready" || !canAttachMedia}
      onClick={handleClick}
      title={
        canAttachMedia
          ? generationMode === "video"
            ? videoAcceptsImage && videoAcceptsVideo
              ? "Add a JPEG/PNG reference image or an MP4/WebM source video"
              : videoAcceptsImage
                ? "Add a JPEG or PNG as the video's reference image"
                : "Add an MP4 or WebM source video"
            : generationMode === "image"
              ? "Add a JPEG or PNG reference image"
              : "Attach a JPEG or PNG"
          : generationMode === "image"
            ? "Select OpenAI GPT Image 2 to use a reference image"
            : generationMode === "video"
              ? "The selected video model accepts text prompts only"
              : "Select a vision-capable chat model to attach an image"
      }
      variant="ghost"
    >
      <PaperclipIcon size={14} style={{ height: 14, width: 14 }} />
    </Button>
  );
}

const AttachmentsButton = memo(PureAttachmentsButton);

function ModelSelectorOption({
  capabilities,
  model,
  onModelChange,
  selectedModelId,
  setOpen,
}: {
  capabilities: Record<string, ModelCapabilities> | undefined;
  model: ChatModel;
  onModelChange?: (modelId: string) => void;
  selectedModelId: string;
  setOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const [logoProvider] = model.id.split("/");
  const maybeWithTooltip = (icon: ReactNode, label: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{icon}</span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
  const handleSelect = useCallback(() => {
    onModelChange?.(model.id);
    setCookie("chat-model", model.id);
    setOpen(false);
    setTimeout(() => {
      document
        .querySelector<HTMLTextAreaElement>("[data-testid='multimodal-input']")
        ?.focus();
    }, 50);
  }, [model.id, onModelChange, setOpen]);

  return (
    <ModelSelectorItem
      className={cn(
        "flex w-full transition-colors",
        model.id === selectedModelId &&
          "border-b border-dashed border-foreground/50",
        "data-[selected=true]:bg-muted data-[selected=true]:text-foreground"
      )}
      onSelect={handleSelect}
      value={model.id}
    >
      <ModelSelectorLogo provider={logoProvider} />
      <ModelSelectorName>{model.name}</ModelSelectorName>
      <div className="ml-auto flex items-center gap-2 text-foreground/70">
        {capabilities?.[model.id]?.tools
          ? maybeWithTooltip(
              <WrenchIcon className="size-3.5" />,
              "Supports tool use"
            )
          : null}
        {capabilities?.[model.id]?.vision
          ? maybeWithTooltip(
              <EyeIcon className="size-3.5" />,
              "Supports vision"
            )
          : null}
        {capabilities?.[model.id]?.reasoning
          ? maybeWithTooltip(
              <BrainIcon className="size-3.5" />,
              "Supports reasoning"
            )
          : null}
      </div>
    </ModelSelectorItem>
  );
}

function PureModelSelectorCompact({
  selectedModelId,
  onModelChange,
}: {
  selectedModelId: string;
  onModelChange?: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: modelsData } = useSWR(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/models`,
    (url: string) => fetch(url).then((r) => r.json()),
    { dedupingInterval: 3_600_000, revalidateOnFocus: false }
  );

  const capabilities: Record<string, ModelCapabilities> | undefined =
    modelsData?.capabilities ?? modelsData;
  const dynamicModels: ChatModel[] | undefined = modelsData?.models;
  const activeModels = dynamicModels ?? chatModels;

  const selectedModel =
    activeModels.find((m: ChatModel) => m.id === selectedModelId) ??
    (dynamicModels
      ? (activeModels.find((m: ChatModel) => m.id === DEFAULT_CHAT_MODEL) ??
        activeModels[0])
      : selectedModelId === DEFAULT_CHAT_MODEL
        ? (activeModels.find((m: ChatModel) => m.id === DEFAULT_CHAT_MODEL) ??
          activeModels[0])
        : {
            description: "Waiting for the live model catalog",
            id: selectedModelId,
            name: "Loading selected model…",
            provider: selectedModelId.split("/")[0] || "model",
          });

  useEffect(() => {
    if (
      !dynamicModels?.length ||
      dynamicModels.some((model) => model.id === selectedModelId)
    ) {
      return;
    }
    const fallback =
      dynamicModels.find((model) => model.id === DEFAULT_CHAT_MODEL) ??
      dynamicModels[0];
    if (fallback) {
      onModelChange?.(fallback.id);
    }
  }, [dynamicModels, onModelChange, selectedModelId]);

  const [provider] = selectedModel.id.split("/");

  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <ModelSelectorTrigger asChild>
        <Button
          className="h-7 max-w-[200px] justify-between gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          data-testid="model-selector"
          variant="ghost"
        >
          {provider ? <ModelSelectorLogo provider={provider} /> : null}
          <ModelSelectorName>{selectedModel.name}</ModelSelectorName>
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent commandDefaultValue={selectedModel.id}>
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          {(() => {
            const allModels = activeModels;

            const grouped: Record<string, ChatModel[]> = {};
            for (const model of allModels) {
              const key = model.provider;
              if (!grouped[key]) {
                grouped[key] = [];
              }
              grouped[key].push(model);
            }

            const sortedKeys = Object.keys(grouped).sort((a, b) =>
              a.localeCompare(b)
            );

            const providerNames: Record<string, string> = {
              alibaba: "Alibaba",
              anthropic: "Anthropic",
              "arcee-ai": "Arcee AI",
              bytedance: "ByteDance",
              cohere: "Cohere",
              deepseek: "DeepSeek",
              google: "Google",
              inception: "Inception",
              kwaipilot: "Kwaipilot",
              meituan: "Meituan",
              meta: "Meta",
              minimax: "MiniMax",
              mistral: "Mistral",
              moonshotai: "Moonshot",
              morph: "Morph",
              nvidia: "Nvidia",
              openai: "OpenAI",
              perplexity: "Perplexity",
              "prime-intellect": "Prime Intellect",
              xai: "xAI",
              xiaomi: "Xiaomi",
              zai: "Zai",
            };

            return sortedKeys.map((key) => (
              <ModelSelectorGroup heading={providerNames[key] ?? key} key={key}>
                {grouped[key].map((model) => (
                  <ModelSelectorOption
                    capabilities={capabilities}
                    key={model.id}
                    model={model}
                    onModelChange={onModelChange}
                    selectedModelId={selectedModel.id}
                    setOpen={setOpen}
                  />
                ))}
              </ModelSelectorGroup>
            ));
          })()}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

const ModelSelectorCompact = memo(PureModelSelectorCompact);

function VideoQualitySelector({
  chatId,
  modelId,
}: {
  chatId: string;
  modelId: string;
}) {
  const storageKey = `video-quality:${chatId}`;
  const options = useMemo(() => getVideoQualityOptions(modelId), [modelId]);
  const [quality, setQuality] = useState<VideoQuality>(() =>
    getDefaultVideoQuality(modelId)
  );

  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey);
    const next = normalizeVideoQuality(modelId, stored);
    setQuality(next);
    window.localStorage.setItem(storageKey, next);
  }, [modelId, storageKey]);

  const handleValueChange = useCallback(
    (value: string) => {
      const next = value as VideoQuality;
      setQuality(next);
      window.localStorage.setItem(storageKey, next);
    },
    [storageKey]
  );

  return (
    <Select onValueChange={handleValueChange} value={quality}>
      <SelectTrigger
        className="h-7 rounded-lg border-0 bg-transparent px-2 text-[12px] text-muted-foreground shadow-none"
        data-testid="video-quality-selector"
        size="sm"
        title="Video output resolution"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label} · {option.resolution}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ImageSizeSelector({
  chatId,
  modelId,
}: {
  chatId: string;
  modelId: string;
}) {
  const storageKey = `image-size:${chatId}`;
  const options = useMemo(() => getImageSizeOptions(modelId), [modelId]);
  const [size, setSize] = useState(() => normalizeImageSize(modelId));

  useEffect(() => {
    const next = normalizeImageSize(
      modelId,
      window.localStorage.getItem(storageKey)
    );
    setSize(next);
    window.localStorage.setItem(storageKey, next);
  }, [modelId, storageKey]);

  const handleValueChange = useCallback(
    (value: string) => {
      const next = normalizeImageSize(modelId, value);
      setSize(next);
      window.localStorage.setItem(storageKey, next);
    },
    [modelId, storageKey]
  );

  return (
    <Select onValueChange={handleValueChange} value={size}>
      <SelectTrigger
        className="h-7 rounded-lg border-0 bg-transparent px-2 text-[12px] text-muted-foreground shadow-none"
        data-testid="image-size-selector"
        size="sm"
        title="Generated image dimensions"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label} · {option.resolution}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type MediaModel = {
  description: string;
  id: string;
  kind: "audio" | "image_generation" | "video_generation";
  name: string;
};

function MediaModelSelector({
  chatId,
  kind,
  onSelectionChange,
}: {
  chatId: string;
  kind: "image_generation" | "video_generation";
  onSelectionChange?: (modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const { data } = useSWR<{ models: MediaModel[] }>(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/media/models`,
    (url: string) => fetch(url).then((response) => response.json()),
    { dedupingInterval: 30_000, revalidateOnFocus: false }
  );
  const mediaModels = useMemo(
    () => (data?.models ?? []).filter((model) => model.kind === kind),
    [data?.models, kind]
  );
  const isVideo = kind === "video_generation";
  const label = isVideo ? "Video" : "Image";
  const storageKey = `${isVideo ? "video" : "image"}-model:${chatId}`;

  useEffect(() => {
    if (mediaModels.length === 0) {
      return;
    }
    const stored = window.localStorage.getItem(storageKey);
    const next = mediaModels.some((model) => model.id === stored)
      ? (stored as string)
      : mediaModels[0].id;
    setSelectedId(next);
    window.localStorage.setItem(storageKey, next);
    onSelectionChange?.(next);
  }, [mediaModels, onSelectionChange, storageKey]);

  const selected =
    mediaModels.find((model) => model.id === selectedId) ?? mediaModels[0];
  if (!selected) {
    return null;
  }

  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <ModelSelectorTrigger asChild>
        <Button
          className="h-7 max-w-[180px] justify-between gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          data-testid={`${isVideo ? "video" : "image"}-model-selector`}
          title={`${label} generator`}
          variant="ghost"
        >
          {isVideo ? (
            <VideoIcon className="size-3.5" />
          ) : (
            <ImageIcon className="size-3.5" />
          )}
          <ModelSelectorName>
            {label}: {selected.name}
          </ModelSelectorName>
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent commandDefaultValue={selected.id}>
        <ModelSelectorInput
          placeholder={`Search ${label.toLowerCase()} generators...`}
        />
        <ModelSelectorList>
          <ModelSelectorGroup heading={`${label} generators`}>
            {mediaModels.map((model) => (
              <ModelSelectorItem
                className={cn(
                  "flex w-full transition-colors",
                  model.id === selected.id &&
                    "border-b border-dashed border-foreground/50"
                )}
                key={model.id}
                // biome-ignore lint/performance/noJsxPropsBind: each row selects its own model
                onSelect={() => {
                  setSelectedId(model.id);
                  window.localStorage.setItem(storageKey, model.id);
                  onSelectionChange?.(model.id);
                  setOpen(false);
                }}
                value={model.id}
              >
                {isVideo ? (
                  <VideoIcon className="size-3.5 text-muted-foreground" />
                ) : (
                  <ImageIcon className="size-3.5 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <ModelSelectorName>{model.name}</ModelSelectorName>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {model.description}
                  </div>
                </div>
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

function PureStopButton({
  stop,
  setMessages,
}: {
  stop: () => void;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
}) {
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      stop();
      setMessages((messages) => messages);
    },
    [setMessages, stop]
  );

  return (
    <Button
      className="h-7 w-7 rounded-xl bg-foreground p-1 text-background transition-all duration-200 hover:opacity-85 active:scale-95 disabled:bg-muted disabled:text-muted-foreground/25 disabled:cursor-not-allowed"
      data-testid="stop-button"
      onClick={handleClick}
    >
      <StopIcon size={14} />
    </Button>
  );
}

const StopButton = memo(PureStopButton);
