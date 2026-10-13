# Freshdesk MCP Server

[![Build Status](https://github.com/WYRE-AI/freshdesk-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/WYRE-AI/freshdesk-mcp/actions/workflows/release.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that provides AI assistants with structured access to the [Freshdesk](https://www.freshdesk.com) customer support platform — tickets, contacts, companies, agents, groups, the knowledge base, and SLA/business-hours configuration.

> **Note:** This project is maintained by [Wyre Technology](https://github.com/WYRE-AI). It wraps the published [`@wyre-technology/node-freshdesk`](https://github.com/WYRE-AI/node-freshdesk) SDK.

## Quick Start

The primary deployment is through the **WYRE MCP Gateway**, which hosts the containerized server and injects per-request credentials. To run it yourself:

**Claude Code (CLI):**

```bash
claude mcp add freshdesk-mcp \
  -e FRESHDESK_DOMAIN=your-subdomain \
  -e FRESHDESK_API_KEY=your-api-key \
  -- npx -y github:WYRE-AI/freshdesk-mcp
```

`FRESHDESK_DOMAIN` is the part before `.freshdesk.com` (for `https://acme.freshdesk.com` it is `acme`). Find your `FRESHDESK_API_KEY` in the Freshdesk portal under **Profile Settings**.

## Features

- **🔌 MCP Protocol Compliance**: Tools, prompts, and elicitation support
- **🎫 Full Helpdesk Coverage**: Tickets, contacts, companies, agents, groups, solutions, SLA policies, business hours, and canned responses
- **🌳 Decision-Tree Navigation**: Start at `freshdesk_navigate`, enter a domain to reveal its tools, and `freshdesk_back` to return — keeping the tool list small and focused
- **⚠️ Destructive-Action Guardrails**: Irreversible and high-impact tools are clearly flagged and confirmed via elicitation before they run
- **🔒 Secure Authentication**: HTTP Basic Auth with your Freshdesk API key (domain + key)
- **🌐 Dual Transport**: stdio (local) and Streamable HTTP (remote/Docker/gateway)
- **🐳 Docker Ready**: Containerized deployment with HTTP transport and health checks

## Connecting via the Gateway

When `AUTH_MODE=gateway`, every `/mcp` request must include credentials injected by the WYRE MCP Gateway. A request missing either header returns 401 and does not fall back to `FRESHDESK_DOMAIN` or `FRESHDESK_API_KEY` in the process environment.

| Header | Maps to | Description |
|--------|---------|-------------|
| `x-freshdesk-domain` | `FRESHDESK_DOMAIN` | Freshdesk account subdomain |
| `x-freshdesk-api-key` | `FRESHDESK_API_KEY` | Freshdesk API key |

Each request is stateless: the gateway provides the credentials, and the server rebuilds its Freshdesk client for that request only. When `CONDUIT_S2S_SECRET` is set, the request must also include a valid `X-Gateway-S2S` header.

## Configuration

Copy [`.env.example`](.env.example) and set the variables below. The stdio transport reads `FRESHDESK_DOMAIN` and `FRESHDESK_API_KEY` and does not use `CONDUIT_S2S_SECRET`.

| Variable | Description | Default |
|----------|-------------|---------|
| `FRESHDESK_DOMAIN` | Account subdomain (before `.freshdesk.com`). Required for stdio and for HTTP when `AUTH_MODE=env`. Gateway mode does not read it. | — |
| `FRESHDESK_API_KEY` | Freshdesk API key. Required for stdio and for HTTP when `AUTH_MODE=env`. Gateway mode does not read it. | — |
| `MCP_TRANSPORT` | Transport mode (`stdio` or `http`) | `stdio` |
| `AUTH_MODE` | `env` (process environment) or `gateway` (per-request `x-freshdesk-domain` and `x-freshdesk-api-key`, no env fallback). The container image and Compose default to `gateway`. | `env` |
| `CONDUIT_S2S_SECRET` | Required for HTTP. HMAC secret checked against `X-Gateway-S2S` on every `/mcp` request. The process logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `placeholder`, `secret`, `your-s2s-secret`, and similar public example values). Compose will not start when it is unset. Never commit a real value. Generate one with `openssl rand -hex 32`. The value is never logged. | — |
| `MCP_ALLOW_INSECURE_DEV` | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A wider `MCP_HTTP_HOST` (including `0.0.0.0`) is ignored and the override is logged. A known placeholder secret is still rejected. | — |
| `MCP_HTTP_HOST` | Bind address when `MCP_TRANSPORT=http`. Unset binds `127.0.0.1`. A configured `CONDUIT_S2S_SECRET` honors this value (the container image sets `0.0.0.0`). With no secret, the insecure-dev bypass forces `127.0.0.1`. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port | `8080` |
| `LOG_LEVEL` | Log level (`debug`, `info`, `warn`, `error`) | `info` |

`/health` stays unauthenticated and does not read credentials.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`:

```
t=<unix seconds>,v1=<hex hmac-sha256>
```

`v1` is the lowercase hex HMAC-SHA256 of the ASCII message `t=<unix seconds>`, keyed by `CONDUIT_S2S_SECRET`. The timestamp must be within 300 seconds of the server clock. A missing or invalid header returns 401 before any vendor credential is read. The secret is never written to logs or error bodies.

In `AUTH_MODE=gateway`, `/mcp` also requires `x-freshdesk-domain` and `x-freshdesk-api-key`. Those headers are the only credential source for the request. A missing header returns 401. The server does not fall back to `FRESHDESK_DOMAIN` or `FRESHDESK_API_KEY` in the process environment.

```
X-Gateway-S2S: t=1710000000,v1=<hmac-sha256 of "t=1710000000">
x-freshdesk-domain: acme
x-freshdesk-api-key: <api key>
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires a valid `X-Gateway-S2S` header. Vendor credentials then come from `FRESHDESK_DOMAIN` and `FRESHDESK_API_KEY`.

## Tool Overview

The server uses **decision-tree navigation**. At the top level you see only `freshdesk_navigate`, `freshdesk_back`, and `freshdesk_status`. Call `freshdesk_navigate` with a domain to reveal that domain's tools; call `freshdesk_back` to return to the top.

| Domain | Tools |
|--------|-------|
| **tickets** | search, list, get, create, update, reply, add_note, list_conversations, update_conversation, delete\*, delete_conversation\* |
| **contacts** | search, list, get, create, update, autocomplete, make_agent†, restore, send_invite, merge†, soft_delete†, hard_delete\* |
| **companies** | search, list, get, create, update, autocomplete, delete\* |
| **agents** | list, get, me, create, update, delete\* |
| **groups** | list, get, create, update, delete\* |
| **solutions** | categories / folders / articles: list, get, create, update, delete\* |
| **sla-business** | SLA policies (list, create, update), business hours (list, get), canned responses (list_folders, get_folder, list_responses) |

`*` = **Tier A** (irreversible delete) — flagged `⚠ DESTRUCTIVE — IRREVERSIBLE`, requires confirmation.
`†` = **Tier B** (high-impact reversible) — flagged `⚠ HIGH-IMPACT`, requires confirmation.

Read tools (search/list/get/autocomplete/status) carry no warning and are marked read-only.

`freshdesk_status` performs a live connectivity check by calling `agents/me`.

## Docker Deployment

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode the domain and API key arrive on each request as `x-freshdesk-domain` and `x-freshdesk-api-key`. They are not read from the environment.

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  freshdesk-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, publishes `127.0.0.1:8080:8080`, and does not set `FRESHDESK_DOMAIN`, `FRESHDESK_API_KEY`, or `env_file`:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up -d
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `FRESHDESK_DOMAIN` and `FRESHDESK_API_KEY`:

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e FRESHDESK_DOMAIN=your-subdomain \
  -e FRESHDESK_API_KEY=your-api-key \
  -p 127.0.0.1:8080:8080 \
  freshdesk-mcp
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` even when `MCP_HTTP_HOST` is `0.0.0.0`, and logs a warning. A known placeholder secret still refuses to start:

```bash
MCP_ALLOW_INSECURE_DEV=1 npm run start:http
```

See [docker-compose.yml](docker-compose.yml). The build installs `@wyre-technology/node-freshdesk` from GitHub Packages via a
BuildKit npmrc secret (never baked into a layer):

```bash
printf '@wyre-ai:registry=https://npm.pkg.github.com\n@wyre-technology:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$(gh auth token)" > /tmp/.npmrc
docker build --secret id=npmrc,src=/tmp/.npmrc -t freshdesk-mcp .
rm /tmp/.npmrc
```

## Development

```bash
export NODE_AUTH_TOKEN=$(gh auth token)   # to install @wyre-technology/node-freshdesk
npm install
npm run build       # Build the project
npm run dev         # Watch mode
npm run test        # Run tests
npm run lint        # Type-check
npm run clean       # Remove dist/

# HTTP refuses to start until CONDUIT_S2S_SECRET is set
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" npm run start:http

# Local HTTP only, without a service-to-service secret (always binds 127.0.0.1)
MCP_ALLOW_INSECURE_DEV=1 npm run start:http
```

## Testing

```bash
npm test            # Run test suite
npm run test:watch  # Watch mode
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

Apache 2.0 — Copyright WYRE Technology
