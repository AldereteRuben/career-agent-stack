# Career Agent Stack

Your private workspace to find jobs automatically, prepare applications from your confirmed experience, and track each application.

**English** · [Español](README.es.md)

**Current release: v0.9.0** · [Changelog](CHANGELOG.md) · [Verification and limits](docs/releases/v0.9.0.md)

Access help: on macOS, open `Start Career Agent Stack.command` and paste the copied sign-in code. If it was already used, open `Recover Career Agent Stack.command` to create and copy a new code. This preserves workspace data and existing sessions. From a terminal on a supported installation, use `pnpm start --recover-session --copy-token`.


The interface supports **English and Spanish**. Each person runs a separate installation with their own database and keys. This is a local application, not a shared hosted service.

## What you can do

- Build your profile with editable work experience and education dates; confirm, correct or archive the details used in documents.
- Keep reusable answers with their question and country context.
- Save searches by role or company and automatically discover matches from Remotive, Arbeitnow and Himalayas, alongside confirmed companies you follow. You can also add jobs manually or follow individually reviewed Greenhouse, Lever, and Ashby employer boards.
- Search jobs by title or company, filter saved jobs and availability, archive or restore offers, and see explainable matching.
- Generate versioned resumes with English or Spanish headings, zoom the PDF preview, and reuse earlier content without altering previous PDFs.
- Follow Profile → Resume → Application with the job context preserved. Link the reviewed resume to the application and track progress with history.
- Export your workspace as JSON or create a verified database-and-PDF backup with isolated restoration.

No AI subscription or API key is required. The app prepares application drafts from approved profile facts and offers **experimental Lever assistance** in a visible browser. A separate, single-application authorization can attach the approved PDF and submit a recognized simple form. CAPTCHA, legal declarations, unsupported questions and unrecognized forms require manual completion. This is not unattended application sending. Email access and interview coaching are not implemented. Matching is evidence coverage, not a hiring probability or ATS score.

## Optional help from Codex

In **Profile and tools → Settings and privacy → Assistant**, connect the official Codex app using your own ChatGPT account. You can also connect while asking for help in a search, job, resume or saved question. Career Stack shows the exact selected text before sharing it. This consumes your plan allowance; no separate paid API fallback is used.

- Turn a description of the job you want into editable search criteria. Unsupported filters remain visible for you to check.
- Summarize a job and compare it with selected, confirmed experience.
- Review suggested resume wording and its original sources, then generate and approve the exact PDF.
- Draft an answer from confirmed facts; personal or legal details require your input.
- After a manual job analysis, optionally authorize analysis of future jobs from selected searches. It starts off, processes at most five per pass and ten per UTC day, and can be paused without stopping job searches.

Native AI execution is currently supported only on **macOS with Codex CLI 0.160.0** and ChatGPT plan authentication. Other versions or systems keep ordinary app features; this integration is not certified there. Disconnecting revokes Career Stack's access without signing you out of Codex elsewhere. Claude is deferred. [Setup, privacy and limits](docs/operations/assistant.md).

## Automatic job search

1. The app opens directly in **Find jobs**. Enter a role and, optionally, a country or location. **Add company or work mode** reveals those optional filters. No profile or resume is required.
2. Choose **Find jobs**. Results appear automatically after the first check; the search repeats daily while the local service is running. **Search options** lets you choose sources and a 6, 12 or 24 hour interval.
3. With one search, **Edit** and **Pause** are immediately available. With several, use **All my searches**, a visible search button or **Manage searches**. Review **New**, **All**, **Saved** or **Archived** jobs. New arrivals wait behind an update notice while you read.
4. Open an offer to prepare an application. Optional automatic preparation is off by default for new searches; enhanced searches allow at most five attempts per pass and ten per day. Related or geographically uncertain matches require review.
5. Keep the local service running. Closing the browser tab is fine; a sleeping or powered-off computer cannot search.

Sources are **Remotive**, **Arbeitnow**, **Himalayas** and locally stored jobs from companies you have confirmed. Coverage varies by country/profession and can be partial. Himalayas receives role, company and recognized country criteria; it never receives your resume or contact details for a search. Its cache lasts 24 hours with at most three pages per query and 100 upstream requests per day for the installation. Remotive/Arbeitnow retain their six-hour shared caches. A local refresh respects these waits and does not force new upstream requests.

Existing searches retain their sources and matching rules until you opt into enhanced matching. Restored searches stay paused with automatic preparation disabled. Following companies keeps its independent schedule; searches reuse those local results. [Operation and limits](docs/operations/automatic-discovery.md) · [Himalayas contract](docs/operations/himalayas-source.md).

## Assisted applications

Open **My applications → To review** to review a generated PDF and any missing details. For a Lever application in **My applications**, follow **Review data → Review browser**, then choose manual control or separately authorize supported submission. A current approved resume is required. Unknown results block another attempt until you check them. Public Lever pages inspected for this release required manual intervention; real-employer submission is not verified. See [the walkthrough and limits](docs/operations/assisted-applications.md).

## Start here

