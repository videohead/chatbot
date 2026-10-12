<a href="https://chatbot.ai-sdk.dev/demo">
  <img alt="Chatbot" src="app/(chat)/opengraph-image.png">
  <h1 align="center">Chatbot</h1>
</a>

<p align="center">
    Chatbot (formerly AI Chatbot) is a free, open-source template built with Next.js and the AI SDK that helps you quickly build powerful chatbot applications.
</p>

<p align="center">
  <a href="https://chatbot.ai-sdk.dev/docs"><strong>Read Docs</strong></a> ·
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#model-providers"><strong>Model Providers</strong></a> ·
  <a href="#primary-dgx-spark-deployment"><strong>DGX Spark deployment</strong></a> ·
  <a href="#running-locally"><strong>Running locally</strong></a>
</p>
<br/>

## Features

- [Next.js](https://nextjs.org) App Router
  - Advanced routing for seamless navigation and performance
  - React Server Components (RSCs) and Server Actions for server-side rendering and increased performance
- [AI SDK](https://ai-sdk.dev/docs/introduction)
  - Unified API for generating text, structured objects, and tool calls with LLMs
  - Hooks for building dynamic chat and generative user interfaces
  - Supports OpenAI, Anthropic, Google, xAI, and other model providers via AI Gateway
- [shadcn/ui](https://ui.shadcn.com)
  - Styling with [Tailwind CSS](https://tailwindcss.com)
  - Component primitives from [Radix UI](https://radix-ui.com) for accessibility and flexibility
- Data Persistence
  - [Neon Serverless Postgres](https://vercel.com/marketplace/neon) for saving chat history and user data
  - [Vercel Blob](https://vercel.com/storage/blob) for efficient file storage
- [Auth.js](https://authjs.dev)
  - Simple and secure authentication

## Model Providers

This template uses the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) to access multiple AI models through a unified interface. Models are configured in `lib/ai/models.ts` with per-model provider routing. Included models: Mistral, Moonshot, DeepSeek, OpenAI, and xAI.

### AI Gateway Authentication

**For Vercel deployments**: Authentication is handled automatically via OIDC tokens.

**For non-Vercel deployments**: You need to provide an AI Gateway API key by setting the `AI_GATEWAY_API_KEY` environment variable in your `.env.local` file.

With the [AI SDK](https://ai-sdk.dev/docs/introduction), you can also switch to direct LLM providers like [OpenAI](https://openai.com), [Anthropic](https://anthropic.com), [Cohere](https://cohere.com), and [many more](https://ai-sdk.dev/providers/ai-sdk-providers) with just a few lines of code.

## Dependencies

This fork adds two external services that are **required** for the Docker deployment to work:

- [LiteLLM](https://github.com/videohead/litellm) — model routing proxy. All model requests go through `LITELLM_BASE_URL`, authenticated with a client key supplied as a Docker secret.
- [Metis Router](https://github.com/videohead/metis-router) — MCP gateway that exposes host tools (filesystem, shell, controllers) to the chatbot over the shared `metis-network`.

Both services must be running and attached to the `metis-network` Docker network before the chatbot starts. Credentials for models and infrastructure are provided at runtime via Docker secrets and `.env` files; no keys are stored in this repository.

## Primary DGX Spark deployment

This checkout supplies the public chatbot through Traefik and binds Next.js
only to `127.0.0.1:3000`. See [DEPLOYMENT.md](DEPLOYMENT.md) for start,
verification, restart, stop, and image rebuild commands.

## Running locally

You will need to use the environment variables [defined in `.env.example`](.env.example) to run Chatbot. It's recommended you use [Vercel Environment Variables](https://vercel.com/docs/projects/environment-variables) for this, but a `.env` file is all that is necessary.

> Note: You should not commit your `.env` file or it will expose secrets that will allow others to control access to your various AI and authentication provider accounts.

1. Install Vercel CLI: `npm i -g vercel`
2. Link local instance with Vercel and GitHub accounts (creates `.vercel` directory): `vercel link`
3. Download your environment variables: `vercel env pull`

```bash
pnpm install
pnpm db:migrate # Setup database or apply latest database changes
pnpm dev
```

Your app template should now be running on [localhost:3000](http://localhost:3000).

### Docker logging

The Docker Compose service writes live output to Docker logs and also tees stdout/stderr to persistent files under `logs/`, which is bind-mounted into the container at `/app/logs`.

Useful commands:

```bash
docker compose logs -f chatbot
tail -f logs/chatbot-current.log
grep 'litellm\|chat.post\|chat.stream\|runtime' logs/chatbot-current.log
```

Runtime logging is configured with `CHATBOT_LOG_LEVEL=debug` and `CHATBOT_LOG_BODIES=true` in `docker-compose.yml`. Secret-like fields such as cookies, tokens, passwords, and API keys are redacted before structured logs are emitted.

### Local agent stack

The Docker deployment uses two complementary execution paths on the shared `metis-network`:

- Simple model requests and individual MCP operations use `chatbot -> LiteLLM -> Metis`.
- Complex model-broker, MCP, stack-diagnostics, or multiagent work can use `chatbot -> agent-framework-service -> LiteLLM/Metis` through the `delegateToAgentFramework` tool.

The chatbot chat UUID is forwarded as the Agent Framework session ID, preserving harness context across turns. Useful checks are:

```bash
docker compose exec -T chatbot node -e 'fetch("http://agent-framework:8000/ready").then(async response => console.log(response.status, await response.text()))'
curl -fsS http://127.0.0.1:8000/diagnostics | jq
grep 'agent_framework.delegate' logs/chatbot-current.log
```
