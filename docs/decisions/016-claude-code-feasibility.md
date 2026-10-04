# 016 — Claude Code feasibility (v0.9.0 T00)

Status: proposed, T00 evidence. Date: 2026-10-04. Binary inspected: Claude Code `2.1.289` on macOS. No inference was run, no login or setting was changed, the probe did not directly read credential files or query the keychain; credential lookup remains inside the official CLI.

## Summary

A Claude Code adapter is **technically feasible** with the official, unmodified binary: headless JSON and schema-validated output exist, account state is readable without inference, and customization can be switched off per run without editing global files. Two limits shape the design:

1. **`--bare` cannot be used.** It is the documented isolation mode for scripts, but it never reads the subscription login. Isolation must instead combine `--safe-mode`, `--restricted`, `--tools ""`, MCP and settings flags, and be **verified at run time** from the `system/init` event.
2. **No subscription quota can be read before running.** Plan usage windows exist only inside a session (status line data, `rate_limit_event` in the stream, the interactive `/usage` screen). The adapter must report `usageWindows: false` and show at most the last limit status observed during a task.

There is one **non-technical blocker** before Career Stack presents Claude Code subscription use as *supported*: the terms do not clearly cover an application that drives the user's own Claude Code programmatically with subscription credentials. See [Terms](#terms-and-the-blocker). This is a product/legal decision for the maintainer, not something the probe can settle.

## Evidence: commands and flags

