# Chatbot Project Instructions

## What This Is

A dockerized fork of the Vercel Next AI chatbot with customizations for the DGX Spark platform. Authenticated users interact with AI models to work on and deliver results for the projects hosted in `/opt`.

LiteLLM sits behind the chatbot and routes requests through its configured models. Metis Router exposes MCPs (file system, Docker, Ubuntu tools, ComfyUI, etc.) so the chat is a single interface for software development, container management, and all other tool-backed work.

Agentic work goes through the agent-framework-service, giving models access to long-running, multi-step execution. A RAG system lets the chatbot store and retrieve large amounts of project context across conversations. The sidebar links to the web-based projects in `/opt` and includes a LiteLLM health check.

## Goals: AI Models Delivering Results Over Time

The central purpose of this platform is enabling AI models to make real, sustained progress on projects -- not just answer questions, but ship work. These goals guide development:

### 1. Persistent Project Awareness
Models should be able to pick up where they left off. When a user returns to a project, the model should know the current state of the codebase, recent changes, open issues, and what was attempted last. This means:
- RAG-backed project memory that survives across chat sessions
- Indexing of git history, README/OPERATIONS docs, and SERVICES.md for each project
- Clear per-project instruction files (`.github/instructions/`) that models can consume to understand conventions, deployment shape, and known issues

### 2. Reliable Tool Use and Error Recovery
Models must be able to call tools, get results, and recover when things go wrong. A failed MCP call or an unavailable model should never be a dead end. This means:
- Structured error responses from LiteLLM and Metis Router that models can interpret and act on
- Fallback messaging that tells the user what happened and what to try next
- Logging that captures tool-call failures with enough detail to diagnose routing and availability problems

### 3. Autonomous Project Execution
The platform must support work that happens without a user actively present in the chat. The agent-framework-service is the execution engine for this. The workflow:

1. **User defines a goal** in the chatbot (e.g., "Add health-check gating to LiteLLM model listing")
2. **The chatbot creates a project plan** -- a structured breakdown of the goal into ordered tasks with acceptance criteria
3. **The plan is dispatched to agent-framework-service**, which persists it and begins executing tasks sequentially using agents backed by available models
4. **Agents work through tasks autonomously** -- reading code, making changes on branches, running builds/tests, using MCPs -- without requiring the user to be online
5. **When the user returns**, the chatbot shows the current state: what completed, what failed, what's blocked, with links to branches and execution logs

This means:
- The chatbot is the **planning and monitoring interface** -- users create goals, review plans, approve/reject results, and provide feedback
- The agent-framework-service is the **execution engine** -- it owns the task queue, runs agents against tasks, enforces acceptance criteria, and reports outcomes
- Progress accumulates across sessions. Work artifacts (commits, branches, configs, deployed containers) are the primary deliverables, not conversation
- A failed task produces a structured failure report with enough context for the agent (or the user) to retry with better information
- Agents commit to branches, never to main. Nothing merges without user approval

### 4. Project Plans and Task Structure
Project plans are the core unit of autonomous work. A plan consists of:

- **Goal**: What the user wants accomplished, in concrete terms
- **Project scope**: Which repo(s) and service(s) are involved
- **Tasks**: An ordered list, each with:
  - A description of what to do
  - Acceptance criteria (testable: build passes, endpoint returns 200, file exists, tests green)
  - Dependencies on other tasks
  - Status (pending, in-progress, completed, failed, blocked)
  - Execution log (what the agent did, what tools it called, what changed)
  - Branch name for any code changes
- **Schedule**: One-shot or recurring (e.g., daily health checks, weekly dependency audits)
- **Priority**: Determines queue ordering when multiple plans are active

