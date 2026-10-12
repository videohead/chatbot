# Production web image

This directory builds the immutable Next.js `web` image used by the canonical
root [`compose.yaml`](../../compose.yaml). It is image-build implementation,
not a second deployment entrypoint.

The build context must contain a generated `model-catalog.json`. Git ignores
that runtime inventory. The validator accepts metadata fields only and rejects
credential-shaped values before the Next.js build starts.

At runtime, the entrypoint reads the web service's required Compose secret
files, constructs the PostgreSQL connection string in memory, and drops from
root to the unprivileged Node user. Source code and `node_modules` are not
mounted into production.

Builds are performed with plain Docker from this directory; release identity
is carried in the image tag referenced by the root
[`compose.yaml`](../../compose.yaml), which is the single source of truth for
the deployed release. Compose project and service names stay stable.