From `claude --help`, `claude auth status --help`, `claude auth login --help` (2.1.289) and the official [CLI reference](https://code.claude.com/docs/en/cli-reference), [headless guide](https://code.claude.com/docs/en/headless), [authentication](https://code.claude.com/docs/en/authentication), [permissions](https://code.claude.com/docs/en/permissions), [environment variables](https://code.claude.com/docs/en/env-vars), [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), [status line](https://code.claude.com/docs/en/statusline) and [costs](https://code.claude.com/docs/en/costs).

### Account state (no inference)

| Command | Behaviour |
| --- | --- |
| `claude auth status --json` | JSON is the default. Exit 0 if logged in, 1 if not. Fields seen: `loggedIn`, `authMethod`, `apiProvider`, `analyticsDisabled`, `projectsDirectory`, `configDirectory`, `email`, `orgId`, `orgName`, `subscriptionType`. |
| `authMethod` (documented values) | `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper`, `third_party`. Account-specific values are deliberately omitted from this report. |
| `claude auth login [--claudeai\|--console\|--sso]` | Official browser flow. `--console` selects API-usage billing instead of a subscription. |
| `claude auth logout` | Signs the binary out. Affects every use of Claude Code on that machine and config directory, not just Career Stack. |

`email`, `orgId`, `orgName` and the two directories are personal or local data. The adapter keeps only booleans and the enum fields; it never logs or stores the raw output.

**Precedence matters for billing.** In `-p` mode `ANTHROPIC_API_KEY` is always used when present, and `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN` and Anthropic profiles all outrank the subscription login. A stray variable silently switches the account and billing route. The adapter must launch with an allowlisted environment and run `auth status` with that same environment and the same `CLAUDE_CONFIG_DIR`.

### Headless execution

| Need | Flag / mechanism | Notes |
| --- | --- | --- |
| Non-interactive | `-p` / `--print` | Prompt can come from stdin (10 MB cap), keeping personal data out of the process list. Exit 0 / non-zero; failures inside the run (e.g. missing auth) are reported as the result on stdout. |
| Result envelope | `--output-format json` or `stream-json` (with `--verbose`) | JSON has `result`, `session_id`, `is_error`, `subtype`, `usage`, `total_cost_usd`, `permission_denials`. |
| Schema output | `--json-schema '<schema>'` | Validated output in `structured_output`. Invalid schema exits with an error (since 2.1.205). `format` is an annotation only, not enforced. |
| Session metadata | `system/init` event (`stream-json`) | Reports model, `tools`, `mcp_servers`, `mcp_server_errors`, `plugins`, `plugin_errors`, `apiKeySource`, `permissionMode`, `capabilities`. This is the run-time proof of isolation and effective credential. |
| Limit status during a run | `rate_limit_event` (`stream-json`) | `status` `allowed` / `allowed_warning` / `rejected`, optional `resetsAt`, `utilization`, `errorCode: credits_required`. Only emitted when a limit is met; not a quota reading. |
| Retries | `system/api_retry` event | `error` category includes `rate_limit`, `authentication_failed`, `billing_error`. |
| No transcript | `--no-session-persistence` (print only) or `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` | |
| Turn / spend cap | `--max-turns`, `--max-budget-usd` | Budget is a client-side estimate at list price; meaningless as a subscription quota. |
| Cancellation | SIGINT ends the turn; SIGTERM exits 143 with no result and kills child Bash trees | Windows behaviour must be tested; the Agent SDK `interrupt()` is the documented alternative. |

### Isolation while keeping the subscription login

| Flag | What it removes | Keeps auth? |
| --- | --- | --- |
| `--bare` | Hooks, skills, plugins, MCP, memory, CLAUDE.md | **No.** "OAuth and keychain are never read"; only `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`. Unusable for subscription users. |
| `--safe-mode` | CLAUDE.md, skills, plugins, hooks, MCP servers, custom commands/agents, output styles, workflows, status line, LSP, auto memory | **Yes** ("Authentication, model selection, built-in tools … work normally"). Managed policy hooks still run. |
| `--restricted` (≥ 2.1.248) | Code-running tools and WebFetch unless named in `--tools`; ignores user/project/local settings; confines file tools to working dirs; refuses `bypassPermissions` | Not stated as affecting auth; must be verified. Managed settings and `--settings` still apply. |
| `--tools ""` | All built-in tools | `EndConversation` is only removed when no MCP tools remain. Does not affect MCP tools. |
| `--strict-mcp-config` (no `--mcp-config`) + `--disallowedTools "mcp__*"` | Every configured MCP server and MCP tool | |
| `--setting-sources` | Limits user/project/local settings | Whether an empty list is accepted is unverified; `--restricted` covers this. |
| `--settings '{"disableAllHooks": true}'` | Non-managed hooks | Documented as the per-run way to disable hooks. |
| `--disable-slash-commands` | Skills and commands | |
| `--system-prompt` | Replaces the default prompt, which embeds cwd, platform, git status and tool guidance | |
| `--permission-mode dontAsk` + `--permission-prompts none` (≥ 2.1.259) | Denies anything that would prompt | `--allowedTools` only pre-approves; it never restricts. |
| Env: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1` | Belt-and-braces for memory, updates and telemetry | |
| Empty temporary cwd | `-p` skips the workspace trust dialog and would otherwise run a folder's project hooks and connect its `.mcp.json` servers | |

Proposed invocation for T04 (argument array, no shell; data on stdin):

```text
claude -p --output-format stream-json --verbose --json-schema <schema>
  --safe-mode --restricted --tools "" --strict-mcp-config --disallowedTools "mcp__*"
  --settings '{"disableAllHooks":true}' --disable-slash-commands
  --system-prompt <versioned instructions> --no-session-persistence
  --permission-mode dontAsk --permission-prompts none --model <validated alias> --max-turns <n>
```

The adapter must reject the run when `system/init` shows any tool other than the expected set, any MCP server or plugin, or an `apiKeySource` that differs from the method shown to the person. Managed (organization) settings can still add hooks or force a login method; the adapter cannot disable them and must not try.

## Quota and usage

No documented command returns plan usage without starting a session. `/usage` is an interactive screen whose figures are approximate and local; sending it as a `-p` prompt returns assistant text, not a stable schema, and was not tested. The status line `rate_limits.five_hour` / `seven_day` fields appear only for Pro/Max after the first API response inside a session. Therefore:

- `AiCapabilities.usageWindows = false` for Claude Code.
- Show "Account limit reached, resets at …" only from a `rate_limit_event` with `status: rejected` or an `api_retry` with `error: rate_limit`, labelled as observed during the last task.
- Do not present `total_cost_usd` as subscription consumption.

## Terms and the blocker

The [official terms guidance](https://code.claude.com/docs/en/legal-and-compliance) distinguishes hosting the unmodified binary with individual authentication from third-party applications relaying Claude.ai credentials or subscription-backed requests. Hosting also has applicable commercial conditions. These provisions do not clearly settle Career Stack's proposed background automation.

G0 remains open for subscription-backed integration. Obtain provider clarification or an explicit scope decision; an experimental label does not itself resolve this issue. The coordinator has asked whether to proceed with Codex first or choose a separately billed Claude API integration.

Until resolved, keep Claude execution disabled. Keep authentication in the official program and never collect credentials. Disconnecting Career Stack must only revoke its own authorization; it must not log the person out of their other tools. Exact embedded-login UX remains undecided.

## Capability probe

`node scripts/ai/claude-capability-probe.mjs` prints a normalized JSON report and exits 0 (binary found) or 2 (not found). It runs only `--version`, `--help`, `auth status --help` and `auth status --json`, with `execFile` (no shell), a 15 s timeout, an empty temporary cwd and an allowlisted environment. It prints:

- `binary.found`, `binary.version`;
- `flags.*` — whether each needed option is *defined* in `--help` (mentions inside other descriptions are ignored), `choices` for output format and permission options, and `bareExcludesOAuth` read from the `--bare` help text;
- `auth.*` — `loggedIn`, `method`, `subscriptionBilling`, `separateApiBilling`, `cloudProvider`, `subscriptionTier`, `identityPresent`, `organizationPresent` (booleans only, no values);
- `parentEnvOverrides.*` — which billing-changing variables exist in the caller's environment (names only);
- `derived.*` — flag-presence summaries, explicitly not proof of behaviour.

It does not estimate quota, does not log in or out, and never prints email, organization, ids or paths. Unknown `authMethod` values become `unknown`. Pure functions are exported for T04 tests.

Verified here: a run against the real 2.1.289 binary (all flags present, `bareExcludesOAuth: true`, `structuredOutputFlags: true`, no personal values in the output), and synthetic checks with a fake binary covering an older help text, a description that mentions a flag it does not define, a logged-out API-key status with an email (not leaked), malformed JSON, an unknown auth method, environment stripping, and a missing binary. ESLint passes.

## Still unproven (requires opt-in real runs)

Each item needs an authorized test account, synthetic data and a recorded budget:

- That `--safe-mode --restricted --tools ""` with subscription auth starts and reports the expected `apiKeySource`, empty `tools` (apart from any unavoidable built-in) and no MCP servers or plugins.
- That `--json-schema` works with `--tools ""` and a small `--max-turns`, and its failure shape when the model cannot satisfy the schema.
- What context reaches the model beyond the replaced system prompt and stdin (system reminders, managed policy additions).
- `auth status` versus the run's effective credential when an `apiKeyHelper` exists only in user settings that `--restricted` ignores.
- Expired login: `auth status` result and the in-run error (`Login expired`).
- Cancellation, child process cleanup and exit codes on Windows and Linux; credential lookup with the allowlisted environment on Windows (`USERPROFILE`) and Linux.
- Behaviour across binary updates: pin a tested range and re-run the probe at startup; treat a missing flag as "unsupported version".

Operating-system matrix: macOS help/status probe only. Windows native, Linux and WSL are pending and must not be inferred from macOS.
