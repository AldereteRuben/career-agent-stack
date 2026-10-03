# Career Agent Stack

Tu espacio privado para organizar la búsqueda de empleo: perfil profesional, vacantes, borradores PDF y seguimiento de candidaturas.

[English](README.md) · **Español**

**Versión actual: v0.2.0** · [Cambios](CHANGELOG.md) · [Verificación y límites](docs/releases/v0.2.0.md)

La interfaz está disponible en **español e inglés**. Cada persona utiliza una instalación independiente, con su propia base de datos y claves. No es un servicio compartido en la nube.

## Qué puedes hacer

- Guardar tu perfil, preferencias y hechos profesionales que apruebas explícitamente.
- Mantener respuestas reutilizables con su pregunta y contexto de país.
- Añadir vacantes manualmente o consultar fuentes de Greenhouse, Lever y Ashby revisadas individualmente.
- Entender el encaje de una vacante con tus preferencias y hechos aprobados.
- Generar, visualizar, revisar y descargar distintas versiones de un PDF.
- Registrar candidaturas, notas y etapas del proceso, con historial de correcciones.
- Exportar tu espacio en JSON o crear una copia verificada de la base de datos y los PDF, con restauración aislada.

No necesitas una suscripción de IA ni una clave de API. La versión 0.2 **no envía candidaturas**, no rellena sitios de empresas, no conecta con tu correo ni prepara entrevistas. La puntuación refleja cobertura de evidencia; no es una probabilidad de contratación ni una puntuación ATS.

## Empieza aquí

### 1. Instala los requisitos

- **Git**, para descargar el repositorio.
- **Node.js 24**; se desarrolló con 24.18.x y la versión está indicada en `.node-version`.
- **pnpm 11.10.0**: después de instalar Node, ejecuta `npm install -g pnpm@11.10.0`.
- **PostgreSQL 17**, instalado mediante Homebrew en macOS (`brew install postgresql@17 && brew services start postgresql@17`) o mediante Docker con Compose. Si utilizas Docker, abre Docker Desktop antes de preparar la app. La instalación limpia se verificó con PostgreSQL de Homebrew; la ruta Docker aún no se ha validado de extremo a extremo.

Si ya tienes PostgreSQL 17, puedes utilizarlo sin Docker, la preparación puede crear una base y un usuario propios mediante una conexión de administrador local. Para otro servidor, indica `CAREER_ADMIN_DATABASE_URL`; para una base que ya preparaste, indica `CAREER_DATABASE_URL`. Consulta la [guía de configuración y recuperación](docs/operations/local-setup.md). Si el puerto 5432 ya está ocupado por otra base de datos, configura esa conexión antes de continuar.

### 2. Descarga y prepara el proyecto

```bash
git clone https://github.com/AldereteRuben/career-agent-stack.git
cd career-agent-stack
pnpm install --frozen-lockfile
pnpm run bootstrap
```

Si el repositorio es privado, tu cuenta necesita acceso y Git debe estar autenticado. También puedes usar `gh repo clone AldereteRuben/career-agent-stack` después de `gh auth login`.

La preparación crea un `.env` privado con claves nuevas, crea una base de datos y credenciales propias para esta instalación, aplica las migraciones e instala Chromium para generar PDF. Conserva un `.env` existente y no añade datos de ejemplo. Si se interrumpe, retoma las claves de `.env.pending`; `.env` se finaliza cuando la preparación termina correctamente. La instalación inicial necesita conexión a internet.

### 3. Abre tu espacio

```bash
pnpm start --copy-token
```

