# Operations contract

The project has one checkout, one production Compose entrypoint, one fixed
candidate project, and one documented command surface.

| Purpose | Location or name |
| --- | --- |
| Source and deployment root | `/opt/chatbot` |
| Production Compose | `/opt/chatbot/compose.yaml` |
| Production project | `chatbot` |
| Candidate project | `chatbot-test` |
| Public loopback port | `127.0.0.1:3000` |
| Candidate loopback port | `127.0.0.1:15008` |
| Operations commands | `/opt/chatbot/ops` |
| Nonsecret runtime records | `/opt/chatbot/.runtime` |
| Logs | `/opt/chatbot/logs` |
| Generated media | `/opt/chatbot/generated-media` |
| Credentials | `/etc/chatbot/secrets` |
| Public routing | `/opt/traefik/dynamic.yml` |

The project maintainer ownership is `videohead:optusers`. Runtime data can use
the service UID required by its container; credentials remain root-owned, apart
from workspace files mounted read-only for UID 1000.

Release identifiers belong in immutable image tags and `.runtime` manifests.
They do not belong in project, service, container, network, source-directory,
or Traefik names.

Candidate validation never edits Traefik. It starts all three project services
on their own Compose network and removes that fixed project before another
candidate is created. Promotion reuses the tested image IDs and release-specific
Compose and workspace-policy snapshots. Candidate chat requests use the
existing database and generated-media directory, so their records and media
can persist together. Candidate workspace files and workspace state are
isolated under `.runtime/test`; forge access is disabled until promotion.

Chat history remains in the existing PostgreSQL database behind `litellm_db`.
This deployment does not create, replace, or remove that database or its
volume.
