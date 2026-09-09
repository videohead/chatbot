import "server-only";

import postgres from "postgres";

type SessionContextMetadata = Record<string, unknown>;

type SessionContextRow = {
  content: string;
  created_at: Date;
  id: string;
  metadata: SessionContextMetadata;
  similarity: number;
  source_message_id: string | null;
};

const connection = postgres(process.env.POSTGRES_URL ?? "", { max: 1 });

const EMBEDDING_DIMENSIONS = Math.max(
  16,
  Number.parseInt(process.env.OPENHARNESS_SESSION_RAG_EMBEDDING_DIMENSIONS ?? "1536", 10)
);
const SESSION_RAG_CHUNK_CHARS = Math.max(
  512,
  Number.parseInt(process.env.OPENHARNESS_SESSION_RAG_CHUNK_CHARS ?? "6000", 10)
);
const SESSION_RAG_CHUNK_OVERLAP_CHARS = Math.max(
  0,
  Number.parseInt(process.env.OPENHARNESS_SESSION_RAG_CHUNK_OVERLAP_CHARS ?? "600", 10)
);
const SESSION_RAG_PROMPT_CHARS = Math.max(
  512,
  Number.parseInt(process.env.OPENHARNESS_SESSION_RAG_PROMPT_CHARS ?? "4096", 10)
);

let schemaReady: Promise<void> | null = null;

function isSessionRagEnabled() {
  return process.env.OPENHARNESS_SESSION_RAG_ENABLED !== "false";
}

function normalizeVector(values: number[]) {
  const normalized = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => values[index] ?? 0);
  const magnitude = Math.sqrt(normalized.reduce((sum, value) => sum + value * value, 0)) || 1;
  return normalized.map((value) => value / magnitude);
}

function hashToken(token: string, seed: number) {
  let hash = seed;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function fallbackEmbedding(text: string) {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  const tokens = text.toLowerCase().match(/[a-z0-9_./:-]+/g) ?? [];
  for (const token of tokens) {
    const index = hashToken(token, 2_166_136_261) % EMBEDDING_DIMENSIONS;
    const sign = hashToken(token, 709_607) % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }
  return normalizeVector(vector);
}

function vectorLiteral(vector: number[]) {
  return `[${normalizeVector(vector).map((value) => Number.isFinite(value) ? value.toFixed(8) : "0").join(",")}]`;
}

async function ensureSessionRagSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await connection`CREATE EXTENSION IF NOT EXISTS vector`;
      await connection.unsafe(`
        CREATE TABLE IF NOT EXISTS "SessionContextChunk" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "chatId" uuid NOT NULL REFERENCES "Chat"("id") ON DELETE CASCADE,
          "userId" uuid NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
          "sourceMessageId" uuid,
          "content" text NOT NULL,
          "embedding" vector(${EMBEDDING_DIMENSIONS}) NOT NULL,
          "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
          "createdAt" timestamp DEFAULT now() NOT NULL
        )
      `);
      await connection`CREATE INDEX IF NOT EXISTS "SessionContextChunk_chat_user_created_idx" ON "SessionContextChunk" ("chatId", "userId", "createdAt" DESC)`;
      await connection.unsafe(`CREATE INDEX IF NOT EXISTS "SessionContextChunk_embedding_idx" ON "SessionContextChunk" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 50)`);
    })();
  }
  return schemaReady;
}

function chunkText(text: string) {
  const chunks: string[] = [];
  const step = Math.max(1, SESSION_RAG_CHUNK_CHARS - SESSION_RAG_CHUNK_OVERLAP_CHARS);
  for (let start = 0; start < text.length; start += step) {
    const chunk = text.slice(start, start + SESSION_RAG_CHUNK_CHARS).trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }
  return chunks;
}

async function embedText(text: string) {
  const model = process.env.OPENHARNESS_EMBEDDING_MODEL;
  if (!model) {
    return fallbackEmbedding(text);
  }

  const baseURL = (process.env.OPENHARNESS_EMBEDDING_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "").replace(/\/$/, "");
  const apiKey = process.env.OPENHARNESS_EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? "not-needed";

  try {
    const response = await fetch(`${baseURL}/embeddings`, {
      body: JSON.stringify({ input: text, model }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`embedding endpoint returned ${response.status}`);
    }
    const payload = await response.json();
    const embedding = payload?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error("embedding endpoint returned no embedding array");
    }
    return normalizeVector(embedding.map((value: unknown) => Number(value) || 0));
  } catch (error) {
    console.warn("Session RAG embedding failed; using fallback embedding", error);
    return fallbackEmbedding(text);
  }
}

export async function storeSessionContext({
  chatId,
  content,
  metadata = {},
  sourceMessageId,
  userId,
}: {
  chatId: string;
  content: string;
  metadata?: SessionContextMetadata;
  sourceMessageId?: string;
  userId: string;
}) {
  if (!isSessionRagEnabled() || !content.trim()) {
    return 0;
  }

  await ensureSessionRagSchema();
  const chunks = chunkText(content);

  for (const [index, chunk] of chunks.entries()) {
    const embedding = vectorLiteral(await embedText(chunk));
    await connection`
      INSERT INTO "SessionContextChunk" (
        "chatId",
        "userId",
        "sourceMessageId",
        "content",
        "embedding",
        "metadata"
      ) VALUES (
        ${chatId}::uuid,
        ${userId}::uuid,
        ${sourceMessageId ?? null}::uuid,
        ${chunk},
        ${embedding}::vector,
        ${JSON.stringify({ ...metadata, chunkIndex: index, chunkCount: chunks.length })}::jsonb
      )
    `;
  }

  return chunks.length;
}

export async function searchSessionContext({
  chatId,
  limit = 4,
  query,
  userId,
}: {
  chatId: string;
  limit?: number;
  query: string;
  userId: string;
}) {
  if (!isSessionRagEnabled() || !query.trim()) {
    return [];
  }

  await ensureSessionRagSchema();
  const embedding = vectorLiteral(await embedText(query));
  const rows = await connection`
    SELECT
      "id"::text AS id,
      "sourceMessageId"::text AS source_message_id,
      "content",
      "metadata",
      "createdAt" AS created_at,
      1 - ("embedding" <=> ${embedding}::vector) AS similarity
    FROM "SessionContextChunk"
    WHERE "chatId" = ${chatId}::uuid AND "userId" = ${userId}::uuid
    ORDER BY "embedding" <=> ${embedding}::vector
    LIMIT ${limit}
  `;
  return rows as unknown as SessionContextRow[];
}

export function formatSessionRagContext(rows: SessionContextRow[]) {
  if (rows.length === 0) {
    return "";
  }

  let remaining = SESSION_RAG_PROMPT_CHARS;
  const sections: string[] = [];
  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }
    const header = `Session memory chunk ${row.id} similarity=${Number(row.similarity).toFixed(3)}\n`;
    const body = row.content.slice(0, Math.max(0, remaining - header.length));
    sections.push(`${header}${body}`);
    remaining -= header.length + body.length;
  }

  return `Relevant session memory retrieved from pgvector:\n\n${sections.join("\n\n---\n\n")}`;
}