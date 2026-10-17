# Tool chain logging

The chatbot delegates host work to Agent Framework. Its provider never injects
MCP gateway tools, including requests with no active application tools. Do not combine
application function tools with gateway auto-execution: the gateway attempts
to execute those functions too and feeds false tool failures to the model.
This page is the map: where
each log lives, which event names mark each hop, and how to trace one tool call
end to end.

## The chain

```
chatbot (application tools executed by the AI SDK)
  -> agent-framework :8000 (host implementation and validation)
    -> metis-server :9999 -> upstream MCP servers
    -> LiteLLM :4000 -> model providers

External gateway clients (not the chatbot provider):
gateway-only client
  -> LiteLLM proxy :4000  (chat.completions with tools: [{type: "mcp", ...}])
    -> metis-server :9999  (MCP router, aggregates upstream MCP servers)
      -> upstream MCP servers (ubuntu-controller, github, comfyui, docker-mcp...)
```

Tool names are namespaced at every hop:

| Hop | Name shape | Example |
| --- | --- | --- |
| Upstream MCP server | bare | `execute_command` |
| metis-router route | `server__tool` (double underscore) | `filesystem__execute_command` |
| LiteLLM gateway exposure | `metis_router-server__tool` | `metis_router-filesystem__execute_command` |

The separator is `__`, not `:`. Hosted model APIs (OpenAI, Anthropic) reject
tool names that do not match `^[a-zA-Z0-9_-]+$`; the old colon names caused
every tool-bearing request to fail with
`Invalid 'tools[0].name': string does not match pattern`.

## Where the logs live

| Service | Location | Persistence |
| --- | --- | --- |
| chatbot | `/opt/chatbot/logs/chatbot-current.log` (symlink) and dated `chatbot-YYYY-MM-DD.log` | Bind mount `/opt/chatbot/logs`; entrypoint `scripts/docker-entrypoint.sh` tees stdout there |
| LiteLLM | `docker logs litellm` | json-file driver, 10m x 3 rotation |
| metis-router | `docker logs metis-server` | json-file driver, 10m x 3 rotation |
| Agent Framework | `docker logs agent-framework` | json-file driver, 10m x 3 rotation; durable sessions in `/opt/agent-framework-service/data/sessions` |

Chatbot and Metis application events use `event`, `level`, `service`, and
`timestamp`; Agent Framework uses `message` for the event name. LiteLLM's own
request logs use its standard format.
Timestamps are UTC ISO-8601, so a single tool call can be correlated across
services by time window plus tool name.

## Event dictionary

### chatbot (`service: "chatbot"`)

Emitted by `app/(chat)/api/chat/route.ts` and `lib/logger.ts`.

| Event | Level | Meaning |
| --- | --- | --- |
| `chat.post.model_ready` | info | Model resolved for this request; includes `requestedModel`, `resolvedModel`, `supportsTools` |
| `chat.litellm.request` | info | Outbound boundary to LiteLLM; includes `model`, `messageCount`, `gatewayToolsOffered`, `workspaceToolsOffered` |
| `chat.tool.call` | info | A tool call completed (or failed) in this step; includes `toolName`, `toolArgs` (truncated), `toolResult` (truncated), `toolCallId`, `chatId` |
| `chat.tool.gateway_bounce` | error | An MCP stub `execute` ran, meaning the deployment returned the tool call to the app instead of executing it on the gateway. The call is failed deliberately; the host was not touched |
| `chat.tool.stub_result` | warn | Empty/error tool result detected; includes `consecutiveBounces`. Inspect the actual error: this can be an SDK unknown tool, not a gateway failure |
| `chat.tool.gateway_bounce_loop` | error | Repeated empty/error results detected. This historical event name does not prove the gateway failed; the MCP-specific stop condition is gated by direct mode |
| `chat.stream.error` | error | The model stream failed; `error.error.message` usually contains the upstream provider's reason (context window exceeded, connection error, invalid request) |
| `chat.response.error` | error | Terminal wrapper that surfaces to the UI as "An error occurred."; find the paired `chat.stream.error` for the real cause |
| `chat.response.persisted` | info | Assistant messages saved to Postgres; includes `messageIds` and role summary |
| `chat.response.stream_started` | info | SSE stream handed to the browser; `resumable` indicates Redis-backed resume |
| `chat.title.fallback` | warn | Title generation failed (often the local `gpt-oss-20b` model being down); chat keeps a fallback title |
| `agent_framework.delegate.start` / `.error` | info/error | The `delegateToAgentFramework` tool; `.error` includes the upstream HTTP failure or transport error |
| `agent_framework.delegate.result` | info/warn | Harness outcome, finish reason, and pending-task count; incomplete or legacy/unverified results are warnings, not successful completion |
| `agent_framework.delegate.duplicate` | warn | Repeated or parallel tool call in the same turn reused the existing execution; no new harness run |
| `agent_framework.delegate.busy` | warn | The service rejected an overlapping conversation request with HTTP 409; wait for the active run, not an outage |

