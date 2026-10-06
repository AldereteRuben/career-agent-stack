# Security policy

**English** · [Español](#en-español)

## Supported versions

Security fixes are made only for the [latest release](https://github.com/AldereteRuben/career-agent-stack/releases/latest). Update to it before reporting a problem; older versions do not receive patches.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Any earlier release | No |

## Supported deployment

Career Agent Stack is designed for one private workspace on one local computer. The API binds to loopback and checks Host and Origin on state-changing requests. The session cookie is HttpOnly and SameSite=Strict. Do not expose the API, PostgreSQL, Ollama, or a browser debugging port to a LAN or the internet.

The first-run token is stored under `data/setup-token` with private permissions and is consumed after sign-in. The API signs a 14-day session with `APP_SESSION_SECRET`. Losing or changing the secret invalidates sessions; a session reset is handled locally. A full-disk encryption layer is recommended for stored CVs and other personal information.

## External traffic

The application performs no outbound requests for a manual import. Board discovery calls only fixed HTTPS endpoints for Greenhouse, Lever, and Ashby after a board has been reviewed and enabled. It refuses redirects and enforces response limits. The current local runtime does not claim to be a general-purpose SSRF sandbox: do not configure arbitrary fetch URLs, proxies, or browser adapters.

The assisted Lever workflow opens a visible ephemeral Chromium browser and fills contact fields only after explicit, one-use consent. Network requests are paused while filling and reviewing; a second confirmation enables manual interaction. The user handles uploads, custom questions, consents, CAPTCHA and submission. The app never automatically submits or solves challenges. No employer credentials, LinkedIn automation or mailbox integration are supported. See [the adapter boundary](docs/decisions/015-assisted-applications.md).

## Data and diagnostics

Do not commit `.env`, `data/`, `storage/`, `backups/`, exports, resumes, application receipts, or session material. Logs redact cookie and authorization headers; keep logs private. The assisted browser stores no cookies, storage state, traces or screenshots. Attempt snapshots and user outcome notes are personal data. Exports are personal data and should be encrypted at rest by the user.

## Recovery artifacts

Operational backups include a database dump and generated documents. The archive is **not encrypted**; keep it on an encrypted drive or in a private location. A separate key file authenticates the manifest and preserves the installation encryption key. Restoring requires that key, creates a new database and data folder, resets source permissions, and generates fresh sign-in credentials. See [backup and restore](docs/operations/backup-restore.md).

## Reporting a vulnerability

Do not report vulnerabilities, tokens or personal information in public issues, discussions or pull requests.

Use [Report a vulnerability](https://github.com/AldereteRuben/career-agent-stack/security/advisories/new) (GitHub private vulnerability reporting). Only the maintainers see the report, and the fix can be coordinated privately before it is disclosed.

If you cannot use that form, use the [private channel request](https://github.com/AldereteRuben/career-agent-stack/issues/new?template=private_channel.yml) form. It asks only for a private way to continue; include no vulnerability details.

Reports should describe the affected version, impact and a minimal reproduction using fictional data. Do not access someone else's workspace or upload backups as proof. The maintainers are volunteers: no response time is guaranteed, but reports are read and acknowledged as soon as possible, and reporters are credited in the advisory unless they prefer otherwise.

## En español

Solo la [última versión publicada](https://github.com/AldereteRuben/career-agent-stack/releases/latest) recibe correcciones de seguridad; actualiza antes de reportar.

No publiques vulnerabilidades, tokens ni datos personales en issues, conversaciones o pull requests públicos. Usa [Report a vulnerability](https://github.com/AldereteRuben/career-agent-stack/security/advisories/new) (reporte privado de GitHub): solo los responsables lo ven y la corrección se coordina en privado antes de hacerla pública. Si no puedes usarlo, usa el formulario para [pedir un canal privado](https://github.com/AldereteRuben/career-agent-stack/issues/new?template=private_channel.yml), sin detalles. Describe la versión afectada, el impacto y una reproducción mínima con datos ficticios. No accedas al espacio de otra persona ni subas copias de seguridad como prueba.

La aplicación está pensada para un único espacio privado en un solo equipo local. No expongas la API, PostgreSQL, Ollama ni un puerto de depuración del navegador a la red local o a internet.

No subas a Git `.env`, `data/`, `storage/`, `backups/`, exportaciones, CVs, comprobantes de solicitudes ni material de sesión. Las copias de seguridad **no están cifradas**: guárdalas en un disco cifrado o en un lugar privado, junto con su archivo de clave por separado. Las exportaciones y los registros contienen datos personales. Consulta la [guía de copias de seguridad](docs/operations/backup-restore.md).
