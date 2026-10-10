# 020 — Deleting data and uninstalling

Status: **proposed** (issue [#25](https://github.com/AldereteRuben/career-agent-stack/issues/25)). Date: 2026-10-10.

## Context

[Implementation brief](../implementation-brief.md) §19 ("Deletion and portability") requires deletion to cover live tables, files, caches, temporary documents, queued payloads, tokens, sessions and diagnostics, and to stop active work first. It also requires the documentation not to claim erasure from historical backups or from employers. What exists today, checked in the code:

| Data | Where it lives | Can it be deleted today? |
|---|---|---|
| Workspace records (profile, facts, answers, jobs, searches, applications, AI runs, assisted attempts, events) | PostgreSQL database `career_<id>`, owned by the role `career_<id>` | Only the AI history (`POST /api/v1/ai/history/clear`). The `deletion_jobs` table exists in the schema but nothing uses it. |
| Search caches (`search_query_cache`, `job_search_provider_cache`, `search_provider_budget`) | Same database, **not** scoped to a workspace | No. They hold public job payloads keyed by a hash of the query. |
| Generated documents | `FILES_LOCAL_PATH` (default `data/files`) | No |
| Backups made from Settings | `data/backups/<id>/`, each with its archive, `.sha256` and key file | No; they are never removed |
| Backups made with `pnpm run backup` | `backups/` by default: archives and **one** key file per installation key | No |
| Sign-in token, run records, logs | `data/setup-token`, `data/run/`, `data/logs/`, `data/postgres.log` | No |
| Configuration and keys | `.env` (and `.env.pending` during a first run) | Documentation only says **not** to delete `.env` |
| Session | Stateless signed cookie (`APP_SESSION_SECRET`), valid for 14 days, carrying the workspace id | Signing out clears the cookie in that browser only |
| Restored installations | Their own folder, `.env` and database `career_<id>` (`scripts/restore.mjs`) | No |

Facts that shape the design:

- Bootstrap marks the role and the database it creates with a comment, `career-agent-stack install <CAREER_INSTALL_ID>` (`scripts/bootstrap.mjs`). This lets a script prove that a database belongs to this installation before dropping it.
- The Docker database keeps its data in the `career-postgres` volume of the compose project. Every installation that uses that same database server (a restored installation, for example) has its own database in that volume, so removing the volume can delete other installations' data.
- The API creates or loads the single workspace when it starts, and keeps its id in memory.
- Everything outside the installation is out of reach: backups the person downloaded, files sent to employers, the Codex or Claude account and its local session, and the Playwright browser cache, which holds no personal data.

## Decision

There are four separate operations, each with its own entry point and its own tests.

### 1. Uninstall: `pnpm run uninstall`

This is a script, not only a guide. Dropping a database by hand on a shared PostgreSQL server is the riskiest step, and the script can check ownership before acting. A guide in Spanish and English explains the script and the manual steps it does not cover. It works on the configuration selected like the other scripts (`.env`, or `CAREER_ENV_FILE` for a restored installation).

- **It shows the plan by default and changes nothing.** It lists exactly what it would delete, with sizes and paths, and what it will not touch.
- **Deleting needs `--confirm <CAREER_INSTALL_ID>`.** The id must match the selected `.env`, so a command copied from another installation cannot delete this one.
- **It refuses while the app is running.** If the launcher's run records show live services, it asks for `pnpm run stop` first. It does not stop them itself.
- **It proves ownership before dropping anything.** The database named in `DATABASE_URL` and its role must both carry the comment `career-agent-stack install <id>` with this installation's id. Otherwise it stops and touches nothing. Dropping the role needs the administrator connection (`CAREER_ADMIN_DATABASE_URL`), as bootstrap does.
- **Docker:** it drops this installation's database and role inside the shared server, like on a native server. It never removes the `career-postgres` volume; the guide explains how to check that no other database is left in it before removing it.
- **Folders:** it deletes `FILES_LOCAL_PATH` and `DATA_LOCAL_PATH` (including `data/backups`) only after checking the following, and refuses otherwise:
  - each path resolves to a real folder that is neither the checkout itself, an ancestor of it, the home folder nor a filesystem root;
  - symbolic links are not followed out of those folders.
- **Backups in `backups/` are kept by default.** They are what someone may want to keep after uninstalling, and they are useless without their key file. `--include-backups` deletes them together with their key files. Without it, the script says where they are and that each one needs its key file to be restored.
- **Order:** database, then role, then documents and data, then backups (only if asked), and finally `.env` and `.env.pending`. `.env` is deleted last because it identifies the installation: if anything fails, running the script again resumes from the step that failed. Every step skips what is already gone.
- **What it never touches:** the checkout's code and `node_modules` (the guide says to delete the folder), the PostgreSQL server itself, the Playwright browser cache, the Codex or Claude configuration, and anything outside the paths above.
- **Output** names paths and counts, never contents, and every message is in Spanish and English.

### 2. Delete all data from the app

Settings gets a "Delete all my data" action. It leaves the installation working and empty, as on the first day. It does not uninstall anything.

- **Strong confirmation:** the person types a phrase shown on screen (Spanish or English). The action is explained first: what is deleted, and what the app cannot delete (downloaded backups, data already sent to employers, the AI provider's own history).
- **It stops work first.** Before deleting, it cancels running searches, AI runs and assisted browsers. It refuses while a backup is being written.
- **One database transaction** deletes every row of the workspace in every table, plus the unscoped search caches and budgets. The workspace row itself stays, so its id, and the `deletion_jobs` record that tracks the operation, survive. `deletion_jobs` holds only an id, a status and timestamps: no personal data.
- **Files:** after the transaction commits, it deletes the contents of `FILES_LOCAL_PATH`, `data/backups/` and `data/logs/`. A failure here is recorded in `deletion_jobs` and retried on the next start, so files cannot outlive their records silently.
- **Sessions:** the workspace gets a session generation number, carried in the cookie and checked on every request. Deleting increments it, so every existing cookie stops working, in every browser. A new single-use sign-in token is written, and the person signs in again into the empty workspace.
- **Proof:** tests count the rows of every table for that workspace after deletion (zero), check the files folder is empty, and check that a second workspace in the same test database is untouched. The test reads the table list from the schema, so a table added later is covered automatically.

### 3. Delete single items

An application, a job or a generated PDF can be deleted where the interface shows it, with a confirmation. Deleting an item removes its rows, including its events and versions, and its files, in the same way as point 2, but limited to that item. Each one is a small task once point 2 exists, and these tasks can be opened to contributors.

### 4. Retention of backups kept in the installation

- **Off by default.** The app keeps every backup until the person chooses a policy; the project does not invent a period.
- **The policy is visible and chosen in Settings:** keep the last N backups made from Settings, for example. The policy and the next deletion are shown next to the backups.
- **Unit of deletion:** a backup made from Settings is its folder, `data/backups/<id>/` (archive, `.sha256` and key file), deleted together.
- **Backups made with `pnpm run backup`** share one key file per installation key, and that file is also needed for future backups. Retention never deletes it. Retention for `backups/` stays manual and documented, with `pnpm run uninstall --include-backups` as the way to remove everything.
- **Backups outside the installation** (downloaded or copied elsewhere) are never touched, and the app says so.

## Implementation plan

1. **T1 — Uninstall** (maintainer, 🔒): `pnpm run uninstall` and the guide in Spanish and English, linked from both READMEs. Tests use disposable databases and folders: plan without changes; wrong or missing `--confirm`; a database or role with another comment or no comment; services running; refused paths; resuming after a failure in each step; and `--include-backups`. Then a manual run on a disposable installation.
2. **T2 — Delete all data from the app** (maintainer, 🔒): the API with the session generation, the Settings interface (Spanish and English, keyboard, mobile), and the proof tests in point 2.
3. **T3 — Delete single items**: application, job and PDF, one pull request each, after T2. Open to contributors.
4. **T4 — Backup retention**: the policy in Settings, with tests on fictional backups showing that only expired folders are deleted, unexpired ones stay, and nothing outside `data/backups/` is touched.

## Consequences

- A person can leave without traces in the installation, and can start over without reinstalling.
- `.env` deletion moves from "never" to "only through `pnpm run uninstall`". The existing warning against deleting it to fix a problem stays.
- Every new table must be scoped to the workspace, or added to the list of caches cleared in point 2. The proof test fails otherwise.
- Sessions gain one database read per request, cached in memory and refreshed when the generation changes.

## Out of scope

Erasure from backups that were downloaded or copied elsewhere, from employers, or from an AI provider's history. Deleting the PostgreSQL server, the Docker volume or the Playwright browsers. Multi-workspace installations. Exporting data, which already exists.
