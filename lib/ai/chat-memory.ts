import "server-only";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { logger } from "@/lib/logger";

const client = postgres(process.env.POSTGRES_URL ?? "", { max: 1 });
const db = drizzle(client);

const MEMORY_CHUNK_CHARS = Math.max(
  512,
  Number.parseInt(process.env.CHATBOT_MEMORY_CHUNK_CHARS ?? "6000", 10)
);
const MEMORY_CHUNK_OVERLAP_CHARS = Math.max(
  0,
  Number.parseInt(
    process.env.CHATBOT_MEMORY_CHUNK_OVERLAP_CHARS ?? "600",
    10
  )
);
const MEMORY_PROMPT_CHARS = Math.max(
  512,
  Number.parseInt(process.env.CHATBOT_MEMORY_PROMPT_CHARS ?? "4096", 10)
);
const MEMORY_MIN_CONTENT_CHARS = Math.max(
  0,
  Number.parseInt(process.env.CHATBOT_MEMORY_MIN_CONTENT_CHARS ?? "2000", 10)
);

export function isChatMemoryEnabled() {
  return process.env.CHATBOT_MEMORY_ENABLED === "true";
}

type ChatMemoryRow = {
  content: string;
  createdAt: Date;
  id: string;
  metadata: Record<string, unknown>;
};

export function chunkMemoryText(text: string) {
  const chunks: string[] = [];
  const step = Math.max(
    1,
    MEMORY_CHUNK_CHARS - MEMORY_CHUNK_OVERLAP_CHARS
  );
  for (let start = 0; start < text.length; start += step) {
    const chunk = text.slice(start, start + MEMORY_CHUNK_CHARS).trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

export async function storeChatMemory({
  chatId,
  content,
  metadata = {},
  sourceMessageId,
  userId,
}: {
  chatId: string;
  content: string;
  metadata?: Record<string, unknown>;
  sourceMessageId?: string;
  userId: string;
}): Promise<number> {
  if (!isChatMemoryEnabled() || content.trim().length < MEMORY_MIN_CONTENT_CHARS) {
    return 0;
  }

  const chunks = chunkMemoryText(content);
  for (const [index, chunk] of chunks.entries()) {
    await db.execute(sql`
      INSERT INTO "ChatMemory" (
        "chatId",
        "userId",
        "sourceMessageId",
        "content",
        "metadata"
      ) VALUES (
        ${chatId}::uuid,
        ${userId}::uuid,
        ${sourceMessageId ?? null}::uuid,
        ${chunk},
        ${JSON.stringify({
          ...metadata,
          chunkIndex: index,
          chunkCount: chunks.length,
        })}::jsonb
      )
    `);
  }

  logger.info("chat.memory.stored", {
    chatId,
    chunkCount: chunks.length,
    sourceMessageId,
  });
  return chunks.length;
}

export async function searchChatMemory({
  chatId,
  limit = 4,
  query,
  userId,
}: {
  chatId: string;
  limit?: number;
  query: string;
  userId: string;
}): Promise<ChatMemoryRow[]> {
  if (!isChatMemoryEnabled() || !query.trim()) {
    return [];
  }

  const result = await db.execute(sql`
    SELECT
      "id"::text AS id,
      "content",
      "metadata",
      "createdAt" AS "createdAt",
      ts_rank_cd(
        to_tsvector('english', "content"),
        websearch_to_tsquery('english', ${query})
      ) AS rank
    FROM "ChatMemory"
    WHERE "chatId" = ${chatId}::uuid
      AND "userId" = ${userId}::uuid
      AND to_tsvector('english', "content") @@ websearch_to_tsquery('english', ${query})
    ORDER BY rank DESC, "createdAt" DESC
    LIMIT ${limit}
  `);

  return result as unknown as ChatMemoryRow[];
}

export function formatChatMemoryContext(rows: ChatMemoryRow[]) {
  if (rows.length === 0) {
    return "";
  }

  let remaining = MEMORY_PROMPT_CHARS;
  const sections: string[] = [];
  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }
    const header = `Chat memory ${row.id}\n`;
    const body = row.content.slice(0, Math.max(0, remaining - header.length));
    sections.push(`${header}${body}`);
    remaining -= header.length + body.length;
  }

  return `Relevant chat memory retrieved from earlier in this conversation or from stored artifacts:\n\n${sections.join(
    "\n\n---\n\n"
  )}`;
}
