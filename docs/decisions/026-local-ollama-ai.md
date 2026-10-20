# 026 — Local Ollama for manual AI assistance

## Status

Accepted for the first implementation in issue #50.

## Context

Career Stack currently runs AI tasks through a Codex account. Local inference is an alternative for people who want to keep job text and search requests on their own computer. An Ollama HTTP endpoint is still a trust boundary: an imported job must never select it, and an application cannot infer from a successful API response that Ollama disabled its cloud features.

## Decision

- Add Ollama as an optional provider for manual `JOB_ANALYSIS` and `SEARCH_DRAFT` only. Resume and application-answer drafting, automatic jobs, and provider fallback remain out of scope.
- Read the endpoint only from administrator configuration (`OLLAMA_BASE_URL`, default `http://127.0.0.1:11434`). Accept only HTTP loopback (`127.0.0.1` or `::1`), port 11434, and the origin root. Reject credentials, path, query, fragment, non-loopback hosts, and redirects.
- Query the fixed `/api/tags` endpoint and let the person select an installed model. Hide model names with cloud suffixes such as `:cloud`, `-cloud`, and `_cloud`. Career Stack never pulls or installs a model.
- Require a deliberate connection action and an explicit confirmation that cloud features are disabled in the Ollama server. Store that confirmation as a user attestation; show that the app cannot verify it.
- Reuse the existing per-operation data preview, explicit start, consent revisions, queue, source freshness checks, cited output validation, history, and cancellation. Never switch silently between Ollama and Codex.
- Keep Ollama usage local and cost-free at the provider level; record token counts only when Ollama reports them. Do not promise quality or speed for any specific hardware, including 8 GB systems.

## Consequences

The initial UI offers separate Codex and local Ollama actions, and Settings provides model discovery and connection management. A disconnected or unavailable Ollama instance does not affect manual editing, job tracking, or Codex. The backend constrains outgoing URLs to loopback and applies bounded requests/responses, but the user remains responsible for the Ollama server's cloud setting.

No schema migration is required: `ai_connections` already stores provider, selected model, capability flags, connection revision, and consent scope.

## Follow-up

Support for resume or answer drafts, automatic Ollama tasks, model recommendations, non-loopback endpoints, process management, and server-side verification of cloud mode require separate design decisions.
