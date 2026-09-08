# OpenHarness Chat Agent Instructions

OpenHarness Chat is a self-hosted fork of the Vercel AI-SDK chatbot template:
Next.js App Router + AI SDK + shadcn/ui + Drizzle, served at
`https://videohead.duckdns.org/harness` (container `openharness-chat`, port
`127.0.0.1:15000`). It provides a long-running agentic chat UI with DB-backed
history, resumable streams (Redis db 1), automatic context compaction, and an
Artifacts side panel (`createDocument`/`editDocument`/`updateDocument`/
`requestSuggestions`, plus the template's `getWeather` demo tool).

The composer exposes four execution modes: **Direct** (model-only chat),
**Harness** and **MAF** (OpenHarness agent tools), and **MCP** (full
cross-service tool set). All MCP tool access routes through the metis-router
gateway (`METIS_MCP_URL`, default `http://metis-server:9999/mcp`) — never
directly at downstream MCP servers — so namespaced tools like
`videobrain:read_repo_file` are consistently available across turns. Model
inference is direct to the selected OpenHarness model pool in every mode.

## Tool execution rule

All tool calls that invoke `python`, `node`, `vite`, or `php` MUST run inside
Docker — never on the host. The host has no project runtimes installed.

- Node/pnpm for this app runs in the `openharness-chat` compose service
  (`node:22-alpine`-based image), e.g.
  `docker compose -f /opt/openharness-chat/docker-compose.yml exec openharness-chat npx tsc --noEmit`
  or `docker run --rm -v /opt/openharness-chat:/srv -w /srv node:22-alpine ...`
- This is a production image build: source edits take effect only after
  `docker compose up -d --build openharness-chat`. A container restart alone
  does not pick up TypeScript changes.

## Key paths

- `app/(chat)/api/chat/route.ts` — chat streaming route, tool registration,
  agent-mode handling
- `lib/ai/mcp.ts` — metis-router gateway MCP client
- `lib/ai/prompts.ts` — system prompts, MCP tool descriptions
- `lib/ai/tools/` — local (non-MCP) tools, mostly template-derived
