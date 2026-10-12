"use client";
import type { UseChatHelpers } from "@ai-sdk/react";
import type { DynamicToolUIPart } from "ai";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import type { Vote } from "@/lib/db/schema";
import type { ChatMessage } from "@/lib/types";
import { cn, sanitizeText } from "@/lib/utils";
import { MessageContent, MessageResponse } from "../ai-elements/message";
import { Shimmer } from "../ai-elements/shimmer";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolPart,
} from "../ai-elements/tool";
import { useDataStream } from "./data-stream-provider";
import { DocumentToolResult } from "./document";
import { DocumentPreview } from "./document-preview";
import { SparklesIcon } from "./icons";
import { MessageActions } from "./message-actions";
import { MessageReasoning } from "./message-reasoning";
import { PreviewAttachment } from "./preview-attachment";
import { Weather } from "./weather";

function MessageTimestamp({ createdAt }: { createdAt?: string }) {
  const [label, setLabel] = useState("");

  useEffect(() => {
    const date = createdAt ? new Date(createdAt) : null;
    setLabel(
      date && Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat(undefined, {
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            month: "short",
            second: "2-digit",
          }).format(date)
        : ""
    );
  }, [createdAt]);

  if (!createdAt) {
    return null;
  }

  return (
    <time
      data-testid="message-timestamp"
      dateTime={createdAt}
      title={createdAt}
    >
      {label}
    </time>
  );
}

function WaitingText() {
  const { waitingStatus } = useDataStream();
  const waitingText = waitingStatus?.message ?? "Waiting...";

  return (
    <div className="flex min-h-[calc(13px*1.65)] min-w-0 items-center text-[13px] leading-[1.65]">
      <Shimmer
        as="span"
        className="font-medium whitespace-normal break-words"
        duration={1}
      >
        {waitingText}
      </Shimmer>
    </div>
  );
}

