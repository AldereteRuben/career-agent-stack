# 017 — Codex feasibility for v0.9.0

Status: **account inspection, synthetic exec isolation and four authorized real structured tasks demonstrated on macOS; full release and other platforms remain under validation**. Date: 2026-10-04. Candidate CLI: `codex-cli 0.160.0`.

## Decision

Use the official local `codex app-server` JSON-RPC surface for reading the installed Codex account state and ChatGPT rate-limit snapshots. Inference uses an ephemeral `codex exec` process with the pinned configuration below. Synthetic requests established the absence of advertised tools, personal skill catalogue and project instructions on this macOS installation. Four separately authorized real tasks subsequently passed structured output and account-routing checks. Those limited checks do not certify other operating systems or the entire release.

The account and rate-limit read path works on the installed version without starting login/logout, creating a thread, or running inference. `scripts/ai/codex-capability-probe.mjs` performs `initialize`, `account/read` with `refreshToken: false`, and `account/rateLimits/read`; it emits normalized account types, booleans, and rate-window fields, never raw protocol responses or identity values. Run it with `node scripts/ai/codex-capability-probe.mjs`. It uses the host's existing Codex home for native authentication, strips API-key/base-URL environment overrides from the app-server child, and reports only whether those overrides were present in the parent.

The observed account was a ChatGPT account and the official rate-limit method returned a Codex bucket and a usable snapshot. This proves that status and usage can be inspected through this protocol on this installation; it does not prove quota for a later request, a stable protocol contract, a particular plan entitlement, or compatibility on other operating systems. Rate data remains a timestamped observation and must be displayed as potentially stale, never as a reservation or cost estimate.

## Isolation evidence

The generated v2 schemas for `ThreadStartParams` and `TurnStartParams` say `environments: []` disables **execution-environment access**. It does not disable local execution or local file access. The same schema offers thread sandbox/approval settings, `dynamicTools`, configuration overrides, and workspace roots, but no documented per-thread switch that guarantees all built-in tools, MCP integrations, skills, memory, hooks, and instruction discovery are disabled. An empty `dynamicTools` list would only address caller-supplied dynamic tools. Read-only sandboxing still permits reads; approval policy is not a tool-disable control. The app-server protocol also exposes MCP status/calls, skill and hook discovery, and configuration reads, so their existence cannot be treated as evidence of isolation.

The installed `codex exec --help` confirms these candidate flags:

- `--ignore-user-config`: skips `$CODEX_HOME/config.toml`; its help explicitly says authentication still uses `CODEX_HOME`.
- `--ignore-rules`: skips user and project execpolicy `.rules` files.
- `--ephemeral`: avoids persisting session files.
- `--output-schema`: requests a schema-constrained final response; prompt input can be supplied over stdin.

These flags made `codex exec` a candidate for the initial investigation. Help output alone does not claim that they suppress every tool or MCP server, skill discovery, memory, hooks, personal instruction loading, or provider-side retention. At that stage no inference had been run. The follow-up experiments below establish the narrower tested boundary and compare the effective account and billing route; the flags alone are not a cross-platform guarantee.

### Follow-up: synthetic loopback experiment

`node scripts/ai/codex-isolation-probe.mjs` runs a separate manual experiment on macOS. It starts a temporary HTTP fixture, uses a custom provider with native authentication disabled and fixes every response locally. An OS sandbox denies outbound connections except to that fixture's loopback port. The request is inspected in memory; the report contains counts, flags and known context markers, not the request, instructions, account identifiers or credentials. The official account and configuration directories retain their actual values.

