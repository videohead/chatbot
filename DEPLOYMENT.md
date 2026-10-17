# Chatbot deployment

`/opt/chatbot` is the only source and operations root for this project. The
production Compose entrypoint is [`compose.yaml`](compose.yaml), whose project
name is `chatbot` and whose single owned service is:

- `web`: the Next.js login, conversation, upload, and chat application.

The live container name is `chatbot-web-1`. Shared LiteLLM, PostgreSQL, and
Agent Framework services remain external dependencies on `metis-network`.
Traefik routes the public site to `127.0.0.1:3000`; application operations do
not edit Traefik.

Project source and operations files are owned by `videohead:optusers`; the
setgid project directories keep new files in `optusers`. Runtime logs and
generated media remain owned by the UID used by the web process.

## Operator commands

Run these from `/opt/chatbot` in an ordinary Spark host terminal:

```bash
docker compose config --quiet        # validate
docker compose up -d web             # start or recreate the web service
docker compose logs -f web          # follow logs
docker compose restart web           # restart in place
docker compose down                  # stop the stack (add -v only if you
                                    # intend to also delete project volumes;
                                    # never do this for chatbot operations)
```

The compose file is fully self-contained: the image tag, environment, ports,
secrets, and volumes are all inline. There is no env file and no release
framework; the image tag in the file is the single source of truth for which
release is deployed. To deploy a new build, update the `image:` tag in
[`compose.yaml`](compose.yaml) and run `docker compose up -d web`.

## Runtime and credentials

Application logs live in `/opt/chatbot/logs`; generated images and videos live
in `/opt/chatbot/generated-media`. Both paths are ignored by Git.

Credential files live under `/etc/chatbot/secrets`. They are never placed in
Compose environment files, Git, image layers, command arguments, or logs. The
web container receives only the secret files it needs: the auth secret, the
PostgreSQL password, and the LiteLLM client key.

Never run `docker compose down -v`, a blanket Docker prune, or delete the
shared LiteLLM/PostgreSQL volumes as part of chatbot operations.

## Host project execution

Chat requests use SDK-owned tool execution and delegate
host edits to the external Agent Framework service. Do not mix those functions
with LiteLLM's MCP auto-execution: the gateway tries to execute application
functions it does not own, generating false failures and duplicate tool calls.
The application provider never injects MCP gateway tools, even when no
application tools are active: otherwise models call functions the SDK cannot
execute and receive `AI_NoSuchToolError` with an empty available-tools list.
Qwen 3.8 Flash Next has a verified tool-capability override because the
generated catalog incorrectly marks it tool-disabled. Truly tool-disabled
models receive a no-tools prompt rather than instructions to call the harness.
The account-scoped workspace setting does not govern `/opt` access.
Keep `CHATBOT_ENABLE_DIRECT_MCP_TOOLS=false`: local MCP stubs do not execute
host edits. Multiple delegation calls in one chat turn share one execution;
the harness rejects overlapping requests for the same conversation with HTTP
409 rather than running or queuing conflicting work.

The harness continues open todos for up to three passes and eight minutes.
The web caller allows 510 seconds (within the chat route's 600-second budget).
Its response distinguishes `completed` from `incomplete` and lists remaining
tasks. A legacy response without completion metadata is unverified, not a
success. A handled request is not proof that code was integrated or tests
passed: the assistant must report only evidence in the final harness report.
Incomplete and failed calls may have applied partial changes; inspect the
project and saved session before retrying. Host implementation requests must
not silently fall back to paste-in artifacts.