function PersistentMediaProgress({
  createdAt,
  label,
}: {
  createdAt?: string;
  label: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const startedAt = createdAt ? new Date(createdAt).getTime() : Number.NaN;
  const elapsedSeconds = Number.isFinite(startedAt)
    ? Math.max(0, Math.floor((now - startedAt) / 1000))
    : 0;
  const elapsed =
    elapsedSeconds >= 60
      ? `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`
      : `${elapsedSeconds}s`;

  return (
    <Shimmer as="span" duration={1}>
      {`${label} (${elapsed})`}
    </Shimmer>
  );
}

function videoGeneratorName(input: unknown) {
  if (!input || typeof input !== "object" || !("model" in input)) {
    return "Veo 3.1";
  }

  const { model } = input as { model?: unknown };
  if (typeof model !== "string") {
    return "Veo 3.1";
  }
  if (model.includes("veo-3.1")) {
    return "Veo 3.1";
  }
  if (model.includes("veo-3.0")) {
    return "Veo 3.0";
  }
  if (model.includes("cosmos3-super")) {
    return "Cosmos3 Super";
  }
  if (model.includes("cosmos3-nano")) {
    return "Cosmos3 Nano";
  }
  if (model.includes("gemini-omni")) {
    return "Gemini Omni Flash Preview";
  }
  return model;
}

function ToolApprovalActions({
  addToolApprovalResponse,
  approvalId,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  approvalId: string;
}) {
  const handleDeny = useCallback(() => {
    addToolApprovalResponse({
      approved: false,
      id: approvalId,
      reason: "User denied tool action",
    });
  }, [addToolApprovalResponse, approvalId]);

  const handleAllow = useCallback(() => {
    addToolApprovalResponse({
      approved: true,
      id: approvalId,
    });
  }, [addToolApprovalResponse, approvalId]);

  return (
    <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
      <button
        className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
        onClick={handleDeny}
        type="button"
      >
        Deny
      </button>
      <button
        className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm transition-colors hover:bg-primary/90"
        onClick={handleAllow}
        type="button"
      >
        Allow
      </button>
    </div>
  );
}

const PurePreviewMessage = ({
  addToolApprovalResponse,
  chatId,
  message,
  vote,
  isLoading,
  setMessages: _setMessages,
  regenerate: _regenerate,
  isReadonly,
  requiresScrollPadding: _requiresScrollPadding,
  onEdit,
}: {
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  chatId: string;
  message: ChatMessage;
  vote: Vote | undefined;
  isLoading: boolean;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  isReadonly: boolean;
  requiresScrollPadding: boolean;
  onEdit?: (message: ChatMessage) => void;
}) => {
  const attachmentsFromMessage = message.parts.filter(
    (part) => part.type === "file"
  );

  useDataStream();

  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  const hasAnyContent = message.parts?.some(
    (part) =>
      (part.type === "text" && part.text?.trim().length > 0) ||
      (part.type === "reasoning" &&
        "text" in part &&
        part.text?.trim().length > 0) ||
      part.type.startsWith("tool-")
  );
  const isThinking = isAssistant && isLoading && !hasAnyContent;

  const attachments = attachmentsFromMessage.length > 0 && (
    <div
      className="flex flex-row justify-end gap-2"
      data-testid={"message-attachments"}
    >
      {attachmentsFromMessage.map((attachment) => (
        <PreviewAttachment
          attachment={{
            contentType: attachment.mediaType,
            name: attachment.filename ?? "file",
            url: attachment.url,
          }}
          key={attachment.url}
        />
      ))}
    </div>
  );

  const mergedReasoning = message.parts?.reduce(
    (acc, part) => {
      if (part.type === "reasoning" && part.text?.trim().length > 0) {
        return {
          isStreaming: "state" in part ? part.state === "streaming" : false,
          rendered: false,
          text: acc.text ? `${acc.text}\n\n${part.text}` : part.text,
        };
      }
      return acc;
    },
    { isStreaming: false, rendered: false, text: "" }
  ) ?? { isStreaming: false, rendered: false, text: "" };

  const parts = message.parts?.map((part, index) => {
    const { type } = part;
    const key = `message-${message.id}-part-${index}`;

    if (type === "reasoning") {
      if (!mergedReasoning.rendered && mergedReasoning.text) {
        mergedReasoning.rendered = true;
        return (
          <MessageReasoning
            isLoading={isLoading || mergedReasoning.isStreaming}
            key={key}
            reasoning={mergedReasoning.text}
          />
        );
      }
      return null;
    }

    if (type === "text") {
      return (
        <MessageContent
          className={cn("text-[13px] leading-[1.65]", {
            "w-fit max-w-[min(80%,56ch)] overflow-hidden break-words rounded-2xl rounded-br-lg border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2 shadow-[var(--shadow-card)]":
              message.role === "user",
          })}
          data-testid="message-content"
          key={key}
        >
          <MessageResponse>{sanitizeText(part.text)}</MessageResponse>
        </MessageContent>
      );
    }

    if (type === "tool-getWeather") {
      const { toolCallId, state } = part;
      const approvalId = (part as { approval?: { id: string } }).approval?.id;
      const isDenied =
        state === "output-denied" ||
        (state === "approval-responded" &&
          (part as { approval?: { approved?: boolean } }).approval?.approved ===
            false);
      const widthClass = "w-[min(100%,450px)]";

      if (state === "output-available") {
        return (
          <div className={widthClass} key={toolCallId}>
            <Weather weatherAtLocation={part.output} />
          </div>
        );
      }

      if (isDenied) {
        return (
          <div className={widthClass} key={toolCallId}>
            <Tool className="w-full" defaultOpen={true}>
              <ToolHeader state="output-denied" type="tool-getWeather" />
              <ToolContent>
                <div className="px-4 py-3 text-muted-foreground text-sm">
                  Weather lookup was denied.
                </div>
              </ToolContent>
            </Tool>
          </div>
        );
      }

      if (state === "approval-responded") {
        return (
          <div className={widthClass} key={toolCallId}>
            <Tool className="w-full" defaultOpen={true}>
              <ToolHeader state={state} type="tool-getWeather" />
              <ToolContent>
                <ToolInput input={part.input} />
              </ToolContent>
            </Tool>
          </div>
        );
      }

      return (
        <div className={widthClass} key={toolCallId}>
          <Tool className="w-full" defaultOpen={true}>
            <ToolHeader state={state} type="tool-getWeather" />
            <ToolContent>
              {(state === "input-available" ||
                state === "approval-requested") && (
                <ToolInput input={part.input} />
              )}
              {state === "approval-requested" && approvalId && (
                <ToolApprovalActions
                  addToolApprovalResponse={addToolApprovalResponse}
                  approvalId={approvalId}
                />
              )}
            </ToolContent>
          </Tool>
        </div>
      );
    }

    if (type.startsWith("tool-workspace") || type.startsWith("tool-git")) {
      const toolPart = part as unknown as ToolPart & {
        approval?: { id: string };
      };
      const { state, toolCallId } = toolPart;
      const approvalId = toolPart.approval?.id;
      const title = type
        .slice("tool-".length)
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/^./, (first) => first.toUpperCase());
      const showInput =
        state === "input-available" ||
        state === "approval-requested" ||
        state === "approval-responded";
      const input = "input" in toolPart ? toolPart.input : undefined;
      const output = "output" in toolPart ? toolPart.output : undefined;
      const errorText =
        "errorText" in toolPart ? toolPart.errorText : undefined;

      return (
        <Tool
          className="w-[min(100%,720px)]"
          defaultOpen={state !== "output-available"}
          key={toolCallId}
        >
          <ToolHeader
            state={state}
            title={title}
            toolName={title}
            type="dynamic-tool"
          />
          <ToolContent>
            {showInput && input !== undefined && <ToolInput input={input} />}
            {state === "approval-requested" && approvalId && (
              <ToolApprovalActions
                addToolApprovalResponse={addToolApprovalResponse}
                approvalId={approvalId}
              />
            )}
            {state === "output-available" && (
              <ToolOutput errorText={undefined} output={output} />
            )}
            {state === "output-error" && (
              <ToolOutput errorText={errorText} output={undefined} />
            )}
            {state === "output-denied" && (
              <div className="text-muted-foreground text-sm">
                Workspace change was denied.
              </div>
            )}
          </ToolContent>
        </Tool>
      );
    }

    if (type === "dynamic-tool") {
      const toolPart = part as DynamicToolUIPart;
      const { state, toolCallId, toolName } = toolPart;
      const title = toolName
        .replace(/^[^-]+-/, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/_/g, " ");
      const showInput =
        state === "input-available" ||
        state === "input-streaming" ||
        state === "approval-requested" ||
        state === "approval-responded";
      const input = "input" in toolPart ? toolPart.input : undefined;
      const output = "output" in toolPart ? toolPart.output : undefined;
      const errorText =
        "errorText" in toolPart ? toolPart.errorText : undefined;

      return (
        <Tool
          className="w-[min(100%,720px)]"
          defaultOpen={state !== "output-available"}
          key={toolCallId}
        >
          <ToolHeader
            state={state}
            title={title}
            toolName={toolName}
            type="dynamic-tool"
          />
          <ToolContent>
            {showInput && input !== undefined && <ToolInput input={input} />}
            {state === "output-available" && (
              <ToolOutput errorText={undefined} output={output} />
            )}
            {state === "output-error" && (
              <ToolOutput errorText={errorText} output={undefined} />
            )}
          </ToolContent>
        </Tool>
      );
    }

    if (type === "tool-generateImage") {
      const { state, toolCallId } = part;
      if (state === "output-available") {
        if ("error" in part.output) {
          return (
            <div
              className="w-[min(100%,640px)] rounded-xl border border-red-200 bg-red-50 p-4 text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
              key={toolCallId}
            >
              {String(part.output.error)}
            </div>
          );
        }
        return (
          <figure
            className="w-[min(100%,640px)] overflow-hidden rounded-xl border border-border/50 bg-card shadow-[var(--shadow-card)]"
            key={toolCallId}
          >
            <Image
              alt={part.output.prompt}
              className="h-auto w-full object-contain"
              height={1024}
              src={part.output.url}
              unoptimized
              width={1024}
            />
            <figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
              <span>{part.output.modelName}</span>
              <a
                className="hover:text-foreground"
                download
                href={part.output.url}
              >
                Download
              </a>
            </figcaption>
          </figure>
        );
      }

      return (
        <div
          className="w-[min(100%,450px)] rounded-xl border border-border/50 bg-card px-4 py-3 text-sm shadow-[var(--shadow-card)]"
          key={toolCallId}
        >
          <PersistentMediaProgress
            createdAt={message.metadata?.createdAt}
            label={
              state === "input-streaming"
                ? "Preparing image request…"
                : "Generating image…"
            }
          />
        </div>
      );
    }

    if (type === "tool-generateVideo") {
      const { state, toolCallId } = part;
      if (state === "output-available") {
        if ("error" in part.output) {
          return (
            <div
              className="w-[min(100%,720px)] rounded-xl border border-red-200 bg-red-50 p-4 text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
              key={toolCallId}
            >
              <div className="font-medium">
                {part.output.modelName ??
                  videoGeneratorName({ model: part.output.model })}{" "}
                failed
              </div>
              <div className="mt-1">{String(part.output.error)}</div>
            </div>
          );
        }
        return (
          <figure
            className="w-[min(100%,720px)] overflow-hidden rounded-xl border border-border/50 bg-card shadow-[var(--shadow-card)]"
            key={toolCallId}
          >
            {/* Generated videos do not include a separate captions track. */}
            {/* biome-ignore lint/a11y/useMediaCaption: provider output has no captions asset */}
            <video
              className="h-auto w-full bg-black object-contain"
              controls
              playsInline
              preload="metadata"
              src={part.output.url}
            />
            <figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
              <span>Generated with {part.output.modelName}</span>
              <a
                className="hover:text-foreground"
                download
                href={part.output.url}
              >
                Download
              </a>
            </figcaption>
          </figure>
        );
      }

      const generatorName = videoGeneratorName(part.input);

      return (
        <div
          className="w-[min(100%,450px)] rounded-xl border border-border/50 bg-card px-4 py-3 text-sm shadow-[var(--shadow-card)]"
          key={toolCallId}
        >
          <PersistentMediaProgress
            createdAt={message.metadata?.createdAt}
            label={
              state === "input-streaming"
                ? `Preparing ${generatorName} video request…`
                : `Generating video with ${generatorName}…`
            }
          />
        </div>
      );
    }

    if (type === "tool-createDocument") {
      const { toolCallId } = part;

      if (part.output && "error" in part.output) {
        return (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
            key={toolCallId}
          >
            Error creating document: {String(part.output.error)}
          </div>
        );
      }

      return (
        <DocumentPreview
          isReadonly={isReadonly}
          key={toolCallId}
          result={part.output}
        />
      );
    }

    if (type === "tool-updateDocument") {
      const { toolCallId } = part;

      if (part.output && "error" in part.output) {
        return (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-500 dark:bg-red-950/50"
            key={toolCallId}
          >
            Error updating document: {String(part.output.error)}
          </div>
        );
      }

      return (
        <div className="relative" key={toolCallId}>
          <DocumentPreview
            args={{ ...part.output, isUpdate: true }}
            isReadonly={isReadonly}
            result={part.output}
          />
        </div>
      );
    }

    if (type === "tool-requestSuggestions") {
      const { toolCallId, state } = part;

      return (
        <Tool
          className="w-[min(100%,450px)]"
          defaultOpen={true}
          key={toolCallId}
        >
          <ToolHeader state={state} type="tool-requestSuggestions" />
          <ToolContent>
            {state === "input-available" && <ToolInput input={part.input} />}
            {state === "output-available" && (
              <ToolOutput
                errorText={undefined}
                output={
                  "error" in part.output ? (
                    <div className="rounded border p-2 text-red-500">
                      Error: {String(part.output.error)}
                    </div>
                  ) : (
                    <DocumentToolResult
                      isReadonly={isReadonly}
                      result={part.output}
                      type="request-suggestions"
                    />
                  )
                }
              />
            )}
          </ToolContent>
        </Tool>
      );
    }

    return null;
  });

  const actions = !isReadonly && (
    <MessageActions
      chatId={chatId}
      isLoading={isLoading}
      key={`action-${message.id}`}
      message={message}
      onEdit={onEdit ? () => onEdit(message) : undefined}
      vote={vote}
    />
  );

  const content = isThinking ? (
    <WaitingText />
  ) : (
    <>
      {attachments}
      {parts}
      {isAssistant && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span
            data-testid="message-model-name"
            title={message.metadata?.model}
          >
            {message.metadata?.modelName ??
              message.metadata?.model ??
              "Model not recorded"}
          </span>
          {Boolean(message.metadata?.createdAt) && (
            <span aria-hidden="true">·</span>
          )}
          <MessageTimestamp createdAt={message.metadata?.createdAt} />
        </div>
      )}
      {actions}
    </>
  );

  return (
    <div
      className={cn(
        "group/message w-full",
        !isAssistant && "animate-[fade-up_0.25s_cubic-bezier(0.22,1,0.36,1)]"
      )}
      data-role={message.role}
      data-testid={`message-${message.role}`}
    >
      <div
        className={cn(
          isUser ? "flex flex-col items-end gap-2" : "flex items-start gap-3"
        )}
      >
        {isAssistant && (
          <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
            <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
              <SparklesIcon size={13} />
            </div>
          </div>
        )}
        {isAssistant ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2">{content}</div>
        ) : (
          content
        )}
      </div>
    </div>
  );
};

export const PreviewMessage = PurePreviewMessage;

export const ThinkingMessage = () => (
  <div
    className="group/message w-full"
    data-role="assistant"
    data-testid="message-assistant-loading"
  >
    <div className="flex items-start gap-3">
      <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
        <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
          <SparklesIcon size={13} />
        </div>
      </div>

      <WaitingText />
    </div>
  </div>
);