The first candidate combined `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, a temporary working directory, an explicit instruction file, `project_doc_max_bytes=0`, disabled memory generation/use, disabled shell/browser/MCP-plugin-related features and `skip_host_skill_discovery`. That initial combination did not establish the required boundary; the script now contains the corrected configuration described in the next section.

Observed on Codex 0.160.0 / macOS:

- One request reached the fixture, without an authorization header; the fixed JSON response completed.
- The supplied temporary `AGENTS.md` canary did not appear in the request.
- A `request_user_input` tool remained available. It is an interaction tool, not evidence that a file or command tool remained enabled.
- A developer-context item still contained references to the actual home directory and markers for skills, `CODEX_HOME` and memory. The experiment did not establish the exact origin of that context or show that any credential was included.
- Strict configuration rejected the documented `tools.view_image` and `skills.max_context_tokens` candidate keys on this installation; they were removed from the candidate. The matching `view_image` feature flag was accepted.

That initial run exited with **isolation not established**. This was evidence against the initial configuration; the corrected run below passes. No provider inference or subscription quota was used by either loopback experiment. A loopback fixture cannot certify model quality, real subscription routing, provider retention or native Windows/Linux behavior.

### Follow-up: explicit catalogue and tool controls (same CLI version)

The developer-context item was identified as a **27-entry skill catalogue**. The original `skip_host_skill_discovery` switch did not suppress it. An exploratory per-skill disable list worked only when it included the `SKILL.md` file paths as well as folder paths, but that approach is rejected for production: it depends on enumerating mutable user installations and is unnecessary.

Inspection of the installed official binary identified four configuration keys accepted by `--strict-config`:

```toml
skills.include_instructions = false
cloud.skills.enabled = false
tools.experimental_request_user_input.enabled = false
tools.update_plan.enabled = false
```

With these keys and the existing disabled execution/browser/plugin/memory features, `node scripts/ai/codex-isolation-probe.mjs` now reports **`isolated: true`**: one locally simulated request, zero tools, zero catalogue entries, no home path, no temporary project canary, and no authorization header. No skill directories are enumerated, no skill or credential contents are read by this probe, and neither `HOME` nor `CODEX_HOME` is changed. The experimental `skip_host_skill_discovery` flag is no longer required.

`node scripts/ai/codex-isolation-probe.mjs --attempt-command` adds an adversarial fixture response that asks the CLI to call an unadvertised `exec_command`. The command would create a witness file only inside the probe's temporary directory. Codex returned an unsupported-tool response to the fixture; the witness file did not exist. Both model requests still had zero tools and zero personal catalogue/context markers. This checks one concrete unadvertised command path, not every possible CLI vulnerability.

The manual `--app-server` comparison remains available. The earlier app-server candidate with `environments: []`, empty dynamic tools and `mcp_servers={}` still advertised local MCP tools. An empty config table did not clear the inherited MCP configuration. Consequently app-server is used only for account/usage reads, without opening a thread; inference uses `exec --ignore-user-config`.

The executable recipe is retained in the probe and `apps/api/src/ai/codex.ts`. Production uses an absolute trusted CLI path, an owned temporary working directory, `--no-daemon`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--strict-config`, `--skip-git-repo-check`, `--sandbox read-only`, JSONL output, a private output-schema file, and input on stdin. Developer instructions are written to a separate private file. `project_doc_max_bytes=0`, empty extra developer instructions, disabled memory/skills/tools and temporary log/SQLite directories prevent the demonstrated inherited context. No flags or paths originate from browser input.

For actual execution the provider is fixed to `openai`, `forced_login_method="chatgpt"` and the model is fixed to `gpt-6.1-sol` (priority 1 in the official bundled 0.160.0 catalogue). API-key/endpoint/debug environment overrides are absent. Account fingerprint, version and ChatGPT billing route are checked before dispatch and again before returning a result. A changed account discards the result and revokes Career Stack's grant; it does not log out the official CLI. Authoritative sign-out or a change to API billing also revoke the app grant; an unavailable inspection does not. Completed numeric usage is retained when a final result is rejected. The four authorized real task results are recorded in the release validation document.

The adapter never retries a CLI invocation or falls back to a different model or paid API. **The official CLI's internal transport retries are not an application-controlled request count.** Experiments showed that 0.160.0 rejects `model_providers.openai.*` overrides because `openai` is reserved, including a complete replacement provider table. Those rejected keys are not in the production recipe; no alternate provider is created to bypass the restriction. The supervisor's 120-second deadline bounds one invocation. Budget accounting charges a started invocation even if it fails or its result is uncertain, but cannot promise exactly one provider-side request or a particular subscription cost.

Disabling the code-mode host produces one fixed pre-turn notice saying that Code Mode will fail closed. The strict parser recognizes only that exact 0.160.0 notice, once, before `turn.started`. It rejects other errors, all tool events, unexpected protocol events, commentary, duplicate final messages and missing completion. The result must be one schema-valid JSON object and must pass the domain evidence validator; a process exit of zero alone is insufficient.

