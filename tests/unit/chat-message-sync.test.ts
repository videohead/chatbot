import assert from "node:assert/strict";
import test from "node:test";
import { shouldHydrateServerMessages } from "../../hooks/use-chat-message-sync";

const existingReadyChat = {
  chatId: "active-chat",
  isNewChat: false,
  serverMessagesAvailable: true,
  status: "ready" as const,
  visitChatId: "active-chat",
};

test("hydrates an existing conversation before the user changes it", () => {
  assert.equal(
    shouldHydrateServerMessages({
      ...existingReadyChat,
      locallyChanged: false,
    }),
    true
  );
});

test("does not replace a completed response with a stale pre-submit snapshot", () => {
  assert.equal(
    shouldHydrateServerMessages({
      ...existingReadyChat,
      locallyChanged: true,
    }),
    false
  );
});

test("does not hydrate another conversation or overwrite a live stream", () => {
  assert.equal(
    shouldHydrateServerMessages({
      ...existingReadyChat,
      locallyChanged: false,
      visitChatId: "previous-chat",
    }),
    false
  );
  assert.equal(
    shouldHydrateServerMessages({
      ...existingReadyChat,
      locallyChanged: false,
      status: "streaming",
    }),
    false
  );
});
