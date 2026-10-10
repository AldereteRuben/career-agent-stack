# Local setup and recovery

## Quick start (macOS)

```bash
brew install fnm postgresql@17 && fnm install 24 && corepack enable   # Node 24 + pnpm 11 (Homebrew node@24 is keg-only)
brew services start postgresql@17
node scripts/bootstrap.mjs                 # dependencies, private .env, own database, migrations
pnpm start                                 # or double-click "Start Career Agent Stack.command"
```

With Docker instead of Homebrew PostgreSQL, open Docker Desktop and skip the first two PostgreSQL steps: bootstrap starts the bundled `compose.yaml` database when nothing answers on port 5432 and then uses its administrator automatically.

## Linux (Ubuntu)

Verified on Ubuntu 26.04 (GNOME on Wayland) with PostgreSQL 17: the clean-install smoke test passes. The PostgreSQL 15 path was also exercised on that machine (server 15.18 from the npm package `@embedded-postgres/linux-x64`, not a distribution package), with an administrator that is not a superuser: the bootstrap test and the clean-install smoke test pass. Not verified: other distributions (Fedora, Arch, Debian), X11 or desktops other than GNOME, WSL 2, and the macOS `.command` checks, which the smoke test skips without `zsh`. If you try one of them, share the result in [issue #20](https://github.com/AldereteRuben/career-agent-stack/issues/20).

```sh
# Node 24 and pnpm 11.10.0, for example with fnm (https://github.com/Schniz/fnm)
fnm install 24 && fnm use 24 && npm install -g pnpm@11.10.0

# PostgreSQL 17: Ubuntu 26.04 ships 18, so use the official PostgreSQL (PGDG) repository
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt install -y postgresql-17

# An administrator that bootstrap can use (it only creates this installation's own role and database)
sudo -u postgres psql -c "ALTER ROLE $USER WITH LOGIN CREATEDB CREATEROLE;"   # use CREATE ROLE if it does not exist
sudo -u postgres psql -c "\password $USER"
CAREER_ADMIN_DATABASE_URL="postgresql://$USER:YOUR_PASSWORD@127.0.0.1:5432/postgres" pnpm run bootstrap
```

`pnpm start --copy-token` needs a clipboard tool: `wl-clipboard` on Wayland or `xclip` on X11 (`sudo apt install wl-clipboard`). Without one it prints where the token file is. The `.command` launchers are macOS-only; use `pnpm start`.

## First run

The tested default is **macOS with Homebrew PostgreSQL 17** (`brew install postgresql@17 && brew services start postgresql@17`). Docker Compose is a fallback that bootstrap uses only when nothing answers on the database port and Docker is running; it was not available on the machine where v0.2 was verified. CI checks builds on Linux and Windows; complete installation and browser journeys on those systems have not been verified.

1. Use Node.js 24.x and pnpm 11 (`.node-version` is read by fnm; the `.command` launcher also asks nvm for it).
2. Run `node scripts/bootstrap.mjs` (or `pnpm run bootstrap`, or just double-click `Start Career Agent Stack.command`, which runs it when `.env` is missing). It is safe to repeat and resumes after a failure:
   1. checks Node 24 and pnpm 11 and runs `pnpm install --frozen-lockfile` when dependencies are missing or older than the lockfile;
   2. writes the private configuration to `.env.pending` (mode 0600): new random `APP_ENCRYPTION_KEY` and `APP_SESSION_SECRET`, a database and role **of its own** named `career_<install id>` with a random password, and free ports (3000/3001 when free, otherwise the next free pair from 3100). Nothing is printed;
   3. creates that role and database through an administrator connection (default `postgresql://<your macOS user>@127.0.0.1:5432/postgres`, which is how Homebrew sets PostgreSQL up). Both carry a `career-agent-stack install <id>` comment, the database is owned by the role, and other local roles cannot connect to it. Nothing else on the server is touched: an existing `career` database of another checkout is never reused;
   4. checks the new credentials, applies the migrations, creates `data/`, `data/files/` and `backups/` (0700) and installs the pinned Chromium for PDF rendering (a failed Chromium download is a warning: the app works, PDF export does not until it is installed);
   5. only then turns `.env.pending` into `.env` with an atomic, no-overwrite rename.

   If any step fails, there is no `.env`, so nothing points at a half-prepared database. The message says what to fix in Spanish and English; re-running continues from `.env.pending` with the same keys, database name and ports. Roles and databases the run already created carry its mark and are reused; a role or database with the same name that it did **not** create is refused, never reused.
3. Run `pnpm start` (or double-click `Start Career Agent Stack.command`). On first sign-in, use the token in `data/setup-token` (the `.command` file copies it to the clipboard). The token is consumed once.
4. The app opens in **Find jobs**. Enter a role and select **Find jobs**; location is optional, and **Add company or work mode** reveals other criteria. Searching needs no profile. Save interesting offers in **Saved jobs** or choose **Prepare my application**; the guide asks for missing details. Profiles, resumes and optional company boards are under **Profile and tools**.

No board is enabled by bootstrap or demo seeding. An empty board registry only means no individual companies are followed. Role and company searches have their own settings in **Find jobs**.

### Repeated start commands

`pnpm start --copy-token` reuses healthy local services and copies the pending sign-in token without displaying it. The project disables pnpm's automatic dependency installation before scripts; the launcher installs missing dependencies with the frozen lockfile instead. Keep the pnpm version pinned in `package.json`; an update notification does not require changing it.

Start commands in the same checkout wait for each other, so they do not run migrations or builds simultaneously. After five minutes, a waiting command exits with recovery instructions. If an interrupted startup leaves `data/launcher.lock`, first confirm that its launcher and any child build have stopped before removing that lock. Never remove a lock while a build is still running. `pnpm run status` remains read-only and does not acquire the startup lock.

### Bootstrap options

| Variable | Use |
| --- | --- |
| `CAREER_ADMIN_DATABASE_URL` | Administrator used once to create the role and database (needs `CREATEROLE` and `CREATEDB`, or superuser). It always takes priority. Without it, bootstrap uses the `compose.yaml` administrator only when this checkout's own Compose `postgres` container is running and publishes the port, and otherwise your macOS user (the Homebrew default). |
| `CAREER_DATABASE_URL` | Use this existing, empty database instead; nothing is created. |
| `CAREER_WEB_PORT`, `CAREER_API_PORT` | Ports for this installation. Bootstrap stops if they are busy. |
| `CAREER_INSTALL_ID` | Suffix for the database and role names (`a-z`, `0-9`, `_`). Default: random. |
| `CAREER_SKIP_BROWSER_INSTALL=1` | Skip the Chromium download. |

They are read only while `.env.pending` is being created; a resumed run keeps what it wrote. To start over before `.env` exists, delete `.env.pending` (and, if you wish, the `career_<id>` database and role it named).

### Existing installations

An existing `.env` is never modified. Bootstrap only checks it (it warns if it is readable by others), makes sure its database answers and accepts its credentials, applies pending migrations and finishes the folders and Chromium. Installations from before v0.2 keep using their `career` database; `pnpm run doctor` reports this. If PostgreSQL answers but refuses the `.env` credentials, the usual cause is a different server on the same port: the message says so, and nothing is changed.

### Per-installation isolation

Each checkout is a separate installation: its own `.env`, database and role, ports, `data/` (sign-in token, files, logs, run records) and `.next` build. The launcher passes the values of the checkout's `.env` to the API, migrations and builds, and drops `DATABASE_URL`, `APP_*`, `API_*`, `WEB_*`, `DATA_LOCAL_PATH`, `FILES_*` and `PG*` inherited from the shell, so a variable exported for another project cannot point this installation at other data. The web app build records the API address it was built for and is rebuilt when that changes.

### Running another installation's configuration: `CAREER_ENV_FILE`

`CAREER_ENV_FILE=/path/to/.env` makes `pnpm start`, `pnpm run status`, `pnpm run stop`, `pnpm run doctor`, `pnpm run reset:session` and `pnpm run bootstrap` use that file instead of the checkout's `.env`. This is how a restored workspace (see the backup and restore guide) is opened without copying anything over the live `.env`:

```bash
git worktree add ../career-restored            # another checkout of the same version, with no .env of its own
cd ../career-restored && pnpm install --frozen-lockfile
CAREER_ENV_FILE=/path/to/restored/.env pnpm start --copy-token
CAREER_ENV_FILE=/path/to/restored/.env pnpm run stop
```

- The selected file must set `DATA_LOCAL_PATH` and `FILES_LOCAL_PATH` to absolute paths outside the checkout's `data/` (the restore output does). Run records and logs go to `<DATA_LOCAL_PATH>/run` and `<DATA_LOCAL_PATH>/logs`, and the sign-in token to `<DATA_LOCAL_PATH>/setup-token`, so the other installation is started and stopped on its own.
- Every value comes from that file. Keys of the checkout's `.env` that the file lacks are set to their `.env.example` defaults for the API and migrations, so no live key, path or port can fill a gap.
- Use a **separate checkout**. The web build bakes in the API address, so a checkout with its own `.env` refuses (before starting anything) to rebuild its `.next` for another configuration: that would silently point the live web app at the other API. A checkout without `.env` builds freely.
- With `CAREER_ENV_FILE`, nothing new is ever set up: a missing file is an error, not a first run.

## Daily start: `pnpm start` / `Start Career Agent Stack.command`

| Step | What happens |
| --- | --- |
| Node and dependencies | Checks Node 24 and pnpm. Runs `pnpm install --frozen-lockfile` when `pnpm-lock.yaml` is newer than the install. |
| Configuration | Runs bootstrap when `.env` is missing (it resumes an unfinished `.env.pending`). Stops with guidance when `DATABASE_URL` or the local keys are missing. It never edits an existing `.env`. Child processes get the `.env` values, not install-scoped variables from the shell. |
| PostgreSQL | Reuses a server that answers on `DATABASE_URL`. If a loopback server is down, it starts Homebrew `postgresql@17` with `pg_ctl` (log: `data/postgres.log`) or, failing that, Docker Compose. |
| API | Reuses a healthy API (`/healthz` reports the database ready). For a reused API, it reports **restart required** when the sources are newer than `dist/` or the process started before the current build. It never restarts it silently. If the API is not running, it applies pending migrations, builds when sources are newer than `dist/`, starts `apps/api/dist/server.js` in the background, and waits up to 60 s. |
| Web app | Reuses a running app on `WEB_PORT`. A stale build or process is reported the same way. Dev servers (`next dev`, `tsx watch`) are treated as current. If the app is not running, it builds when sources are newer than `.next/BUILD_ID` or the build was made for another `API_BASE_URL`, starts `next start`, and waits up to 90 s. |
| Browser | Opens `WEB_ORIGIN` (no token or secret in the URL). `--no-open` skips this. |
| Sign-in token | With `--copy-token` (the `.command` file always passes it), a pending single-use token is copied to the clipboard. It is not printed, logged or put in a URL, and it is cleared from the clipboard after 2 minutes if it is still there. A clipboard manager with history may keep a copy. |

Processes started by the launcher write logs to `data/logs/`. They are recorded in `data/run/` with their exact identity: PID, process group, start time, working directory, absolute entry point, and checkout. `pnpm run stop` checks that identity again right before each signal and signals only an exact match. A process whose PID was reused, or a record from an older launcher version, is **not** stopped. The command explains why, exits 1, and leaves the process running. `pnpm run stop --forget` then removes such records without signalling anything. Services you started yourself are left alone. PostgreSQL keeps running unless you pass `--database`. Stopping it keeps the data.

`pnpm run status` gives the same report without starting, building, installing, or migrating anything. It exits `0` only when everything is ready and current. It exits `1` when a dependency or service is missing, or when a running service needs a restart to use the latest code. Scripts and CI can rely on this.

Messages are printed in Spanish and English. Spanish comes first when the system language is Spanish, or you can set `CAREER_LANG=es`. Every failure ends with the next concrete step and confirms that no data was deleted.

### Known limits

- The `.command` file is macOS-only (zsh). From Finder it loads fnm or nvm, refuses a Node other than 24 with a clear message (Homebrew's `node` may be a newer major), and on failure waits for Enter so the message stays readable. The CLI launcher relies on Unix process tools: native Windows startup is unsupported. On Linux the smoke test passes (see above); WSL has not been verified.
- Rebuild detection compares modification times. After an unusual checkout, if the app looks outdated, run `pnpm run stop`, then `pnpm run build`, then `pnpm start`.
- A port taken by another program is reported, not freed. Use `lsof -nP -iTCP:<port> -sTCP:LISTEN` to see what is using it.
- Neither bootstrap nor the launcher installs PostgreSQL or creates a cluster. Bootstrap creates only this installation's own role and database, and only through an administrator that can connect.

## Recovery

| Problem | What to do |
| --- | --- |
| Signed out and `data/setup-token` is gone (used) | `pnpm run reset:session` writes a new single-use token, and `pnpm start --copy-token` copies it. It does not change data or restart the API (the API reads the file at sign-in time). |
| You suspect an unknown browser has a session | `reset:session` does **not** revoke existing sessions. They stay valid until they expire (14 days). To revoke all sessions, replace `APP_SESSION_SECRET` in `.env` with a new random value and restart the API (`pnpm run stop`, then `pnpm start`). Leave `APP_ENCRYPTION_KEY` unchanged. |
| Bootstrap stopped: "A PostgreSQL server answers … but the administrator cannot connect" | Another server (or one without your macOS user as administrator) owns the port. Pass an administrator: `CAREER_ADMIN_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/postgres pnpm run bootstrap`, or create an empty database yourself, delete `.env.pending` and run with `CAREER_DATABASE_URL`. |
| Bootstrap stopped: "cannot act as the new role" (or "must be able to SET ROLE") | PostgreSQL 16+ only. Your administrator is not a superuser and could not be granted `SET` on the new role. As a superuser run `GRANT <role named in the message> TO <your administrator> WITH SET TRUE;` and repeat `pnpm run bootstrap`; it resumes with the same keys. Current bootstrap grants this itself, so the message means that grant was refused. |
| Bootstrap stopped half-way | Fix what the message says and run `pnpm run bootstrap` again. It resumes from `.env.pending` with the same keys. `pnpm run doctor` shows "Initial setup did not finish" until then. |
| "Node.js 24 is required" | `fnm install 24 && fnm use 24` or `nvm install 24 && nvm use 24`. |
| PostgreSQL does not answer | `brew services start postgresql@17`, or open Docker Desktop and run `docker compose up -d --wait postgres`. Then run `pnpm start` again. |
| Port 3000/3001 busy but unhealthy | If the launcher started it, run `pnpm run stop`. Otherwise, find the owner with `lsof` (see above). |
| Status says "restart required" | If the launcher started the service: `pnpm run stop`, then `pnpm start`. Otherwise, stop it where you started it, then run `pnpm start`. |
| `pnpm run stop` refuses a PID | Check the process with `ps -o pid,lstart,args -p <pid>` and stop it yourself if it is ours, then run `pnpm run stop --forget`. |
| API or web app not ready in time | Read `data/logs/api.log` or `data/logs/dashboard.log`, then run `pnpm run doctor`. |

Never delete `.env` to "reset" the installation: it holds the database connection and `APP_ENCRYPTION_KEY`, which your backups need to be restored. That key does not encrypt stored data; the app relies on your disk encryption for that (see [SECURITY.md](../../SECURITY.md#data-at-rest)).

## No-AI operation

Profile editing, answer management, job discovery, ranking, application tracking, and export work without an AI account. v0.9.0 offers optional Codex integration on macOS with CLI 0.160.0. Nothing is shared until an account is connected and processing is authorized. `CAREER_AI_ENABLED=false` hides and disables execution; the legacy `AI_PROVIDER` setting no longer controls this feature. See [assistant setup and limits](assistant.md).

## Export

Use the workspace export action to download versioned JSON. It includes career facts, jobs, board records, application history, and a hash manifest. Board permissions are reset to unknown and disabled in the portable copy. The export excludes authentication material. Treat the file as sensitive personal data.

## Clean-install smoke test

`node scripts/test/setup-smoke.mjs` repeats a first installation from scratch without touching your installation:

- copies the tracked and new (not ignored) files of the checkout, as a fresh clone has them, into a private temporary directory (no `.env`, `data/`, `node_modules` or builds);
- runs `pnpm install --frozen-lockfile`, then bootstrap three times: with an administrator that cannot connect (expects the ES/EN explanation, no `.env`, a private `.env.pending`), against a same-name database it did not create (expects a refusal and that database untouched), and resuming the first attempt (expects the same keys, its own marked database closed to other roles, every migration, `.env` 0600 and private folders), then once more to check that nothing changes;
- starts the copy with the launcher on two free ephemeral ports (never 3000/3001) while `DATABASE_URL` in the shell points elsewhere, signs in through the web origin with the copy's own single-use token, runs `status`, `doctor` and the `.command` file in a Finder-like minimal shell and in a pseudo-terminal (exit codes, Enter pause, no zsh `status` error), and stops it;
- drops the `career_smoke_<hex>` databases and roles it created and removes the copy, then fails if the live `.env`, the live sign-in token, the processes on 3000/3001 or the server's list of databases and roles changed. It never connects to an existing workspace database.

The `.command` launcher checks (zsh syntax, a Finder-like shell, the terminal pause under `expect`) run only where `zsh` and `expect` exist; elsewhere, such as Linux without zsh, they are skipped and listed under `limitations` in the report, never counted as passed. The administrator may be a non-superuser with `CREATEROLE` and `CREATEDB`.

It needs a loopback PostgreSQL administrator (`SETUP_SMOKE_ADMIN_DATABASE_URL`, default `postgresql://<user>@127.0.0.1:5432/postgres`) and Node 24. `SETUP_SMOKE_KEEP=1` keeps the copy and database for debugging and prints how to remove them; `SETUP_SMOKE_REPORT=<file>` writes the evidence as JSON. Dependencies come from the pnpm store, so a warm store makes `pnpm install` take seconds; a cold, network install is not part of the test.

## Restore and operational backups

Backups and isolated restores are described in [backup-restore.md](backup-restore.md). A restore creates a new database and a new folder with its own `.env`; open it with a separate checkout and `CAREER_ENV_FILE` as shown above, never by replacing the live `.env`. Never re-enable discovery automatically after restoring data.

## Feature boundaries

Automatic read-only discovery is available after opt-in in Companies I follow; it runs while the API is running. See [automatic discovery](automatic-discovery.md). Experimental Lever assistance requires explicit consent in a visible browser; supported simple submissions require separate authorization for one application. Unsupported forms remain manual. Optional Codex processing has separate sharing consent; mailbox access and interview coaching are unavailable. Application records entered manually are user-attested; an uncertain result must be reconciled before any independent repeat action.

## Inicio rápido (español)

- Primera vez (macOS): `brew install fnm postgresql@17 && fnm install 24 && corepack enable`, `brew services start postgresql@17`, `node scripts/bootstrap.mjs` y `pnpm start`. Con Docker Desktop abierto no hace falta PostgreSQL de Homebrew.
- Qué hace la preparación: `node scripts/bootstrap.mjs` (o doble clic en `Start Career Agent Stack.command`). Instala dependencias, crea una base de datos propia para esta copia (`career_<id>`) en tu PostgreSQL 17 de Homebrew, aplica migraciones y solo al final crea `.env`. Si algo falla, te dice qué hacer en español e inglés y al repetirlo continúa donde se quedó, con las mismas claves. Nunca reutiliza la base de otra instalación ni sobrescribe un `.env` existente.
- Linux (Ubuntu): consulta la sección «Linux (Ubuntu)» de arriba. PostgreSQL 17 se instala desde el repositorio oficial PGDG, y para copiar el token necesitas `wl-clipboard` (Wayland) o `xclip` (X11). Está verificado en Ubuntu 26.04 con PostgreSQL 17, y la rama de PostgreSQL 15 se probó en esa misma máquina con un administrador que no es superusuario (servidor 15.18 del paquete npm `@embedded-postgres/linux-x64`, no de la distribución). Otras distribuciones (Fedora, Arch, Debian), X11, escritorios distintos de GNOME y WSL 2 no están verificados; si pruebas alguno, comparte el resultado en el [issue #20](https://github.com/AldereteRuben/career-agent-stack/issues/20).
- ¿Ya hay otro PostgreSQL en el puerto 5432 que no acepta tu usuario? Indica un administrador con `CAREER_ADMIN_DATABASE_URL=postgresql://USUARIO:CLAVE@127.0.0.1:5432/postgres pnpm run bootstrap`.
- ¿Dice «no puede actuar como el usuario nuevo» o «debe ser capaz de hacer SET ROLE»? Solo ocurre en PostgreSQL 16 o posterior, y significa que tu administrador no es superusuario y no pudo recibir `SET` sobre el rol nuevo. Como superusuario ejecuta `GRANT <rol del mensaje> TO <tu administrador> WITH SET TRUE;` y repite `pnpm run bootstrap`: retoma con las mismas claves.
- Cada día: doble clic en `Start Career Agent Stack.command` o `pnpm start`. Reutiliza lo que ya funciona, inicia lo que falta, espera a que responda y abre el navegador. Si falla, la ventana espera a que pulses Enter para que puedas leer el mensaje.
- Estado sin cambiar nada: `pnpm run status`. Termina con error si falta algo o si un servicio necesita reiniciarse para usar la última versión. Diagnóstico: `pnpm run doctor`. Detener lo que inició el lanzador: `pnpm run stop`.
- ¿Te pide un token? `pnpm start --copy-token` lo copia al portapapeles sin mostrarlo y lo borra de ahí a los 2 minutos; el archivo `.command` lo hace siempre. Si ya no tienes token, ejecuta antes `pnpm run reset:session`. Tus datos no cambian. Las sesiones ya abiertas siguen válidas hasta que caducan.
- ¿Abrir una instalación restaurada? En otra copia del código (`git worktree add ../career-restored`): `CAREER_ENV_FILE=/ruta/restaurada/.env pnpm start --copy-token`. Nunca copies nada sobre el `.env` activo.
- Los registros están en `data/logs/` (o en la carpeta de datos de `CAREER_ENV_FILE`).

## Updating to v0.9.1 / Actualizar a v0.9.1

From v0.9.0, create a verified backup, stop the local services, update the checkout, run `pnpm install --frozen-lockfile`, then `pnpm start`. There is no new migration. Existing data, PDFs, connections and permissions are retained. Review the [v0.9.1 corrections and verification](../releases/v0.9.1.md). Repeated starts wait for the active launcher; `pnpm start --copy-token` reuses healthy services.

Desde v0.9.0: crea una copia verificada, detén los servicios, actualiza el código, ejecuta `pnpm install --frozen-lockfile` y después `pnpm start`. No hay migraciones nuevas. Se conservan datos, PDF, conexiones y permisos. Los inicios simultáneos esperan su turno.

## Updating to v0.9.0 / Actualizar a v0.9.0

Create a verified backup before updating. Stop the service, update the checkout and dependencies, then start it normally. Startup applies additive migration 0010, retaining existing profile facts, answers, searches and PDFs. AI starts disconnected and analysis automation stays off. No Codex account or installation is required for ordinary searches. Use the contextual help or Settings to opt in; [assistant setup](assistant.md) records the supported CLI version and operating system.

A restored copy revokes assistant connections and sharing permissions, pauses analysis policies, and cancels or interrupts pending work. Historical suggestions remain readable. Reconnect and explicitly choose new automation settings if you want to resume. To roll back, restore the verified backup into a separate destination; do not run an old binary against the upgraded database.

Crea un respaldo verificado antes de actualizar. Detén el servicio, actualiza código y dependencias y vuelve a iniciarlo. La migración aditiva 0010 conserva perfil, respuestas, búsquedas y PDF. La IA empieza desconectada y sin análisis automático. Una copia restaurada revoca conexiones y permisos, pausa automatizaciones y conserva las propuestas históricas; volver a procesar requiere autorización nueva.

## First use after updating to v0.8.2

The app opens directly in **Find jobs**, with two initial fields: role and optional location. Choose **Find jobs** to check now and repeat daily while Career Stack runs on your computer. Company and work mode are under **Add company or work mode**; sources, frequency and preparation settings are under **Search options**. Restored nondefault criteria reveal their controls so they are not applied invisibly.

The main menu has **Find jobs**, **Saved jobs** and **My applications**. **Profile and tools** contains the profile, resumes, all jobs, followed companies, settings and the previous overview. Existing direct links still work. A job offers **Save job** near its title and a guided application action; detailed fit analysis is optional.

ES: la app abre en **Buscar empleo**. Indica un puesto, añade ubicación si quieres y pulsa **Buscar ofertas**. Consultará ahora y cada día mientras Career Stack siga funcionando en tu equipo. Empresa y modalidad están en **Añadir empresa o modalidad**; portales, frecuencia y preparación en **Opciones de búsqueda**. Los filtros no predeterminados recuperados de un borrador se muestran para que puedas revisarlos.

ES: el menú principal contiene **Buscar empleo**, **Guardadas** y **Mis solicitudes**. **Perfil y herramientas** reúne perfil, CV, todas las ofertas, empresas seguidas, ajustes y resumen. Los enlaces anteriores siguen funcionando. Guarda una oferta junto a su título o continúa con la preparación guiada; el análisis de encaje es opcional.

Updating from v0.8.0 or v0.8.1 requires no new configuration or data migration. Restart the local service after updating. Existing searches keep their sources, schedule and permissions; no application is submitted by searching or saving a job.

ES: actualizar desde v0.8.0 o v0.8.1 no requiere configuración ni migraciones nuevas. Reinicia el servicio local después de actualizar. Las búsquedas conservan sus fuentes, frecuencia y permisos; buscar o guardar una oferta no envía solicitudes.

## Updating to v0.8.0 / Actualizar a v0.8.0

Create and verify a backup with `pnpm backup` before starting the updated installation. `pnpm start` applies additive migration 0009. Existing searches keep their original rules and sources; choose enhanced matching to opt in. A restored backup disables schedules, preparation and pending search runs. Recover an older installation from its verified backup into a separate destination; running the old binary against the new schema is not a rollback.

Crea y verifica una copia con `pnpm backup` antes de iniciar la actualización. `pnpm start` aplica la migración aditiva 0009. Las búsquedas existentes conservan reglas y fuentes; puedes aceptar las mejoras desde su edición. Una copia restaurada desactiva agendas, preparación y ejecuciones pendientes. Para recuperar una instalación anterior, restaura su respaldo en un destino separado; usar el binario anterior con el esquema nuevo no revierte la migración.
