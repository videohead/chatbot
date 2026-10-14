# Tool chain logging

The chatbot can run filesystem/system tools through the LiteLLM MCP gateway.
That chain has three hops and three log streams. This page is the map: where
each log lives, which event names mark each hop, and how to trace one tool call
end to end.

## The chain

```
chatbot (Next.js route)
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

All three emit one-JSON-object-per-line logs with `event`, `level`, `service`,
and `timestamp` fields (LiteLLM's own request logs use its standard format).
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
| `chat.tool.stub_result` | warn | Same bounce observed from the step-finish handler; includes `consecutiveBounces` counter |
| `chat.tool.gateway_bounce_loop` | error | Second consecutive bounce. The run is stopped via `stopWhen` and the user is notified in-chat |
| `chat.stream.error` | error | The model stream failed; `error.error.message` usually contains the upstream provider's reason (context window exceeded, connection error, invalid request) |
| `chat.response.error` | error | Terminal wrapper that surfaces to the UI as "An error occurred."; find the paired `chat.stream.error` for the real cause |
| `chat.response.persisted` | info | Assistant messages saved to Postgres; includes `messageIds` and role summary |
| `chat.response.stream_started` | info | SSE stream handed to the browser; `resumable` indicates Redis-backed resume |
| `chat.title.fallback` | warn | Title generation failed (often the local `gpt-oss-20b` model being down); chat keeps a fallback title |
| `agent_framework.delegate.start` / `.error` | info/error | The `delegateToAgentFramework` tool; `.error` includes the upstream 502 body with the underlying LiteLLM failure |

### metis-router (`service: "metis-router"`)

Emitted by `server/src/mcp-proxy.ts` via `mcpStructuredLog`.

| Event | Level | Meaning |
| --- | --- | --- |
| `metis.tool.call.start` | info | Routed call received; includes `routedName`, `upstreamServer`, `upstreamToolName`, `routedToolCount` |
| `metis.tool.call.complete` | info | Upstream call succeeded; includes `attempt`, `durationMs` |
| `metis.tool.call.attempt_failed` | warn | One upstream attempt failed; includes `attempt`, `error` |
| `metis.tool.call.failed` | error | Retries exhausted or non-transient failure; the tool result carries a structured `error` payload back to the caller |

If a chatbot request shows a tool call but metis-router shows **no**
`metis.tool.call.start`, the call never left LiteLLM: look for a gateway bounce
(chatbot events above) or a LiteLLM-side failure.

### LiteLLM

LiteLLM keeps two layers of evidence. The quick layer is its stdout
(`docker logs litellm`, rotated 10m x 3): request status codes,
`BadRequestError`, `ContextWindowExceededError`, `Connection error` (usually a
down vLLM container), and `Received Model Group=<model>` lines.

The durable layer is the **database audit trail** in the `litellm` database on
`litellm_db` (Postgres). Every completion and every MCP tool execution is a
row in `LiteLLM_SpendLogs` with `request_id`, `model`, `model_group`, `status`,
`request_duration_ms`, token counts, spend, full `messages` and `response`
payloads, and `mcp_namespaced_tool_name` for gateway tool calls. Query it with:

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
executions that failed inside LiteLLM's MCP handling. A chatbot `chat.tool.call`
whose toolName appears nowhere in `SpendLogs` never reached LiteLLM's gateway
(bounced to the client-side stub). Names before 2026-10-12 use the old
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
| 5 | `agent_framework.delegate.start` / `.success` / `.error` | chatbot | Only when the model delegates to agent-framework; `.error` carries the upstream 502 body |
| 6 | `metis.tool.call.start` / `.complete` / `.failed` | metis-router | Only for gateway tool calls; routed name, upstream server, attempt, duration |
| 7 | `chat.tool.call` | chatbot | Per completed tool call in a step; args and result previews truncated |
| 8 | `chat.stream.end` | chatbot | Model stream finished cleanly |
| 9 | `chat.response.end` | chatbot | UI message stream assembled; final message count |
| 10 | `chat.response.persisted` | chatbot | Assistant messages saved to Postgres (`messageIds`, role summary) |
| 11 | `chat.response.stream_started` | chatbot | SSE handed to the browser; `resumable` shows whether Redis-backed resume is active |

Failure events that can appear instead of steps 8-11:
`chat.tool.gateway_bounce` / `chat.tool.stub_result` (deployment bounced the
tool call to the app), `chat.tool.gateway_bounce_loop` (run stopped at two
bounces), `chat.stream.error` (model stream failed; `error.error.message`
holds the upstream reason), `chat.response.error` (terminal "An error
occurred." wrapper), `chat.stream.persistence_consumer_error` (background SSE
consumer failed; the visible stream may still be fine),
`chat.post.chatbot_error` / `chat.post.unhandled_error` (request rejected or
crashed before streaming), and `chat.title.fallback` (title generation failed;
non-fatal).

## Tracing a failed tool call

1. Find the failure in the chatbot log by chat id or time:
   `grep 'chat.tool.gateway_bounce\|chat.tool.stub_result\|chat.stream.error' /opt/chatbot/logs/chatbot-current.log`
2. Read the `model` field. If the bounce events fired, this model's deployment
   did not execute tools server-side; the run stops after two bounces and the
   user sees an explanation instead of an endless retry.
3. For successful routing, confirm the middle hop in LiteLLM:
   `docker logs litellm 2>&1 | grep <timestamp-minute>`
4. Confirm execution at metis-router:
   `docker logs metis-server 2>&1 | grep metis.tool`
   A healthy call shows `start` then `complete` within milliseconds to seconds.
   `attempt_failed` then `complete` means an upstream reconnected and retried.
   `failed` means the upstream MCP server itself errored.

## Loop protection (why runs stop at two bounces)

The chatbot registers placeholder `dynamicTool` entries for the gateway tools
(`app/(chat)/api/chat/route.ts`, the `litellmMcpTools` map). For deployments
that execute MCP tools server-side, these stubs never run. When a deployment
bounces a call back to the client, the stub:

1. Logs `chat.tool.gateway_bounce` and throws an instructive error to the
   model (do not retry, explain to the user).
2. The step-finish handler counts bounces; the first writes a
   `data-waiting-status` notice visible in the chat UI.
3. A second bounce logs `chat.tool.gateway_bounce_loop`, writes a final UI
   notice, and a `stopWhen` condition ends the run before the model can burn
   the context window re-calling.

Historical note: before 2026-10-14 the stubs returned a fake success marker
and the loop stopped silently after one tool call, which surfaced as
multi-minute "waiting" and eventually `ContextWindowExceededError`. If old
logs show `chat.tool.stub_result` with `toolResult: '""'` and no
`gateway_bounce` events, that conversation predates the fix.