Plans are stored in Postgres (the chatbot's existing database). The chatbot UI surfaces them in the sidebar alongside project links. The agent-framework-service exposes API endpoints for plan CRUD, task status updates, and execution logs.

Models involved in planning should:
- Break vague goals into concrete, testable tasks
- Order tasks by dependency
- Estimate which tools and MCPs each task will need
- Flag tasks that require user input or approval before proceeding

### 5. Model Readiness and Availability
Only models that are healthy and capable of returning results should be offered to users. This means:
- LiteLLM's model directory should reflect actual readiness, not just configuration
- Development or experimental models should be clearly flagged or excluded from the default roster
- Health checks should verify end-to-end capability (model loaded, inference working, tools routable) before listing a model as available

### 6. Cross-Project Coordination
Many projects on this platform depend on each other (chatbot on LiteLLM, LiteLLM on Metis Router, Metis Router on Ubuntu MCP, etc.). Models should understand these dependencies and be able to:
- Read SERVICES.md and per-project docs to understand the service graph
- Diagnose issues that span multiple projects (e.g., a chatbot tool failure caused by a Metis Router config change)
- Propose and execute changes that touch multiple repos when the fix requires it

### 7. Measurable Progress
Over time, the platform should make it easy to see whether AI-assisted work is actually moving projects forward:
- Track which projects have been worked on, what changed, and whether builds/deploys succeeded
- Surface stale projects that haven't seen attention
- Make it natural for a user to ask "what's the status of X?" and get a grounded, current answer

## Architecture: Agent Roles and Execution

The agent-framework-service is a long-lived process that does not need frequent restarts. It already connects to LiteLLM and Metis Router, has durable sessions, and stays up. The RAG system (accessible via Metis) handles long context. New capabilities should be added as agent roles and orchestration patterns within the existing service, not as new infrastructure.

### Agent Roles to Add

- **Planner agent**: Takes a user goal, uses RAG to load project context and instruction files, and produces a structured task list with acceptance criteria and dependencies. Uses the same LiteLLM/Metis stack as the existing harness.
- **Task executor agent**: Takes a single task from a plan and executes it -- reads code, makes changes on a branch, runs builds/tests via MCPs, and reports structured results (pass/fail, what changed, blockers).
- **The existing model-broker-specialist and mcp-operations-specialist** continue handling diagnostics and routing analysis.

### Orchestration

Use the Microsoft Agent Framework's `SequentialBuilder` (from `agent-framework-orchestrations`) to chain task execution in order. Use `CheckpointStorage` so that if the service restarts, it resumes where it left off.

A background `asyncio` task in the service's lifespan polls for pending plans and feeds them through the orchestration. No external scheduler or job queue needed -- the service is long-lived. Plans and task state persist in Postgres or the existing file-based session store.

### API Surface

The agent-framework-service needs new endpoints:
- `POST /plans` -- create a plan from a goal (planner agent decomposes it)
- `GET /plans/{id}` -- current status, task list, execution logs
- `POST /plans/{id}/approve` -- user approves/rejects results
- `POST /plans/{id}/tasks/{task_id}/retry` -- retry a failed task with optional feedback

The chatbot calls these and surfaces plan status in the sidebar.

### Technology Stack

Everything needed is already available or in the existing dependency tree:
- **Microsoft Agent Framework** (`agent-framework-core`, `agent-framework-orchestrations`): agent roles, orchestration patterns (Sequential, Concurrent, Handoff, Magentic), workflow checkpointing, durable sessions
- **A2A protocol** (`agent-framework-a2a`): inter-agent communication if specialized agents later run as separate services
- **Postgres**: plan/task persistence (chatbot's existing database)
- **RAG via Metis**: project context retrieval for planner and executor agents
- **MCPs via Metis Router**: filesystem, Docker, Ubuntu tools, git -- the execution surface for task agents

No Redis, Celery, or external scheduler is needed. The single-host architecture is sufficient.

## Current Work Needed

### Critical: MCP Tool Execution -- Direct Mode Bug (Fixed 2026-10-12)

**Root cause**: Two MCP tool execution paths exist in the chatbot:

1. **Gateway path** (correct): `appendLitellmMcpGateway` in `lib/ai/providers.ts` transforms the request body, replacing individual `metis_router-*` tool definitions with a single `type: "mcp"` block. LiteLLM's MCP gateway intercepts tool calls server-side, executes them against Metis Router, and injects real results back into the model conversation. **This works correctly** -- verified end-to-end on 2026-10-12.

2. **Direct mode** (broken): When `CHATBOT_ENABLE_DIRECT_MCP_TOOLS=true`, the chatbot also registers stub tool definitions in the AI SDK's `streamText` call. Every stub's `execute` returns `{"status": "handled_by_litellm_mcp_gateway"}` (`route.ts` line 217). The AI SDK calls these local stubs and feeds the useless response to the model. Additionally, `stopWhen: [hasToolCall(...litellmMcpToolNames)]` halts the stream after one MCP tool call per step.

**Observed behavior** (session `4fdf0a07-5da2-4aad-8eaf-9283b42b5b8c`, GPT-5.5): Model called tools, got stubs back, looped across 7 turns promising to deliver a report it never produced.

**Fix applied**: Set `CHATBOT_ENABLE_DIRECT_MCP_TOOLS: "false"` in `compose.yaml`. With this off, the gateway path handles all MCP tool execution server-side. The `stopWhen` for MCP tools also deactivates, allowing models to chain multiple tool calls per turn.

**Rebuild and restart required** to apply this change.

**Remaining concern**: With direct mode off, MCP tool calls happen transparently inside LiteLLM and may not render as visible tool invocations in the chat UI. The model gets real results and can do real work, but the user may not see explicit "tool call" UI elements for MCP operations. If tool-call visibility in the UI matters, the long-term fix is to make the stub `execute` functions actually proxy to Metis Router (via an HTTP call to `http://metis-server:9999/mcp`) and return real results, rather than relying on the gateway path.

### Error Handling Across the Stack (Audited 2026-10-12)

Error handling between the chatbot, LiteLLM, and Metis Router is currently weak at every layer. Failures are either silent, generic, or produce deeply nested error messages that neither models nor users can act on. This must improve before autonomous execution is viable -- an agent that can't interpret a failure can't recover from one.

**Current state by layer:**

| Layer | What happens on failure | What the user/model sees |
|---|---|---|
| Chatbot `onError` | Logs the error, returns static string | `"Oops, an error occurred!"` |
| Chatbot agent-framework tool | Catches, logs, returns fallback | `"The Agent Framework harness is currently unavailable."` |
| Chatbot MCP stubs (direct mode) | Returns static stub | `{"status": "handled_by_litellm_mcp_gateway"}` |
| LiteLLM MCP gateway failure | Wraps in nested escaped JSON error | Model sees 500 with deeply nested error string |
| LiteLLM model unavailable | Returns 500 with `Connection error.. Received Model Group=X` | Chatbot logs it; user sees "Oops" or nothing |
| Metis Router transport failure | Returns JSON-RPC error `-32000` | LiteLLM wraps it; chatbot may swallow it |
| Metis Router upstream MCP down | Unclear -- needs testing | Unknown |

**Improvements implemented (2026-10-12):**

#### Chatbot (route.ts, prompts.ts, litellm.ts)

1. ✅ **Replaced `"Oops, an error occurred!"`** with `formatStreamError()` -- parses LiteLLM error messages (model unavailable, connection errors, rate limits, auth failures, timeouts, context length, MCP failures, agent framework errors) into concise, actionable user-facing messages with suggested next actions.
2. ✅ **Tool call logging** via `onStepFinish` -- every tool call is logged with tool name, arguments (truncated to 200 chars), call ID, result preview (300 chars), model, and duration.
3. ✅ **Tool-result validation** -- stub/empty results (including `handled_by_litellm_mcp_gateway`) are detected and logged as `chat.tool.stub_result` warnings.
4. ✅ **LiteLLM error parsing** -- `formatStreamError()` extracts the actionable part from LiteLLM's nested escaped JSON errors (model group, error type, connection status) and presents a single readable sentence.

#### LiteLLM (config.yaml, chatbot litellm.ts)

5. ✅ **Structured MCP errors** -- handled from both sides: the chatbot's error parser handles LiteLLM-wrapped MCP errors, and Metis Router now returns structured JSON error objects (see item 7).
6. ✅ **Model readiness gating** -- `fetchUnhealthyModelNames()` queries LiteLLM's `/health` endpoint and filters out models where all endpoints are unhealthy. The chat model selector no longer shows down models like `gpt-oss-20b` when its vLLM server is stopped.

#### Metis Router (mcp-proxy.ts, http-streaming.ts)

7. ✅ **Structured upstream failure responses** -- when a tool call fails after retries, Metis Router returns a JSON object with `error: true`, `tool_name`, `upstream_server`, `reason`, `transient` flag, and a `suggestion` string instead of throwing a raw error.
8. ✅ **Health endpoint per upstream** -- `GET /health?detail=true` returns per-upstream MCP server status including `connected`, `toolCount`, and `error` for each configured server.

#### System Prompt (prompts.ts)

9. ✅ **Anti-loop instructions** added to `regularPrompt`:
   - If a tool call returns no useful data or an error, tell the user immediately
   - Never describe a deliverable more than once without producing it
   - If unable to complete after two attempts, state what is blocking
   - When the Agent Framework is unavailable, say so clearly

### Other Work Needed

- **Model availability**: LiteLLM's model directory sometimes exposes models that aren't ready to return results (development/loading models). Add readiness gating (see error handling item 6 above).
- **Session continuity**: The RAG system exists but project memory across sessions needs to be more structured and reliable. Models should proactively load relevant context when a project is mentioned.
- **Instruction coverage**: Not all projects in `/opt` have `.github/instructions/` files yet. Expand coverage so models have consistent onboarding material for every project.
- **Next.js cache directory**: the chatbot container logs repeated `ENOENT: no such file or directory, mkdir '/app/.next/cache'` errors. Either create the directory in the Dockerfile or mount a volume for it.
