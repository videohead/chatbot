import type { ChatMessage } from "./types";

const ATTRIBUTION_PART = "data-model-attribution";

/** Persist attribution in the existing JSON parts column. */
export function persistMessageParts(
  message: ChatMessage
): ChatMessage["parts"] {
  if (message.role !== "assistant" || !message.metadata?.model) {
    return message.parts;
  }

  return [
    ...message.parts.filter((part) => part.type !== ATTRIBUTION_PART),
    {
      data: {
        model: message.metadata.model,
        modelName: message.metadata.modelName ?? message.metadata.model,
      },
      type: ATTRIBUTION_PART,
    },
  ];
}

/** Remove the private attribution part before constructing model messages. */
export function restoreMessageParts(parts: unknown) {
  const stored = (Array.isArray(parts) ? parts : []) as ChatMessage["parts"];
  const attribution = stored.find((part) => part?.type === ATTRIBUTION_PART);
  const data =
    attribution?.type === ATTRIBUTION_PART ? attribution.data : undefined;
  const model = typeof data?.model === "string" ? data.model : undefined;

  return {
    metadata: model
      ? {
          model,
          modelName:
            typeof data?.modelName === "string" ? data.modelName : model,
        }
      : {},
    parts: stored.filter((part) => part?.type !== ATTRIBUTION_PART),
  };
}
