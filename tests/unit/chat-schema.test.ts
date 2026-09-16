import assert from "node:assert/strict";
import test from "node:test";
import { postRequestBodySchema } from "../../app/(chat)/api/chat/schema";

function requestWithFile(mediaType: "image/png" | "video/mp4", url: string) {
  return {
    generationMode: mediaType.startsWith("image/") ? "image" : "video",
    id: "22b0418f-ed90-46dd-9087-98ef250e13fb",
    message: {
      id: "0221f6e2-bbf2-47d1-af5a-ce6d02e31d7d",
      parts: [
        {
          mediaType,
          name: `reference.${mediaType === "image/png" ? "png" : "mp4"}`,
          type: "file",
          url,
        },
        { text: "Use this reference", type: "text" },
      ],
      role: "user",
    },
    selectedChatModel: "nvidia/openai/gpt-oss-20b",
    selectedVisibilityType: "private",
  };
}

test("accepts authenticated same-origin image attachments", () => {
  const result = postRequestBodySchema.safeParse(
    requestWithFile(
      "image/png",
      "/api/media/files/c620e8ba-578c-4cd3-95fc-2b39102f56e3.png"
    )
  );
  assert.equal(result.success, true);
});

test("accepts authenticated same-origin video attachments", () => {
  const result = postRequestBodySchema.safeParse(
    requestWithFile(
      "video/mp4",
      "/api/media/files/9d7da603-6103-4332-90bb-c88b7f37a009.mp4"
    )
  );
  assert.equal(result.success, true);
});

test("rejects unscoped relative attachment paths", () => {
  const result = postRequestBodySchema.safeParse(
    requestWithFile("image/png", "/private/image.png")
  );
  assert.equal(result.success, false);
});
