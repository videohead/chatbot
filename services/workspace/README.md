# Chatbot workspace adapter

**This service is not part of the current deployment.** The production
Compose file defines only the `web` service; the workspace adapter exists as
source only and is not built, started, or routed. The notes below describe its
behavior if it is ever re-introduced.

This MCP service exposes only two explicitly assigned host directories to the
chatbot. On the Spark deployment they are:

- `/home/blechdom/creative` as `creative/`
- `/home/blechdom/nvidia` as `nvidia/`

The service accepts short-lived, account-bound requests signed by the chatbot.
It runs as UID/GID `1000:1000`, has a read-only container filesystem, drops all
capabilities, and does not mount the user's home, SSH keys, or Docker socket.

The shared signing secret and forge credentials live under
`/etc/chatbot/secrets/workspace` with private permissions. The readable policy
source is tracked at `/opt/chatbot/config/workspace-policy.json`; a deployment
would mount a private copy because the adapter deliberately rejects permissive
policy-file modes.

A future Compose definition would live in `/opt/chatbot/compose.yaml`. It would
declare both workspace roots, state, policy, the signing token, and the two
forge tokens. Credential contents are never part of the image or this
repository.

Fixed Git tools support repositories under either root. Remote access is
restricted to `github.com` and `gitlab-master.nvidia.com`, uses HTTPS tokens
from private read-only files, disables repository hooks, and never places a
credential in a remote URL. Push requires approval in the chat.
