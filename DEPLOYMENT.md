# Spark chatbot deployment

The canonical source checkout is `/opt/chatbot`. The public site is served at
`https://videohead.duckdns.org`; Traefik terminates TLS and forwards the chatbot
router to `http://127.0.0.1:3000`.

The live application is an immutable production image built from an exact clean
Git commit with `deploy/production/Dockerfile`. It runs as the `chatbot`
container in production mode. Source code and `node_modules` are not mounted
into the live container.

## Runtime boundaries

- Application source and generated media: `/opt/chatbot`
- Workspace adapter source: `/opt/chatbot/services/workspace`
- Private release state and rollback records:
  `/home/blechdom/.config/chatbot-cleanup`
- Workspace policy, state, and forge credentials:
  `/home/blechdom/.config/chatbot-workspace`
- Root-owned chatbot secrets: `/etc/chatbot/secrets`

Secret files and the generated `model-catalog.json` are not committed. The
catalog is assembled from metadata-only provider and local-model inputs,
validated for allowed fields and credential-shaped values, and hashed into the
private release manifest before it is copied into an image.

## Release flow

1. Preserve a clean source commit and validate the deployment package checksums.
2. Build an immutable candidate on a loopback-only test port with restart
   disabled.
3. Validate login, chat, model discovery, upload/media, workspace, and Git
   behavior. The public HTTPS smoke must verify the local Qwen deployment.
4. Hand port 3000 to the exact tested image while leaving Traefik unchanged.
5. Retain the preceding container and a release-specific rollback command until
   the public service has passed the rollback window.

Each candidate and live release uses a unique Compose project. Candidate bind
mounts must exist before Compose starts so missing paths cannot be silently
created with root ownership. Only the validated live deployment receives an
`unless-stopped` restart policy.

## Workspace adapter

`services/workspace` builds the account-scoped MCP adapter that exposes only the
assigned `creative` and `nvidia` roots. Its Compose file requires explicit host
paths for workspaces, state, policy, and credential files. No home directory,
SSH directory, Docker socket, or credential value is included in the image.
