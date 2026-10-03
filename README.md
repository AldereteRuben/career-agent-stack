# Career Agent Stack

Your private workspace to organize a job search: keep your career profile, save jobs, prepare PDF drafts, and track applications in one place.

**English** · [Español](README.es.md)

**Current release: v0.2.0** · [Changelog](CHANGELOG.md) · [Verification and limits](docs/releases/v0.2.0.md)

The interface supports **English and Spanish**. Each person runs a separate installation with their own database and keys. This is a local application, not a shared hosted service.

## What you can do

- Build your profile and explicitly approve the facts used in documents.
- Keep reusable answers with their question and country context.
- Add jobs manually or discover them through individually reviewed Greenhouse, Lever, and Ashby employer boards.
- See explainable job matching based on your preferences and approved facts.
- Generate, preview, review, and download versioned PDF drafts.
- Track applications, notes, and hiring stages, including corrections with history.
- Export your workspace as JSON or create a verified database-and-PDF backup with isolated restoration.

No AI subscription or API key is required. Version 0.2 does **not** submit applications, autofill employer websites, connect to email, or provide interview coaching. Matching is evidence coverage, not a hiring probability or ATS score.

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
2. Open **My profile**, add your details and job preferences, and save.
3. Add career facts and approve the ones you have checked.
4. Open **Jobs** and add a job manually. Configuring external sources is optional.
5. Prepare a PDF from approved facts and review it before approving the version.
6. Use **Applications** to record progress and notes. Sending an application remains a manual action on the employer's website.

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
- Local verification was performed on macOS. Other operating systems have not received the same end-to-end validation.

## Back up your work

On macOS, double-click **Backup Career Agent Stack.command**, or run `pnpm run backup`. Wait for successful verification, then keep the archive and its separate key file in private storage. PostgreSQL client tools (`pg_dump` and `pg_restore`, version 17 or compatible with your server) are required; see the [recovery guide](docs/operations/backup-restore.md) for installation and restore instructions.

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

E2E tests use a disposable database, private services, and fictional data. They require a local database role that can create databases, or an `E2E_ADMIN_DATABASE_URL`; see [E2E setup and isolation](docs/operations/e2e-testing.md). Read-only checks verify that the live workspace was not modified. `pnpm run test:backup` checks the archive format without a database. `pnpm run test:integration` tests backup and restore with disposable databases when `CAREER_BACKUP_TEST_ADMIN_URL` is set; otherwise that suite is skipped. `pnpm run test:setup` exercises a clean installation using a local administrator. The `test:evals` and `runner` commands remain unavailable.

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

Third-party components retain their [own licenses and notices](THIRD_PARTY_NOTICES.md). These terms accompany the current licensed source tree; earlier release archives did not include them. Use the licensed revision of `main` until a new licensed release is tagged.

[Repository publication controls](docs/operations/public-repository.md).
