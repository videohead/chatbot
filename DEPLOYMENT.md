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