### 1. Install the prerequisites

- **Git** to clone this repository.
- **Node.js 24** (developed with 24.18.x; see `.node-version`).
- **pnpm 11.10.0**: after installing Node, run `npm install -g pnpm@11.10.0`.
- **PostgreSQL 17**, either installed through Homebrew on macOS (`brew install postgresql@17 && brew services start postgresql@17`) or provided by Docker with Compose. If using Docker, open Docker Desktop before setup. The clean-install verification was performed with Homebrew PostgreSQL; Docker has not been validated end to end.

Already have PostgreSQL 17? You can use it instead of Docker, setup can create a private database and role using a local administrator connection. For a custom server, supply `CAREER_ADMIN_DATABASE_URL`; to use a database you already prepared, supply `CAREER_DATABASE_URL`. See [local setup and recovery](docs/operations/local-setup.md). If another database already occupies port 5432, configure it before proceeding.

### 2. Clone and prepare

```bash
git clone https://github.com/AldereteRuben/career-agent-stack.git
cd career-agent-stack
pnpm install --frozen-lockfile
pnpm run bootstrap
```

For a private repository, your GitHub account needs access and Git must be authenticated. Alternatively, clone using `gh repo clone AldereteRuben/career-agent-stack` after `gh auth login`.

Bootstrap creates a private `.env` with new random keys, creates a separate database and credentials for this installation, applies migrations, and installs Chromium for local PDF generation. It preserves an existing `.env` and does not add demo data. Interrupted setup resumes with the same keys from `.env.pending`; `.env` is finalized when setup succeeds. The first installation needs an internet connection.

### 3. Open your workspace