This recipe is **version-specific**, including keys not yet described in the current configuration reference. Unknown CLI versions fail closed. Only macOS execution is enabled in the adapter until equivalent native isolation and lifecycle checks are available on Linux and Windows. A managed configuration that rejects the required controls or an unexpected protocol event fails the task; it must not trigger a relaxed retry.

### Native cancellation against a local synthetic stream

The optional cancellation probe runs the official pinned CLI through the production `runAiProcess` supervisor. The fixture holds its synthetic SSE response open, then aborts the supervisor after observing the request. The same OS policy denies all outbound network except the fixture port; no account-backed inference is performed.

```sh
cd apps/api
node --import tsx ../../scripts/ai/codex-isolation-probe.mjs --cancel
```

On this macOS host the probe reported one request, no authorization header, zero advertised tools, no personal catalogue/path/canary, and `AI_CANCELLED`. The mock stream closed, the supervisor settled in 6 ms after cancellation, and the observed process group had no remaining live processes or zombies. One native process was observed before cancellation and no descendants were present in this run. This demonstrates cleanup of the actual waiting CLI process; descendant escalation is separately exercised by the synthetic process-supervisor tests and is not inferred from an absent native descendant. Only numeric PID/parent/group/state metadata is inspected in memory; command lines and process environments are neither read nor printed. The script removes its temporary directory after the supervisor settles.

This is a native lifecycle check with a local response, not another real model task, a provider billing measurement, or a claim that server-side work can always be cancelled after dispatch. The four explicitly authorized real tasks remain the entire real-inference validation budget used here.

## Authentication, usage, and policy limits

- `account/read` exposes an account object and `requiresOpenaiAuth`; the documented `refreshToken: false` form reads status without forcing token refresh. The account response does not itself guarantee every auth-mode detail; `account/updated` is the documented source for `authMode` when supplied.
- `account/rateLimits/read` returns rate-window data when available, including percentage, window duration/reset, and an optional backend permission boolean. It is an observation of current account state, not a promise that the next run will be allowed.
- The probe never calls `account/login/start`, `account/login/cancel`, `account/logout`, `thread/start`, `turn/start`, or inference. It does not inspect credential files or print raw app-server stdout/stderr. The official app-server necessarily consults the existing native auth context for account reads; Career Stack must not copy its credentials.
- The local app-server help marks the server experimental. Pin and check the CLI/protocol compatibility before supporting a release; keep unsupported versions disconnected.
- The official app-server reference, rechecked on 2026-10-04, describes continuing support for local/open-source applications, recommends migration to Sign in with ChatGPT, and excludes commercial or hosted services from this authentication route. Career Stack's current scope is separate local installations with noncommercial distribution. Treat its fit with the local-application wording as a scope assessment, not provider endorsement or a promise about future policy. Reassess before hosted or commercial use. The [authentication guide](https://learn.chatgpt.com/docs/auth) also distinguishes subscription login from separately billed API access; this version never substitutes the latter.

## G0 result and next gate

G0 account inspection, rate-limit visibility and the configured synthetic `exec` isolation boundary are **technically demonstrated for Codex 0.160.0 on this macOS host**. Four structured real tasks passed after authorization. Native cancellation passed against the held local synthetic stream. Cancellation during account-backed inference, broader model quality and the remaining release acceptance checks are separate checks. The authentication scope above remains limited to this local noncommercial design. No Linux/Windows compatibility is certified by this probe.

Evidence used: installed `codex --version`, `codex app-server --help`, `codex exec --help`, `codex features list`, and schemas generated by `codex app-server generate-json-schema --experimental --out <temporary-directory>`. These are public CLI/schema observations, not credential-file reads. Temporary local copies are not required to reproduce the investigation.

Official references: [app-server protocol and authentication](https://learn.chatgpt.com/docs/app-server), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). The installed CLI advertises `skip_host_skill_discovery` as under development; its presence alone does not certify isolation. Four explicitly authorized real tasks with fictional inputs passed the structured contracts on macOS; see [release validation](../releases/v0.9.0-validation.md). No Windows/Linux account integration or real-login cancellation is claimed.
