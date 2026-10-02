# Local setup and recovery

## First run

1. Use Node.js 24.18.x and pnpm 11.10.0 (`.node-version` is read by fnm and nvm).
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm run bootstrap`. It is safe to repeat. It:
   - creates `.env` from `.env.example` with new random `APP_ENCRYPTION_KEY` and `APP_SESSION_SECRET` **only if `.env` does not exist**. An existing `.env` is never overwritten. The keys are not printed.
   - creates `data/files` and `backups` with private permissions.
   - reuses PostgreSQL if it already answers on `DATABASE_URL`. Otherwise, for a loopback URL, it tries `docker compose up -d --wait postgres`. It does not create a Homebrew database cluster or role for you.
   - applies pending migrations (`pnpm run db:migrate`) and installs the pinned Chromium used for local PDF rendering.
   - does not seed demo data and does not enable any board.
4. Run `pnpm start` (or double-click `Start Career Agent Stack.command`). On first sign-in, use the token in `data/setup-token`. The token is consumed once.
5. Create a user-approved career profile and add a board. Verify the company association and the provider's public read API before enabling it.

No board is enabled by bootstrap or demo seeding. An empty board registry means discovery is not configured, not that no relevant jobs exist.

## Daily start: `pnpm start` / `Start Career Agent Stack.command`

| Step | What happens |
| --- | --- |
| Node and dependencies | Checks Node 24 and pnpm. Runs `pnpm install --frozen-lockfile` when `pnpm-lock.yaml` is newer than the install. |
| Configuration | Runs bootstrap when `.env` is missing. Stops with guidance when `DATABASE_URL` or the local keys are missing. It never edits an existing `.env`. |
| PostgreSQL | Reuses a server that answers on `DATABASE_URL`. If a loopback server is down, it starts Homebrew `postgresql@17` with `pg_ctl` (log: `data/postgres.log`) or, failing that, Docker Compose. |
| API | Reuses a healthy API (`/healthz` reports the database ready). For a reused API, it reports **restart required** when the sources are newer than `dist/` or the process started before the current build. It never restarts it silently. If the API is not running, it applies pending migrations, builds when sources are newer than `dist/`, starts `apps/api/dist/server.js` in the background, and waits up to 60 s. |
| Web app | Reuses a running app on `WEB_PORT`. A stale build or process is reported the same way. Dev servers (`next dev`, `tsx watch`) are treated as current. If the app is not running, it builds when sources are newer than `.next/BUILD_ID`, starts `next start`, and waits up to 90 s. |
| Browser | Opens `WEB_ORIGIN` (no token or secret in the URL). `--no-open` skips this. |
| Sign-in token | With `--copy-token` (the `.command` file always passes it), a pending single-use token is copied to the clipboard. It is not printed, logged or put in a URL, and it is cleared from the clipboard after 2 minutes if it is still there. A clipboard manager with history may keep a copy. |

Processes started by the launcher write logs to `data/logs/`. They are recorded in `data/run/` with their exact identity: PID, process group, start time, working directory, absolute entry point, and checkout. `pnpm run stop` checks that identity again right before each signal and signals only an exact match. A process whose PID was reused, or a record from an older launcher version, is **not** stopped. The command explains why, exits 1, and leaves the process running. `pnpm run stop --forget` then removes such records without signalling anything. Services you started yourself are left alone. PostgreSQL keeps running unless you pass `--database`. Stopping it keeps the data.

`pnpm run status` gives the same report without starting, building, installing, or migrating anything. It exits `0` only when everything is ready and current. It exits `1` when a dependency or service is missing, or when a running service needs a restart to use the latest code. Scripts and CI can rely on this.

Messages are printed in Spanish and English. Spanish comes first when the system language is Spanish, or you can set `CAREER_LANG=es`. Every failure ends with the next concrete step and confirms that no data was deleted.

### Known limits

- The `.command` file is macOS-only. On Linux or Windows, run `pnpm start`.
- Rebuild detection compares modification times. After an unusual checkout, if the app looks outdated, run `pnpm run stop`, then `pnpm run build`, then `pnpm start`.
- A port taken by another program is reported, not freed. Use `lsof -nP -iTCP:<port> -sTCP:LISTEN` to see what is using it.
- The launcher does not install PostgreSQL. It also does not create the role or database named in `DATABASE_URL` on a Homebrew install.

## Recovery

| Problem | What to do |
| --- | --- |
| Signed out and `data/setup-token` is gone (used) | `pnpm run reset:session` writes a new single-use token, and `pnpm start --copy-token` copies it. It does not change data or restart the API (the API reads the file at sign-in time). |
| You suspect an unknown browser has a session | `reset:session` does **not** revoke existing sessions. They stay valid until they expire (14 days). To revoke all sessions, replace `APP_SESSION_SECRET` in `.env` with a new random value and restart the API (`pnpm run stop`, then `pnpm start`). Leave `APP_ENCRYPTION_KEY` unchanged. |
| "Node.js 24 is required" | `fnm install 24 && fnm use 24` or `nvm install 24 && nvm use 24`. |
| PostgreSQL does not answer | `brew services start postgresql@17`, or open Docker Desktop and run `docker compose up -d --wait postgres`. Then run `pnpm start` again. |
| Port 3000/3001 busy but unhealthy | If the launcher started it, run `pnpm run stop`. Otherwise, find the owner with `lsof` (see above). |
| Status says "restart required" | If the launcher started the service: `pnpm run stop`, then `pnpm start`. Otherwise, stop it where you started it, then run `pnpm start`. |
| `pnpm run stop` refuses a PID | Check the process with `ps -o pid,lstart,args -p <pid>` and stop it yourself if it is ours, then run `pnpm run stop --forget`. |
| API or web app not ready in time | Read `data/logs/api.log` or `data/logs/dashboard.log`, then run `pnpm run doctor`. |

Never delete `.env` to "reset" the installation: it holds the key that protects stored data.

## No-AI operation

The default is `AI_PROVIDER=none`. Profile editing, answer management, job discovery, ranking, application tracking, and export do not depend on an AI service. AI provider support is not enabled by this v0.1 implementation.

## Export

Use the workspace export action to download versioned JSON. It includes career facts, jobs, board records, application history, and a hash manifest. Board permissions are reset to unknown and disabled in the portable copy. The export excludes authentication material. Treat the file as sensitive personal data.

## Restore and operational backups

Operational database/artifact backup restore is not yet implemented. `pnpm run backup` and `pnpm run restore` fail explicitly rather than report false success. Keep an independent encrypted system backup until a coordinated, isolated restore flow is available. Never re-enable discovery automatically after restoring data.

## Feature boundaries

Browser autofill, employer-site writes, submission, mailbox access, and interview coaching are unavailable. Setting a configuration level does not enable them. Application records entered manually are user-attested; an uncertain result must be reconciled before any independent repeat action.

## Inicio rápido (español)

- Primera vez: `pnpm install --frozen-lockfile` y `pnpm run bootstrap`. Puedes repetirlo sin riesgo: no sobrescribe `.env` ni borra datos.
- Cada día: doble clic en `Start Career Agent Stack.command` o `pnpm start`. Reutiliza lo que ya funciona, inicia lo que falta, espera a que responda y abre el navegador.
- Estado sin cambiar nada: `pnpm run status`. Termina con error si falta algo o si un servicio necesita reiniciarse para usar la última versión. Detener lo que inició el lanzador: `pnpm run stop`.
- ¿Te pide un token? `pnpm start --copy-token` lo copia al portapapeles sin mostrarlo y lo borra de ahí a los 2 minutos; el archivo `.command` lo hace siempre. Si ya no tienes token, ejecuta antes `pnpm run reset:session`. Tus datos no cambian. Las sesiones ya abiertas siguen válidas hasta que caducan.
- Si algo falla, el mensaje explica el siguiente paso en español e inglés. Los registros están en `data/logs/`.