### metis-router (`service: "metis-router"`)

Emitted by `server/src/mcp-proxy.ts` via `mcpStructuredLog`.

| Event | Level | Meaning |
| --- | --- | --- |
| `metis.tool.call.start` | info | Routed call received; includes `routedName`, `upstreamServer`, `upstreamToolName`, `routedToolCount` |
| `metis.tool.call.complete` | info | Upstream call succeeded; includes `attempt`, `durationMs` |
| `metis.tool.call.attempt_failed` | warn | One upstream attempt failed; includes `attempt`, `error` |
| `metis.tool.call.failed` | error | Retries exhausted or non-transient failure; the tool result carries a structured `error` payload back to the caller |

For delegated host work, follow `agent_framework.delegate.start` in the chatbot,
`agent run started` in Agent Framework, and then `metis.tool.call.start`.
No Metis event can mean the harness never called a host tool, not that the call
was lost inside LiteLLM. In this path LiteLLM handles inference, not MCP execution.

### Failure signatures and verification

| Symptom | Check before concluding |
| --- | --- |
| `AI_NoSuchToolError`, `Available tools: .` | The SDK active-tool list is empty. Check `supportsTools` and the outbound request; do not inject MCP tools behind the SDK's back |
| Model says delegation failed before the real result | Check for mixed application functions and LiteLLM MCP auto-execution; the gateway may have attempted a function owned by the chatbot |
| HTTP 409 | A run already owns this conversation. No additional run was started; wait for it |
| HTTP 200 with `status: incomplete` | Inspect pending tasks and partial changes; do not claim success or blindly replay the request |
| `writable: true` from filesystem diagnostics | Permission checks passed, but only an explicit write/read probe can verify a write |

Start with read-only health checks:

```bash
curl -fsS http://127.0.0.1:8000/ready
curl -fsS http://127.0.0.1:8000/diagnostics
curl -fsS 'http://127.0.0.1:9999/health?detail=true'
docker logs --since=10m chatbot-web-1
docker logs --since=10m agent-framework
docker logs --since=10m metis-server
```

Readiness and loaded tool counts do not prove a task completed. Validate the
streaming model -> SDK function -> harness -> Metis path with a synthetic
request. For a read-only host check, delegate `filesystem__filesystem_diagnostics`
with an explicit project path and `probe_write: false`, then inspect the actual
tool result in the saved harness session. For write verification, use a unique
temporary file in an approved location, read back exact bytes independently,
and clean up only that file and any backup the tool created. Never use model
narration as the evidence, or write test files into projects without approval.

On 2026-10-16, Qwen 3.8 Flash Next passed streaming delegation and a read-only
diagnostics call for `/opt/morphazoid`. No project file was written by that
check. Synthetic host read/write/read and overlap-rejection checks also passed
separately. These observations are not a guarantee of future service readiness.

### LiteLLM

LiteLLM keeps two layers of evidence. The quick layer is its stdout
(`docker logs litellm`, rotated 10m x 3): request status codes,
`BadRequestError`, `ContextWindowExceededError`, `Connection error` (usually a
down vLLM container), and `Received Model Group=<model>` lines.

The durable layer is the **database audit trail** in the `litellm` database on
`litellm_db` (Postgres). Logged completions and gateway MCP executions have a
row in `LiteLLM_SpendLogs` with `request_id`, `model`, `model_group`, `status`,
`request_duration_ms`, token counts, spend, and `mcp_namespaced_tool_name` for
gateway tool calls. `messages` and `response` may be empty or redacted; do not
assume full request bodies are retained. Direct harness-to-Metis executions
are not LiteLLM gateway calls. Query it with:

