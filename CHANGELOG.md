# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial Freshdesk MCP server wrapping `@wyre-technology/node-freshdesk`.
- Decision-tree navigation (`freshdesk_navigate`, `freshdesk_back`, `freshdesk_status`)
  that reveals a domain's tools on entry and hides them on return.
- Domains and tools:
  - **tickets**: search, list, get, create, update, reply, add_note, list_conversations,
    update_conversation, delete, delete_conversation.
  - **contacts**: search, list, get, create, update, autocomplete, make_agent, restore,
    send_invite, merge, soft_delete, hard_delete.
  - **companies**: search, list, get, create, update, autocomplete, delete.
  - **agents**: list, get, me, create, update, delete.
  - **groups**: list, get, create, update, delete.
  - **solutions**: categories / folders / articles list, get, create, update, delete.
  - **sla-business**: SLA policies (list/create/update), business hours (list/get),
    canned responses (list_folders/get_folder/list_responses).
- Destructive-tool safety: Tier A (irreversible deletes) and Tier B (high-impact
  reversible: soft_delete, merge, make_agent) tools carry warning prefixes and
  `destructiveHint` annotations, with additive elicitation confirmation.
- Dual transport: stdio (local) and Streamable HTTP (gateway), with gateway-mode
  credential injection via `x-freshdesk-domain` / `x-freshdesk-api-key` headers.
- MCP prompts: `ticket-triage`, `contact-lookup`, `sla-breach-check`.

### Fixed
- **The HTTP transport no longer exits on a malformed request (WYREAI-741).** The request
  target was parsed against the client-supplied `Host` header, and a value that does not parse
  (or a target such as `//`) threw inside the request listener before authentication. The
  target is now parsed against a fixed base, so `Host` is no longer consulted, and a target
  that still cannot be parsed gets a `400` JSON response while the server keeps running.

- `/health` liveness endpoint now returns an unconditional `200` instead of gating on
  credentials. The Azure Container Apps liveness probe hits `GET /health` with no
  credentials, so the previous credential gate returned `503` and crash-looped the
  container. Credential state is still reported in the response body
  (`credentials.configured`); the request-scoped credential isolation for `/mcp`
  (AsyncLocalStorage / `runWithCredentials`) is unchanged.
