CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "SessionContextChunk" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "chatId" uuid NOT NULL REFERENCES "Chat"("id") ON DELETE CASCADE,
  "userId" uuid NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "sourceMessageId" uuid,
  "content" text NOT NULL,
  "embedding" vector(1536) NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "SessionContextChunk_chat_user_created_idx"
  ON "SessionContextChunk" ("chatId", "userId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "SessionContextChunk_embedding_idx"
  ON "SessionContextChunk" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 50);