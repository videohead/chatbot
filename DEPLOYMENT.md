# Primary chatbot deployment

This repository now supplies the public chatbot at
`https://videohead.duckdns.org`. Docker publishes the application only on
`127.0.0.1:3000`; Traefik is the public TLS entry point and forwards its
`chatbot` service to that loopback address.

The Docker Compose project and container retain their historical candidate
names so the tested container did not need to be replaced during promotion:

- Compose project: `chatbot-media-candidate`
- Primary application container: `chatbot-media-candidate`
- Private media gateway: `media-litellm-candidate`
- Retained rollback application container: `chatbot` (stopped)

Start or rebuild the primary deployment:

```bash
sudo bash /opt/chatbot-media-candidate/scripts/start-primary.sh
```

Verify the running container, loopback binding, Traefik route, public login,
and media gateway:

```bash
sudo bash /opt/chatbot-media-candidate/scripts/verify-primary.sh
```

Restart the application with a clean Next.js cache:

```bash
sudo bash /home/blechdom/.config/chatbot-media-candidate/restart-clean.sh
```

The restart helper retains the preceding cache privately and restores it if
the clean restart fails. The port-3000 promotion has an independent container
rollback under:

`/home/blechdom/.config/chatbot-media-promotions/current-port3000/rollback.sh`

Stopping the application requires an explicit acknowledgement because this is
the public service:

```bash
sudo bash /opt/chatbot-media-candidate/scripts/stop-primary.sh --confirm-public-stop
```

Generated images and videos are stored under `generated-media/`. Runtime logs
are stored under `logs/`. Both directories are ignored by Git. Browser media
URLs require an authenticated application session; provider credentials and
provider output URLs are not exposed to the browser.

Image and video requests use the private `media-litellm-candidate` sidecar. It
has no host port, database, or Traefik route. The shared LiteLLM deployment and
its model database remain separate. The sidecar reads provider credentials
through a read-only `/opt/provider-keys` mount; `.env.media` contains the
private gateway key and is ignored by Git.

The composer exposes separate Chat, Image, and Video modes. Chat models may
understand images or videos without generating media. Image and Video modes
list only models with a verified generation endpoint and send requests
directly through the corresponding media transport. Assistant messages store
the responding model and timestamp with the message.
