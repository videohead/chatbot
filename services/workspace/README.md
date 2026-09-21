# Chatbot workspace adapter

This MCP service exposes only two explicitly assigned host directories to the
chatbot. On the Spark deployment they are:

- `/home/blechdom/creative` as `creative/`
- `/home/blechdom/nvidia` as `nvidia/`

The service accepts short-lived, account-bound requests signed by the chatbot.
It runs as UID/GID `1000:1000`, has a read-only container filesystem, drops all
capabilities, and does not mount the user's home, SSH keys, or Docker socket.

Runtime policy, state, and the shared signing secret live outside this folder
under `/home/blechdom/.config/chatbot-workspace` with private permissions.

The Compose definition requires explicit host paths for both workspaces, state,
policy, the signing token, and the two forge tokens. Their contents are never
part of the image or this repository. The production Spark wrapper supplies
those values when it builds or updates the adapter.

Fixed Git tools support repositories under either root. Remote access is
restricted to `github.com` and `gitlab-master.nvidia.com`, uses HTTPS tokens
from private read-only files, disables repository hooks, and never places a
credential in a remote URL. Push requires approval in the chat.
