# 020 — Deleting data and uninstalling

Status: **proposed** (issue [#25](https://github.com/AldereteRuben/career-agent-stack/issues/25)). Date: 2026-10-10.

## Context

[Implementation brief](../implementation-brief.md) §19 ("Deletion and portability") requires deletion to cover live tables, files, caches, temporary documents, queued payloads, tokens, sessions and diagnostics, and to stop active work first. It also requires the documentation not to claim erasure from historical backups or from employers. What exists today, checked in the code:

| Data | Where it lives | Can it be deleted today? |
|---|---|---|
| Workspace records (profile, facts, answers, jobs, searches, applications, AI runs, assisted attempts, events) | PostgreSQL database named in `DATABASE_URL` | Only the AI history (`POST /api/v1/ai/history/clear`) |
| `deletion_jobs` | Same database: `id`, `workspace_id`, `status`, `requested_at`, `completed_at` | Defined in the schema; nothing uses it |
| Search caches without a workspace | `search_query_cache` (results of a public provider query, keyed by provider and a hash of the query) and `job_search_provider_cache` (a provider's public feed) | No |
| Provider request counters | `search_provider_budget`: provider, day and count, without a workspace and without job or query data | No (holds no personal data) |
| Generated documents | `FILES_LOCAL_PATH` (default `data/files`) | No |
| Backups made from Settings | `data/backups/<id>/`: `career-backup-….tar.age`, its `.sha256`, and the key file in `keys/` | No; they are never removed |
| Backups made with `pnpm run backup` | `backups/` by default: `.tar.age` archives and **one** key file per installation key, reused by every later backup | No |
| Sign-in token, run records, logs | `setup-token`, `run/` and `logs/` in `DATA_LOCAL_PATH`; `postgres.log` there only when the launcher started a Homebrew server | No |
| Prompts sent to Codex | A temporary folder `career-codex-task-*` in the system's temporary directory, removed when each run ends (`apps/api/src/ai/codex.ts`). The name does not say which installation created it. | Left behind if the API process is killed during a run |
| Configuration and keys | `.env` (and `.env.pending` during a first run) | The documentation only says **not** to delete `.env` |
| Session | Stateless signed cookie (`APP_SESSION_SECRET`), valid for 14 days, carrying the workspace id; only its signature and expiry are checked | Signing out clears the cookie in that browser only |
| Restored installations | Their own folder and `.env`, a new database `career_restore_<UTC time>` (or `--database`) **owned by the original installation's role**, not marked by bootstrap (`scripts/restore.mjs`) | No |

Facts that shape the design:

- Bootstrap marks the role and database it **creates** (`CAREER_DATABASE_MODE=created`) with the comment `career-agent-stack install <CAREER_INSTALL_ID>` (`scripts/bootstrap.mjs`). With a database someone provided (`CAREER_DATABASE_MODE=provided`) nothing is marked.
- The Docker database keeps its data in the `career-postgres` volume of the compose project. Every installation that uses that same database server (a restored installation, for example) has its own database in that volume, so removing the volume can delete other installations' data.
- Several foreign keys inside a workspace do not cascade: applications to jobs and documents, document versions to profile versions and job snapshots, `llm_usage` to AI runs, and AI runs to searches, policies and consents (that last one is `RESTRICT`). Deleting the workspace's rows needs an explicit order.
- The API creates or loads the single workspace when it starts, and keeps its id in memory.
- Everything outside the installation is out of reach: backups the person downloaded, files sent to employers, the Codex or Claude account and its local session, and the Playwright browser cache, which holds no personal data.

## Decision

There are four separate operations, each with its own entry point and its own tests.

### 1. Uninstall: `pnpm run uninstall`

This is a script, not only a guide. Dropping a database by hand on a shared PostgreSQL server is the riskiest step, and the script can check ownership before acting. A guide in Spanish and English explains the script and the manual steps it does not cover. It works on the configuration selected like the other scripts (`.env`, or `CAREER_ENV_FILE` for a restored installation). The **installation folder** is the folder of that `.env`: the checkout, or the target folder of a restore.

**Safety checks before anything is deleted**

- **It shows the plan by default and changes nothing.** It lists exactly what it would delete, with sizes and paths, and what it will not touch.
- **Deleting needs `--confirm <id>`.** The id must match the selected `.env` (its `CAREER_INSTALL_ID`, or `CAREER_RESTORE_ID` for a restored installation), so a command copied from another installation cannot delete this one.
- **It refuses while the app is running.** If the run records show live services, it asks for `pnpm run stop` first. It does not stop them itself.
- **Ownership of the database:**
  - **Installations made by bootstrap** (`created`): the database named in `DATABASE_URL` and its role must both carry `career-agent-stack install <id>` with this id.
  - **Restored installations:** T1 changes `restore.mjs` to mark the database it creates with `career-agent-stack restore <restore id>` and to write `CAREER_RESTORE_ID` into the restored `.env`. The script drops that database only. **It never drops the role**, which belongs to the original installation.
  - **A provided database, or a restore made before this change:** the database has no mark, so the script refuses the database steps. The guide gives the manual steps.
  - Anything that does not match stops the script before it changes anything.
- **Dropping the role** uses the administrator connection (`CAREER_ADMIN_DATABASE_URL`), as bootstrap does, and never `DROP OWNED`. If PostgreSQL reports that the role still owns objects or holds privileges in another database, the script stops, lists them and leaves the role in place.
- **Docker:** it drops this installation's database and role inside the shared server, like on a native server. It never removes the `career-postgres` volume; the guide explains how to check that no other database is left in it before removing it.

**Which folders it may delete**

- `FILES_LOCAL_PATH` and `DATA_LOCAL_PATH` are deleted only if each one:
  - resolves inside the installation folder, and is neither the folder itself nor a reserved path inside it: `.git`, `node_modules`, `apps`, `packages`, `scripts`, `docs`, `.github` or `backups`;
  - does not contain a reserved path or the backup folder, and is not inside the backup folder (`FILES_LOCAL_PATH` may be inside `DATA_LOCAL_PATH`);
  - has no symbolic link anywhere in its path, the configured path itself included (each component is checked with `lstat`), and the deletion never follows a link out of it.
- A path that fails any check is left in place and listed with the reason. The guide explains how to remove it by hand.

**Keeping backups**

- **Backups in the backup folder** (`backups/` by default) **are kept by default.** They are what someone may want to keep after uninstalling, and they are useless without their key file. `--include-backups` deletes them together with their key files. Without it, the script says where they are and that each one needs its key file to be restored.

**Order and resuming**

- **Order:** database, then role, then documents and data (including `data/backups`), then the backup folder (only if asked), then `.env.pending` and `.env`, and finally the progress file.
- **Resuming after a failure:**
  - Once every check has passed, and before the first deletion, the script writes a private progress file (`.uninstall-progress.json`, mode `0600`) next to the `.env`. It records the id, the database, role and folder names it verified, and each step as it completes.
  - On a later run with the same id, a step marked done is skipped. An object recorded as verified that no longer exists counts as done, and the checks are repeated for everything still present.
  - Without a progress file, a missing database or role is never assumed to be ours. The script says so and stops.
  - **Finishing without `.env`:** the progress file stays in the installation folder until it is the only thing left, and it records the id and that every earlier step is done. If deleting it fails after `.env` is gone, a later run finds it in the same folder (the checkout, or the folder of the `CAREER_ENV_FILE` path, which still exists), checks that `--confirm` matches the id it records, and deletes it. The progress file holds names and ids, never keys or passwords.
  - **On Windows**, where `0600` does not restrict access, the progress file gets the same user-only ACL as the decryption folder of ADR 019 (`restrictToCurrentUser`), as the rest of #98 will do for the other private files.
- **`postgres.log`** is inside `DATA_LOCAL_PATH` when the launcher started a Homebrew server, so it is deleted with that folder. The server itself stays installed and running. Before deleting `run/`, the script prints the command that stops it, taken from the launcher's record, and notes that the server keeps writing to the deleted log until it restarts.
- **What it never touches:** the checkout's code and `node_modules` (the guide says to delete the folder), the PostgreSQL server (its installation and its data), the Playwright browser cache, the Codex or Claude configuration, and anything outside the paths above.
- **Output** names paths and counts, never contents, and every message is in Spanish and English.

### 2. Delete all data from the app

Settings gets a "Delete all my data" action. It leaves the installation working and empty, as on the first day. It does not uninstall anything.

- **Strong confirmation:** the person types a phrase shown on screen (Spanish or English). The action is explained first: what is deleted, and what the app cannot delete (downloaded backups, data already sent to employers, the AI provider's own history).
- **It stops work first.** Before deleting, it cancels running searches, AI runs and assisted browsers. It refuses while a backup is being written.
- **One database transaction:**
  - It deletes every row of the workspace in an explicit order that respects the foreign keys above, children before parents. The order lives in one list in the code.
  - It also clears `search_query_cache` and `job_search_provider_cache`. `search_provider_budget` stays: it holds no personal data, and resetting it would let the app exceed the providers' request limits.
- **What survives, and nothing else:**
  - The workspace row, with every column except `id` set back to its default (today `name`, `timezone` and `discovery_enabled`, which returns to `false`) and its session generation increased. The test compares every column with the schema's defaults, so a column added later is covered too.
  - The `deletion_jobs` row for this operation: `id`, `workspace_id`, `status` and two timestamps. The workspace id is a random UUID with no personal meaning. Keeping it is what lets an interrupted deletion of files resume, as §19's preference for minimal identifiers allows.
- **Files**, in the selected `DATA_LOCAL_PATH` and `FILES_LOCAL_PATH`, never assuming the checkout's `data/`:
  - After the transaction commits, it deletes the contents of `FILES_LOCAL_PATH`, `backups/` and `logs/`. A new `setup-token` replaces the old one. `run/` stays, because it only holds the process records that `pnpm run stop` needs.
  - A failure here leaves the `deletion_jobs` row in a pending state, retried when the API next starts, so files cannot outlive their records silently.
  - **Codex prompts:** T2 moves the temporary folder of each Codex run into the installation's own data folder (`tmp/codex-task-*` in `DATA_LOCAL_PATH`, private like the rest of it), instead of the system's temporary directory shared by every installation of the same user. The API empties that folder when it starts, when no run of this installation can be active (one API per installation), and during this deletion, after the runs have been cancelled. It never removes anything in the system's temporary directory, where it could hit another installation's active run.
- **Sessions:** the workspace row stores a session generation number. The cookie carries it, and every authenticated request compares it with the stored value, cached in memory and refreshed when it changes. Deleting increments it, so every existing cookie stops working, in every browser. The person signs in again with the new token into the empty workspace.
- **Proof:**
  - The tests read the table list from the schema and require that, after deletion, every table holds zero rows for that workspace, except the two rows listed above. Those must hold exactly the stated columns and values.
  - The files folder is empty, and a second workspace in the same test database is untouched.
  - A table added later without being added to the deletion order makes the test fail.

### 3. Delete single items

An application, a job or a generated PDF can be deleted where the interface shows it, with a confirmation. Deleting an item removes its rows, including its events and versions, and its files, in the same way as point 2, but limited to that item. Each one is a small task once point 2 exists, and these tasks can be opened to contributors.

### 4. Retention of backups kept in the installation

- **Off by default.** The app keeps every backup until the person chooses a policy; the project does not invent a period.
- **The policy is visible and chosen in Settings:** keep the last N backups made from Settings, for example. The policy and the next deletion are shown next to the backups.
- **Unit of deletion:** a backup made from Settings is its folder, `data/backups/<id>/`, deleted as a whole: the `.tar.age` archive, its `.sha256` and the key file in `keys/`. Someone who copied that folder elsewhere keeps both the archive and its key file, and anyone who obtains that copy can decrypt it: the encryption of ADR 019 only protects a backup stored apart from its key file. The guide says to store the key file apart.
- **Backups made with `pnpm run backup`** share one key file per installation key, and that file is also needed for future backups. Retention never deletes it. Retention for the backup folder stays manual and documented, with `pnpm run uninstall --include-backups` as the way to remove everything.
- **Backups outside the installation** (downloaded or copied elsewhere) are never touched, and the app says so.

## Implementation plan

1. **T1 — Uninstall** (maintainer, 🔒):
   - `pnpm run uninstall`, the marking of restored databases in `restore.mjs`, and the guide in Spanish and English, linked from both READMEs.
   - Tests use disposable databases and folders:
     - the plan without changes;
     - a wrong or missing `--confirm`;
     - a database or role with another comment or none, including a provided database and an unmarked restore;
     - a restored installation (its database dropped, the shared role kept);
     - a role with dependencies in another database;
     - services running;
     - each refused path: reserved, overlapping the backup folder, outside the installation, through a symbolic link;
     - resuming after a failure in each step, with and without the progress file, including after `.env` is gone;
     - `--include-backups`.
   - Then a manual run on a disposable installation.
2. **T2 — Delete all data from the app** (maintainer, 🔒): the session generation (schema and API), the deletion order, the job and its retry, Codex prompts in the installation's data folder, the Settings interface (Spanish and English, keyboard, mobile), and the proof tests in point 2.
3. **T3 — Delete single items**: application, job and PDF, one pull request each, after T2. Open to contributors.
4. **T4 — Backup retention**: the policy in Settings, with tests on fictional backups showing that only expired folders are deleted, unexpired ones stay, and nothing outside `data/backups/` is touched.

## Consequences

- A person can leave without traces in the installation, and can start over without reinstalling.
- `.env` deletion moves from "never" to "only through `pnpm run uninstall`". The existing warning against deleting it to fix a problem stays.
- Every new table must be scoped to the workspace and placed in the deletion order, or listed as a cache to clear or a table that keeps no personal data. The proof test fails otherwise.
- Sessions gain one cached comparison per request.
- Restored installations get an id and a marked database. Restores made before T1 have to be removed by hand, following the guide.

## Out of scope

Erasure from backups that were downloaded or copied elsewhere, from employers, or from an AI provider's history. Deleting the PostgreSQL server, the Docker volume or the Playwright browsers. Multi-workspace installations. Exporting data, which already exists.
