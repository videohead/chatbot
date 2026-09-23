# Chatbot deployment

`/opt/chatbot` is the only source and operations root for this project. The
production Compose entrypoint is [`compose.yaml`](compose.yaml), whose project
name is `chatbot` and whose owned services are:

- `web`: the Next.js login, conversation, upload, and chat application;
- `media`: the project-specific LiteLLM image/video gateway;
- `workspace`: the account-scoped filesystem and Git adapter.

Compose derives the live container names `chatbot-web-1`,
`chatbot-media-1`, and `chatbot-workspace-1`. Shared LiteLLM, PostgreSQL, and
Agent Framework services remain external dependencies on `metis-network`.
Traefik continues to route the public site to `127.0.0.1:3000`; application
operations do not edit Traefik.

Project source and operations files are owned by `videohead:optusers`; the
setgid project directories keep new files in `optusers`. Runtime logs and
generated media remain owned by the UID used by the web process. The workspace
adapter retains the narrowly scoped blechdom UID because it alone needs write
access to blechdom's two approved home-directory workspaces.

## Operator commands

Run these from an ordinary Spark host terminal:

```bash
sudo /opt/chatbot/ops/status
sudo /opt/chatbot/ops/logs
sudo /opt/chatbot/ops/restart
sudo /opt/chatbot/ops/build
sudo /opt/chatbot/ops/candidate
sudo /opt/chatbot/ops/promote
sudo /opt/chatbot/ops/rollback
```

`build` requires a clean committed source tree and produces immutable images.
`candidate` always uses the fixed `chatbot-test` Compose project on loopback
port 15008 with restart disabled. `promote` deploys those exact tested images
on port 3000. It does not rebuild them.

The candidate has separate containers, network, logs, workspace state, and
scratch workspace directories. GitHub and GitLab access is disabled in the
candidate. It deliberately connects to the existing chat database and
generated-media directory so persisted message references remain valid.
Candidate conversations and generated media can therefore persist; use a
clearly named disposable test conversation. Test real workspace writes and
forge access only after promotion, while the retained legacy containers are
still available for rollback.

`down` intentionally requires an explicit stop flag:

```bash
sudo /opt/chatbot/ops/down --confirm-public-stop
```

## Runtime and credentials

Nonsecret release records and workspace state live in `/opt/chatbot/.runtime`.
Application logs live in `/opt/chatbot/logs`; generated images and videos live
in `/opt/chatbot/generated-media`. All three paths are ignored by Git.

Credential files live under `/etc/chatbot/secrets`. They are never placed in
Compose environment files, Git, image layers, command arguments, or logs.
Workspace Git credentials are mounted only into the isolated workspace
service. The web and media containers receive only the secret files they need.

## One-time legacy migration

The September deployment still uses legacy container names and private
home-directory operations scripts. Prepare the canonical candidate without
changing the public service:

```bash
sudo /opt/chatbot/ops/migrate-legacy prepare
```

Test `http://localhost:15008`, then perform the guarded cutover:

```bash
sudo /opt/chatbot/ops/migrate-legacy promote
```

The cutover keeps Traefik, the shared database, chat history, generated media,
and model credentials intact. If health checks fail, the exact preceding three
containers are automatically restored. An explicit legacy rollback remains
available until the retained containers are retired:

```bash
sudo /opt/chatbot/ops/migrate-legacy rollback
```

After the public site and its chat, media, workspace, GitHub, and GitLab
features have been checked, remove only those exact stopped legacy containers:

```bash
sudo /opt/chatbot/ops/cleanup --retire-legacy
```

After later releases, retain only referenced or in-use immutable releases with:

```bash
sudo /opt/chatbot/ops/cleanup --retire-releases
```

This exact-reference cleanup never performs a Docker prune and never removes
the current, previous, pending, tested, migration, or container-backed release.

Never run `docker compose down -v`, a blanket Docker prune, or delete the
shared LiteLLM/PostgreSQL volumes as part of chatbot operations.
