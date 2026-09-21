# Production image

This directory contains the generic, immutable production image and Compose
definition for the chatbot. Host-specific release scripts supply the required
paths, public URL, account assignment, ports, image tag, and secret files.

The build context must contain a generated `model-catalog.json`. The file is
runtime inventory derived from the LiteLLM deployment database and provider
metadata, so Git ignores it. It must contain metadata only. Credentials remain
in root-owned files mounted through Compose secrets and must never enter the
build context, image, environment committed to Git, or model catalog.
The image runs `validate-model-catalog.mjs` before compiling and fails if the
catalog has an unknown field or a credential-shaped value.

`compose.yml` deliberately requires explicit values for every host-specific
path and identity. Production deploy tooling should pin an image by digest or
image ID, use a unique Compose project for each release, and retain the prior
container until authenticated HTTPS validation succeeds.

Candidate deployments default to a `no` restart policy. Promotion tooling must
set `CHATBOT_RESTART_POLICY=unless-stopped` only for the validated live release.
The state log and generated-media directories must already exist with ownership
that permits uid 1000 to write; Compose is configured not to create them.