```bash
pnpm start --copy-token
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) if the browser does not open automatically. On macOS, the pending sign-in token is copied to your clipboard: paste it into the login screen. The token works once. Clipboard copying depends on an available OS clipboard tool; if unavailable, open the local `data/setup-token` file and copy its contents manually. Never share it or paste it into an issue.

After initial setup, macOS users can double-click **Start Career Agent Stack.command** in the project folder. The first start compiles the application and may take a moment.

### 4. Take your first steps

1. Choose **English** or **Español** using the language button.
2. In **Find jobs**, enter a role and select **Find jobs**. Location and other filters are optional.
3. Results appear automatically. Use **Save job** for jobs you want to keep; find them under **Saved jobs**. You can edit or pause your search from the results screen.
4. Open a job and select **Prepare my application**. If details are missing, the guide asks for what is needed and keeps the job you chose.
5. Review and approve the prepared resume, then **Continue application**. The approved PDF remains linked to it.
6. Track progress in **My applications**. Lever assistance requires separate authorization; unsupported forms continue on the employer’s website. You can add a job manually in **Profile and tools → All jobs**.

The main menu has three destinations: **Find jobs**, **Saved jobs** and **My applications**. Open **Profile and tools** for your profile, resumes, all found jobs, followed companies, settings and the overview. A job shows its description first; **Fit with your profile (optional)** opens the detailed analysis.

Resume preparation keeps its name, language and content selection separately for each job in the current tab, so you can return after editing your profile. These temporary drafts are cleared on sign-out and may be lost when closing the tab; generate a PDF to save a version. If selected profile details change, the app asks you to review the selection again. Returning from a job to its list keeps your search and filters.

## Everyday commands

Run these from the project folder:

| Command | Purpose |
| --- | --- |
| `pnpm start` | Start missing services and open the app; reuse healthy services. |
| `pnpm start --copy-token` | Also copy a pending login token when clipboard support is available. |
| `pnpm start --no-open` | Start without opening a browser. |
| `pnpm run status` | Check dependencies, services, and whether a restart is needed. |
| `pnpm run stop` | Stop API and web processes started by the launcher; keep data. |
| `pnpm run reset:session` | Create a new login token if the old one was consumed. Existing sessions remain valid. |
| `pnpm run backup` | Create and verify a database-and-document backup. |
| `pnpm run restore --help` | Show how to verify or restore a backup into a new workspace. |
| `pnpm run doctor` | Diagnose local configuration. |

### Update an installation

```bash
pnpm run stop
git pull --ff-only
pnpm install --frozen-lockfile
pnpm start
```

Starting a stopped API applies pending migrations and rebuilds changed code. If you started services manually, stop them in their original terminal first. Keep an independent backup before updating an installation with important data.

## Troubleshooting

| Problem | Next step |
| --- | --- |
| Node or pnpm not found | Install the prerequisites, then reopen your terminal. |
| PostgreSQL unavailable during setup | Open Docker Desktop and rerun `pnpm run bootstrap`. For an existing server, check `DATABASE_URL` and its database/role. |
| No login token remains | Run `pnpm run reset:session`, then `pnpm start --copy-token`. |
| App looks unchanged after an update | Run `pnpm run stop`, `pnpm run build`, then `pnpm start`. |
| Port 3000, 3001, or 5432 is busy | Identify the application using it; see [local recovery](docs/operations/local-setup.md). |
| App or API will not start | Run `pnpm run doctor` and inspect `data/logs/` locally. Remove sensitive information before sharing logs. |

## Your data and current limits

- Services listen on `127.0.0.1`. Do not expose them to your network as a multiuser service.
- Keep `.env`, `data/`, exports, and backups private. These local files are excluded from Git. **Do not delete `.env` to reset the app**: it contains your encryption key.
- PostgreSQL stores records; `data/files/` stores generated documents. The Docker database uses the persistent `career-postgres` volume. Do not remove the volume to troubleshoot a startup issue.
- External board discovery is opt-in and requires an explicit review of the employer association and public-read permission. It searches configured boards only, not the whole job market.
- Operational backups include the database and PDFs, with hashes and a signed manifest. Restoration requires the separate key file and creates a new database and folder; it never overwrites an existing workspace. The archive is **not encrypted**. See [backup and restore](docs/operations/backup-restore.md).
- Full installation, recovery and browser verification was performed on macOS. CI checks compilation and domain logic on Linux and Windows; this does not validate their full installation or desktop launchers. The local launcher currently relies on Unix process tools, so native Windows startup/shutdown is not supported. Linux/WSL installation remains unverified end to end.

## Back up your work

In **Profile and tools → Settings and privacy**, choose **Create backup**, then download both the verified archive and its recovery key. Download them before restarting the app or creating another copy; local originals remain in `data/backups/<id>/` (keys in its `keys/` folder). This screen does not restore backups or automatically delete old copies.

Alternatively, on macOS double-click **Backup Career Agent Stack.command**, or run `pnpm run backup`. Wait for successful verification, then keep the archive and its separate key file in private storage. PostgreSQL client tools (`pg_dump` and `pg_restore`, version 17 or compatible with your server) are required; see the [recovery guide](docs/operations/backup-restore.md) for installation and restore instructions.

## Development and verification

Stack: Next.js/React dashboard, Fastify API, TypeScript domain package, PostgreSQL with Drizzle, and Playwright for PDFs and browser tests.

```bash
pnpm run dev         # API and dashboard in watch mode
pnpm run build       # production build
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:e2e
pnpm run test:sources # deterministic adapter tests; no network
```

E2E tests use a disposable database, private services, and fictional data. They require a local database role that can create databases, or an `E2E_ADMIN_DATABASE_URL`; see [E2E setup and isolation](docs/operations/e2e-testing.md). Read-only checks verify that the live workspace was not modified. `pnpm run test:backup` checks the archive format without a database. `pnpm run test:integration` tests backup and restore with disposable databases when `CAREER_BACKUP_TEST_ADMIN_URL` is set; otherwise that suite is skipped. `pnpm run test:setup` exercises a clean installation using a local administrator. `pnpm run test:assisted` covers the new workflow; its database suite requires `CAREER_ASSIST_TEST_ADMIN_URL`. The `runner` command explains where to authorize from the UI. `pnpm run test:evals` runs the synthetic search matching and ranking regression cases; these are deterministic checks, not an independent evaluation of real-world relevance.

For provider compatibility and the real public feeds checked, see [source validation](docs/operations/source-validation.md). `pnpm run verify:sources --live` explicitly enables a fresh read-only check of those public feeds. It does not enable sources in your workspace.

## Project map

| Path | Contents |
| --- | --- |
| `apps/dashboard` | Bilingual user interface. |
| `apps/api` | Local API, PDF rendering, and E2E harness. |
| `packages/domain` | Contracts, matching, and state transitions. |
| `packages/db` | Database schema and migrations. |
| `scripts` | Setup, launch, stop, and diagnostics. |
| `docs` | Scope, setup, and operational notes. |

See [Security](SECURITY.md), [third-party notices](THIRD_PARTY_NOTICES.md), and the [implementation brief](docs/implementation-brief.md). The brief describes broader product intent; the capabilities and limitations above describe this release.

## Community and contributions

Bug reports, feature ideas, translations and pull requests are welcome in English or Spanish. See [Contributing](CONTRIBUTING.md), [community conduct](CODE_OF_CONDUCT.md) and [security reporting](SECURITY.md).

## License

Free for noncommercial use under [PolyForm Noncommercial 1.0.0](LICENSE), with an [additional permission for your own job search](LICENSE-PERSONAL-USE.md), including seeking paid employment. You may clone, adapt and share the project for permitted purposes while retaining the license and notices. Commercial sale, paid hosting and reuse in commercial products or business operations are not licensed, subject to the standard license's express permissions for noncommercial organizations. Those permissions include specified charitable, educational and government institutions regardless of their funding.

This is **source-available software with noncommercial restrictions**. It is not OSI-approved open source. A license provides legal terms; it cannot technically prevent copying or guarantee enforcement. Your CVs and other user-created career documents remain yours; this software license does not license your personal data.

Third-party components retain their [own licenses and notices](THIRD_PARTY_NOTICES.md). These terms accompany the current licensed source tree; earlier release archives did not include them. Release v0.3.0 includes the license and contribution terms.

[Repository publication controls](docs/operations/public-repository.md).