```bash
# Recent requests, newest first
docker exec litellm_db psql -U llmproxy -d litellm -c \
  "SELECT request_id, call_type, model, model_group, status, request_duration_ms, created_at
   FROM \"LiteLLM_SpendLogs\" ORDER BY created_at DESC LIMIT 20"

# All MCP tool executions through the gateway, with outcome
docker exec litellm_db psql -U llmproxy -d litellm -c \
  "SELECT mcp_namespaced_tool_name, status, count(*), max(created_at)
   FROM \"LiteLLM_SpendLogs\" WHERE mcp_namespaced_tool_name IS NOT NULL
   GROUP BY 1,2 ORDER BY 3 DESC"
```

Rows with `mcp_namespaced_tool_name` set but `status` not `success` mark tool
executions that failed inside LiteLLM's MCP handling. Absence from this table
does not imply a bounce: harness-to-Metis tools bypass LiteLLM execution.
Names before 2026-10-12 use the old
`server:tool` colon form; after, `server__tool`.

`LiteLLM_AuditLog` additionally records proxy management actions (key
creation, config changes), not model traffic.

## Message lifecycle events

A single chat message travels through these logged points, in order. If a
message stalls, find the last event that fired and the next one that didn't:
the failure is between them.

| Order | Event | Service | Meaning |
| --- | --- | --- | --- |
| 1 | `chat.post.start` | chatbot | HTTP request accepted; includes chatId, selected models, message part count |
| 2 | `chat.post.model_ready` | chatbot | Model resolved; `resolvedModel`, `supportsTools`, `capability` |
| 3 | `chat.litellm.request` | chatbot | Outbound boundary: model, message count, gateway/workspace tool counts being offered |
| 4 | (request row) | LiteLLM DB | `LiteLLM_SpendLogs` row with `request_id`, model_group, status, duration |
| 5 | `agent_framework.delegate.start` / `.result` / `.error` | chatbot | Only when the model delegates to agent-framework; `.result` distinguishes completed and incomplete execution; `.error` carries request failure details |
| 6 | `metis.tool.call.start` / `.complete` / `.failed` | metis-router | Routed MCP execution from the harness or another MCP client; upstream server, attempt, duration |
| 7 | `chat.tool.call` | chatbot | Per completed tool call in a step; args and result previews truncated |
| 8 | `chat.stream.end` | chatbot | Model stream finished cleanly |
| 9 | `chat.response.end` | chatbot | UI message stream assembled; final message count |
| 10 | `chat.response.persisted` | chatbot | Assistant messages saved to Postgres (`messageIds`, role summary) |
| 11 | `chat.response.stream_started` | chatbot | SSE handed to the browser; `resumable` shows whether Redis-backed resume is active |

Failure events that can appear instead of steps 8-11:
`chat.tool.gateway_bounce` (legacy stub executed),
`chat.tool.stub_result` / `chat.tool.gateway_bounce_loop` (empty/error tool
results, which need diagnosis rather than an assumed gateway outage),
`chat.stream.error` (model stream failed; `error.error.message`
holds the upstream reason), `chat.response.error` (terminal "An error
occurred." wrapper), `chat.stream.persistence_consumer_error` (background SSE
consumer failed; the visible stream may still be fine),
`chat.post.chatbot_error` / `chat.post.unhandled_error` (request rejected or
crashed before streaming), and `chat.title.fallback` (title generation failed;
non-fatal).

## Tracing a failed tool call

1. Find the request in `docker logs chatbot-web-1` by chat ID/time. Check the
   selected model's `supportsTools`, not just whether it generated tool calls.
2. Check `agent_framework.delegate.start` and its matching result/error.
   HTTP 409 means another run is active. Missing completion metadata means
   unverified completion, not success.
3. Follow the request/session ID in `docker logs agent-framework`. Confirm
   the actual tool call and result. Inspect pending tasks on incomplete runs.
4. Correlate `metis.tool.call.start` with `complete` or `failed` in
   `docker logs metis-server`. A completed transport call can still contain
   a tool-level error; inspect the payload.
5. Check `docker logs litellm` separately for model inference failures. Only
   gateway-only clients should require LiteLLM MCP execution records.

## Loop and overlap protection

The current path shares one delegation promise per chat turn and rejects
overlapping harness runs for a session with HTTP 409. Harness TODO
continuation is bounded to three passes and eight minutes. The caller waits
510 seconds; the route budget is 600 seconds.

Legacy local MCP definitions remain in `litellmMcpTools` but production keeps
direct mode disabled. Stub failures and their historical bounce notices are
not a supported execution path. Their MCP-specific `stopWhen` guard only
applies when direct mode is enabled; the general SDK step limit still applies.
Do not infer that old empty-result logs predate a particular fix: the same
signature can arise from unknown tools in a newer request.
