CREATE TABLE IF NOT EXISTS "ChatMemory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chatId" uuid NOT NULL REFERENCES "Chat"("id") ON DELETE CASCADE,
  "userId" uuid NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "sourceMessageId" uuid,
  "content" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ChatMemory_chat_user_created_idx"
  ON "ChatMemory" ("chatId", "userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "ChatMemory_content_fts_idx"
  ON "ChatMemory" USING gin (to_tsvector('english', "content"));
