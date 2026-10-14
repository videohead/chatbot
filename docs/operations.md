# Operations contract

The project has one checkout and one production Compose entrypoint.

| Purpose | Location or name |
| --- | --- |
| Source and deployment root | `/opt/chatbot` |
| Production Compose | `/opt/chatbot/compose.yaml` |
| Production project | `chatbot` |
| Production container | `chatbot-web-1` |
| Public loopback port | `127.0.0.1:3000` |
| Logs | `/opt/chatbot/logs` |
| Tool chain log map | [`tool-chain-logging.md`](tool-chain-logging.md) |
| Generated media | `/opt/chatbot/generated-media` |
| Credentials | `/etc/chatbot/secrets` |
| Public routing | `/opt/traefik/dynamic.yml` |

The project maintainer ownership is `videohead:optusers`. Runtime data uses the
service UID required by its container; credentials remain root-owned.

Release identity lives only in the immutable `image:` tag inside
[`compose.yaml`](../compose.yaml), which is the single source of truth for
which release is deployed. There is no release framework, candidate project,
or separate manifest; updating the tag and running
`docker compose up -d web` from `/opt/chatbot` is the entire deploy
procedure.

Chat history remains in the existing PostgreSQL database behind `litellm_db`.
This deployment does not create, replace, or remove that database or its
volume.
