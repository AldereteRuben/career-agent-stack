# 017 — Codex feasibility for v0.9.0

Status: **partial feasibility; inference isolation is a release gate**. Date: 2026-10-04. Candidate CLI: `codex-cli 0.160.0`.

## Decision

Use the official local `codex app-server` JSON-RPC surface as the candidate for reading the installed Codex account state and ChatGPT rate-limit snapshots. Do not enable Codex inference in Career Stack yet: the documented app-server and CLI controls examined for this decision do not establish isolation from all built-in tools, MCP servers, skills, memory, hooks, and personal instructions.

The account and rate-limit read path works on the installed version without starting login/logout, creating a thread, or running inference. `scripts/ai/codex-capability-probe.mjs` performs `initialize`, `account/read` with `refreshToken: false`, and `account/rateLimits/read`; it emits normalized account types, booleans, and rate-window fields, never raw protocol responses or identity values. Run it with `node scripts/ai/codex-capability-probe.mjs`. It uses the host's existing Codex home for native authentication, strips API-key/base-URL environment overrides from the app-server child, and reports only whether those overrides were present in the parent.

The observed account was a ChatGPT account and the official rate-limit method returned a Codex bucket and a usable snapshot. This proves that status and usage can be inspected through this protocol on this installation; it does not prove quota for a later request, a stable protocol contract, a particular plan entitlement, or compatibility on other operating systems. Rate data remains a timestamped observation and must be displayed as potentially stale, never as a reservation or cost estimate.

## Isolation evidence

The generated v2 schemas for `ThreadStartParams` and `TurnStartParams` say `environments: []` disables **execution-environment access**. It does not disable local execution or local file access. The same schema offers thread sandbox/approval settings, `dynamicTools`, configuration overrides, and workspace roots, but no documented per-thread switch that guarantees all built-in tools, MCP integrations, skills, memory, hooks, and instruction discovery are disabled. An empty `dynamicTools` list would only address caller-supplied dynamic tools. Read-only sandboxing still permits reads; approval policy is not a tool-disable control. The app-server protocol also exposes MCP status/calls, skill and hook discovery, and configuration reads, so their existence cannot be treated as evidence of isolation.

The installed `codex exec --help` confirms these candidate flags:

- `--ignore-user-config`: skips `$CODEX_HOME/config.toml`; its help explicitly says authentication still uses `CODEX_HOME`.
- `--ignore-rules`: skips user and project execpolicy `.rules` files.
- `--ephemeral`: avoids persisting session files.
- `--output-schema`: requests a schema-constrained final response; prompt input can be supplied over stdin.

These flags make `codex exec` a possible transport to investigate if the app-server isolation path is rejected. Help output does not claim that they suppress every tool or MCP server, skill discovery, memory, hooks, personal instruction loading, or provider-side retention. No inference was run, so the behavior is unverified. Do not treat the flag combination as satisfying G0 until an authorized synthetic test proves the complete boundary on each supported OS. Pairing `exec` for inference with app-server for usage would also need to prove both surfaces use the same effective account and billing route.

### Follow-up: synthetic loopback experiment

`node scripts/ai/codex-isolation-probe.mjs` runs a separate manual experiment on macOS. It starts a temporary HTTP fixture, uses a custom provider with native authentication disabled and fixes every response locally. An OS sandbox denies outbound connections except to that fixture's loopback port. The request is inspected in memory; the report contains counts, flags and known context markers, not the request, instructions, account identifiers or credentials. The official account and configuration directories retain their actual values.

The candidate combines `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, a temporary working directory, an explicit instruction file, `project_doc_max_bytes=0`, disabled memory generation/use, disabled shell/browser/MCP-plugin-related features and `skip_host_skill_discovery`. Exact candidate flags are in the script. It does not establish a supported production recipe.

Observed on Codex 0.160.0 / macOS:

- One request reached the fixture, without an authorization header; the fixed JSON response completed.
- The supplied temporary `AGENTS.md` canary did not appear in the request.
- A `request_user_input` tool remained available. It is an interaction tool, not evidence that a file or command tool remained enabled.
- A developer-context item still contained references to the actual home directory and markers for skills, `CODEX_HOME` and memory. The experiment did not establish the exact origin of that context or show that any credential was included.
- Strict configuration rejected the documented `tools.view_image` and `skills.max_context_tokens` candidate keys on this installation; they were removed from the candidate. The matching `view_image` feature flag was accepted.

The diagnostic therefore exits with **isolation not established**. This is concrete evidence against this candidate configuration, not proof that every Codex integration is impossible. No provider inference or subscription quota was used by this experiment. A loopback fixture cannot certify model quality, real subscription routing, provider retention or native Windows/Linux behavior.

## Authentication, usage, and policy limits

- `account/read` exposes an account object and `requiresOpenaiAuth`; the documented `refreshToken: false` form reads status without forcing token refresh. The account response does not itself guarantee every auth-mode detail; `account/updated` is the documented source for `authMode` when supplied.
- `account/rateLimits/read` returns rate-window data when available, including percentage, window duration/reset, and an optional backend permission boolean. It is an observation of current account state, not a promise that the next run will be allowed.
- The probe never calls `account/login/start`, `account/login/cancel`, `account/logout`, `thread/start`, `turn/start`, or inference. It does not inspect credential files or print raw app-server stdout/stderr. The official app-server necessarily consults the existing native auth context for account reads; Career Stack must not copy its credentials.
- The local app-server help marks the server experimental. Pin and check the CLI/protocol compatibility before supporting a release; keep unsupported versions disconnected.
- The official app-server reference describes continuing support for local/open-source applications and directs commercial or hosted products to Sign in with ChatGPT. Career Stack's agreed scope is separate local installations with noncommercial distribution, so the current design fits the local application case described there. This is a scope assessment, not a provider endorsement. Reassess the authentication route if hosting or commercial use is introduced; no such scope change is part of v0.9.0.

## G0 result and next gate

G0 account inspection and rate-limit visibility are **technically demonstrated for Codex 0.160.0 on this host**. G0 inference isolation is **not resolved**. Keep the adapter's inference capability disabled until a synthetic, authorized run demonstrates that only supplied task data reaches the model, every tool/MCP/skill/memory/hook/instruction source is absent, and cancellation works. The authentication scope above remains limited to this local noncommercial design. No OS compatibility is certified by this probe.

Evidence used: installed `codex --version`, `codex app-server --help`, `codex exec --help`, `codex features list`, and schemas generated by `codex app-server generate-json-schema --experimental --out <temporary-directory>`. These are public CLI/schema observations, not credential-file reads. Temporary local copies are not required to reproduce the investigation.

Official references: [app-server protocol and authentication](https://learn.chatgpt.com/docs/app-server), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). The installed CLI advertises `skip_host_skill_discovery` as under development; its presence alone does not certify isolation. No successful real inference or Windows/Linux account integration is claimed.