Si el navegador no se abre, entra en [http://127.0.0.1:3000](http://127.0.0.1:3000). En macOS, el token de acceso pendiente se copia al portapapeles: pégalo en la pantalla de inicio. Se utiliza una sola vez. Si tu sistema no permite copiar automáticamente, abre el archivo local `data/setup-token` y copia su contenido. No lo compartas ni lo pegues en una incidencia.

Después de la preparación inicial, en macOS puedes abrir **Start Career Agent Stack.command** con doble clic. El primer arranque compila la aplicación y puede tardar un momento.

### 4. Primer recorrido

1. Elige **Español** o **English** con el botón de idioma.
2. En **Mi perfil**, completa tus datos y preferencias de empleo y guarda.
3. Añade hechos profesionales y aprueba los que hayas comprobado.
4. En **Vacantes**, añade una oferta manualmente. Configurar fuentes externas es opcional.
5. Prepara un PDF con hechos aprobados y revísalo antes de aprobar esa versión.
6. En **Candidaturas**, registra avances y notas. El envío se realiza manualmente en la web de la empresa.

## Uso diario

Ejecuta los comandos desde la carpeta del proyecto:

| Comando | Para qué sirve |
| --- | --- |
| `pnpm start` | Inicia lo que falta, reutiliza servicios sanos y abre la app. |
| `pnpm start --copy-token` | Además, copia el token pendiente si el sistema lo permite. |
| `pnpm start --no-open` | Inicia sin abrir el navegador. |
| `pnpm run status` | Comprueba servicios y si hace falta reiniciar. |
| `pnpm run stop` | Detiene la API y la web iniciadas por el lanzador; conserva datos. |
| `pnpm run reset:session` | Genera otro token; no revoca sesiones ya abiertas. |
| `pnpm run backup` | Crea y verifica una copia de la base de datos y documentos. |
| `pnpm run restore --help` | Explica cómo verificar o restaurar una copia en un espacio nuevo. |
| `pnpm run doctor` | Revisa la configuración local. |

### Actualizar

```bash
pnpm run stop
git pull --ff-only
pnpm install --frozen-lockfile
pnpm start
```

Al iniciar una API detenida se aplican las migraciones pendientes y se recompila el código modificado. Si arrancaste los servicios manualmente, detenlos en su terminal original. Mantén una copia independiente antes de actualizar una instalación con datos importantes.

## Si algo falla

| Problema | Siguiente paso |
| --- | --- |
| No encuentra Node o pnpm | Instala los requisitos y vuelve a abrir el terminal. |
| PostgreSQL no responde | Abre Docker Desktop y repite `pnpm run bootstrap`. Si usas una base existente, revisa `DATABASE_URL`, usuario y base de datos. |
| Ya no queda token | Ejecuta `pnpm run reset:session` y después `pnpm start --copy-token`. |
| No aparecen los cambios | Ejecuta `pnpm run stop`, `pnpm run build` y `pnpm start`. |
| Puerto 3000, 3001 o 5432 ocupado | Identifica qué programa lo usa; consulta la [guía de recuperación](docs/operations/local-setup.md). |
| No inicia la aplicación | Ejecuta `pnpm run doctor` y consulta `data/logs/`. Elimina información sensible antes de compartir registros. |

## Datos y límites actuales

- Los servicios escuchan en `127.0.0.1`. No los expongas a la red como servicio multiusuario.
- `.env`, `data/`, exportaciones y copias deben permanecer privados y están excluidos de Git. **No borres `.env` para reiniciar la app**: contiene la clave de cifrado.
- PostgreSQL almacena los registros; `data/files/` contiene los documentos. Docker utiliza el volumen persistente `career-postgres`: no lo elimines para resolver un problema de arranque.
- Las fuentes externas necesitan una revisión explícita de la empresa y del permiso de lectura pública. Solo se consultan las fuentes configuradas, no todo el mercado laboral.
- Las copias incluyen la base de datos y los PDF, con huellas y un manifiesto firmado. La restauración necesita el archivo de clave separado y crea una base y carpeta nuevas; nunca sobrescribe un espacio existente. El archivo **no está cifrado**. Consulta la [guía de recuperación](docs/operations/backup-restore.md).
- La verificación local se realizó en macOS. Otros sistemas aún no tienen la misma validación de extremo a extremo.

## Guarda una copia de tu trabajo

En macOS, abre **Backup Career Agent Stack.command** con doble clic, o ejecuta `pnpm run backup`. Espera a que termine la verificación y guarda el archivo y su clave separada en ubicaciones privadas. Se necesitan las herramientas PostgreSQL `pg_dump` y `pg_restore`, versión 17 o compatible con tu servidor. La [guía de recuperación](docs/operations/backup-restore.md) explica su instalación y cómo restaurar.

## Desarrollo y pruebas

Next.js y React para la interfaz, Fastify para la API, TypeScript, PostgreSQL con Drizzle y Playwright para PDF y pruebas de navegador.

```bash
pnpm run dev
pnpm run build
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:e2e
pnpm run test:sources # pruebas de adaptadores, sin red
```

Las pruebas E2E usan servicios privados, datos ficticios y una base desechable. Necesitan un usuario local que pueda crear bases de datos o `E2E_ADMIN_DATABASE_URL`. Consulta la [guía E2E](docs/operations/e2e-testing.md). Se realizan comprobaciones de solo lectura para verificar que el espacio real no cambió. `pnpm run test:backup` comprueba archivos de copia sin base de datos. `pnpm run test:integration` comprueba copia y restauración con bases desechables si defines `CAREER_BACKUP_TEST_ADMIN_URL`; sin esa variable, la suite se omite. `pnpm run test:setup` recorre una instalación limpia con un administrador local. `test:evals` y `runner` siguen pendientes.

Consulta los proveedores y las fuentes públicas reales comprobadas en la [validación de fuentes](docs/operations/source-validation.md). `pnpm run verify:sources --live` habilita explícitamente una nueva comprobación de solo lectura; no activa fuentes en tu espacio.

## Estructura

| Carpeta | Contenido |
| --- | --- |
| `apps/dashboard` | Interfaz bilingüe. |
| `apps/api` | API local, PDF y pruebas E2E. |
| `packages/domain` | Contratos, encaje y transiciones de estados. |
| `packages/db` | Esquema y migraciones. |
| `scripts` | Preparación, arranque y diagnóstico. |
| `docs` | Alcance y operación. |

Más información: [seguridad](SECURITY.md), [componentes de terceros](THIRD_PARTY_NOTICES.md) y [especificación](docs/implementation-brief.md). La especificación describe una intención de producto más amplia; las funciones y límites de esta página corresponden a la versión actual.

## Licencia

Todavía no se ha elegido una licencia. El repositorio no concede actualmente una licencia de código abierto.
