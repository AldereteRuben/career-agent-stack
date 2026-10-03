# Security policy

## Supported deployment

Version 0.2 is designed for one private workspace on one local computer. The API binds to loopback and checks Host and Origin on state-changing requests. The session cookie is HttpOnly and SameSite=Strict. Do not expose the API, PostgreSQL, Ollama, or a browser debugging port to a LAN or the internet.

The first-run token is stored under `data/setup-token` with private permissions and is consumed after sign-in. The API signs a 14-day session with `APP_SESSION_SECRET`. Losing or changing the secret invalidates sessions; a session reset is handled locally. A full-disk encryption layer is recommended for stored CVs and other personal information.

## External traffic

The application performs no outbound requests for a manual import. Board discovery calls only fixed HTTPS endpoints for Greenhouse, Lever, and Ashby after a board has been reviewed and enabled. It refuses redirects and enforces response limits. The current local runtime does not claim to be a general-purpose SSRF sandbox: do not configure arbitrary fetch URLs, proxies, or browser adapters.

No application form is opened, filled, uploaded to, or submitted by this release. CAPTCHA, MFA, employer credentials, LinkedIn pages, and mailbox credentials are outside the supported workflow.

## Data and diagnostics

Do not commit `.env`, `data/`, `storage/`, `backups/`, exports, resumes, application receipts, or session material. Logs redact cookie and authorization headers; keep logs private. Diagnostics and browser traces are disabled because the browser runner is not implemented. Exports are personal data and should be encrypted at rest by the user.

## Recovery artifacts

Operational backups include a database dump and generated documents. The archive is **not encrypted**; keep it on an encrypted drive or in a private location. A separate key file authenticates the manifest and preserves the installation encryption key. Restoring requires that key, creates a new database and data folder, resets source permissions, and generates fresh sign-in credentials. See [backup and restore](docs/operations/backup-restore.md).

## Reporting

This private repository does not have a public security disclosure process. For private development, report issues directly to the project owner and include sanitized reproduction steps only.
