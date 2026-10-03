# Career Agent Stack

Tu espacio privado para buscar ofertas automáticamente, preparar candidaturas con tu experiencia confirmada y seguir cada postulación.

[English](README.md) · **Español**

**Versión actual: v0.7.1** · [Cambios](CHANGELOG.md) · [Verificación y límites](docs/releases/v0.7.1.md)

Ayuda de acceso: en macOS, abre `Start Career Agent Stack.command` y pega el código copiado. Si ya lo usaste, abre `Recover Career Agent Stack.command` para crear y copiar uno nuevo. Conserva tus datos y las sesiones abiertas. Desde una terminal en una instalación compatible, utiliza `pnpm start --recover-session --copy-token`.


La interfaz está disponible en **español e inglés**. Cada persona utiliza una instalación independiente, con su propia base de datos y claves. No es un servicio compartido en la nube.

## Qué puedes hacer

- Completar experiencia laboral y formación con fechas editables; corregir, archivar y confirmar los datos que se usan en tu CV.
- Mantener respuestas reutilizables con su pregunta y contexto de país.
- Guardar búsquedas por puesto o empresa y encontrar coincidencias automáticamente en Remotive y Arbeitnow. También puedes añadir ofertas manualmente o seguir empresas de Greenhouse, Lever y Ashby.
- Entender el encaje de una vacante con tus preferencias y hechos aprobados.
- Generar, visualizar, revisar y descargar versiones de tu CV. Reutilizar contenido tras cambiar tu perfil sin alterar los PDF anteriores.
- Registrar candidaturas, notas y etapas del proceso, con historial de correcciones.
- Exportar tu espacio en JSON o crear una copia verificada de la base de datos y los PDF, con restauración aislada.

No necesitas una suscripción de IA ni una clave de API. La app prepara candidaturas con datos aprobados de tu perfil e incluye **asistencia experimental en Lever**, con navegador visible. Una autorización adicional para una sola candidatura permite adjuntar el PDF aprobado y enviar un formulario sencillo reconocido. CAPTCHA, declaraciones legales, preguntas no compatibles y formularios desconocidos requieren intervención manual. No hay envío desatendido de candidaturas, acceso al correo ni preparación de entrevistas. La puntuación refleja cobertura de evidencia; no es una probabilidad de contratación ni una puntuación ATS.

## Preparar una candidatura

Abre una oferta y elige **Preparar CV para esta vacante**. Los pasos **Tu perfil → Preparar CV → Revisar y solicitar** conservan la oferta mientras completas tus datos. Elige el idioma del PDF, revisa su vista previa con zoom y aprueba la versión. **Continuar con esta solicitud** guarda el CV elegido en ella; podrás descargarlo o cambiarlo antes del envío.

En las ofertas puedes buscar por puesto o empresa, filtrar favoritas y disponibilidad, y archivar o restaurar las que quieras. El idioma del PDF cambia encabezados y etiquetas de fechas: tus descripciones no se traducen automáticamente.

## Búsqueda automática de ofertas

1. Abre **Buscar empleo**. Indica un puesto, una empresa o ambos; ubicación y modalidad son opcionales.
2. Guarda tu búsqueda y elige cada 6, 12 o 24 horas. Puedes editarla o pausarla después.
3. Las fuentes integradas son **Remotive** y **Arbeitnow**. No necesitas enlaces de empresas ni claves. Su cobertura es parcial: ofertas remotas y principalmente europeas; Remotive retrasa su catálogo público 24 horas. Cada resultado enlaza a su fuente.
4. Opcionalmente activa **Preparar documentos para nuevas coincidencias**. La app selecciona experiencia confirmada y genera candidaturas para revisar en **Candidaturas preparadas**. Si faltan datos, indica qué completar.
5. Mantén el servicio local encendido. Puedes cerrar la pestaña; el equipo suspendido o apagado no puede buscar.

Las fuentes comparten resultados durante seis horas para evitar consultas repetidas. **Actualizar ahora** reutiliza esos resultados cuando todavía están vigentes; no fuerza peticiones ilimitadas. Las búsquedas restauradas desde una copia quedan pausadas y sin preparación automática. Las empresas de Greenhouse, Lever y Ashby que ya sigues conservan su programación independiente. [Funcionamiento y límites](docs/operations/automatic-discovery.md).

## Solicitudes asistidas

Abre **Candidaturas preparadas** para revisar el PDF generado y los datos pendientes. En una candidatura de Lever, sigue **Revisar datos → Revisar navegador** y elige continuar manualmente o autorizar por separado el envío compatible. Necesitas un CV aprobado y vigente. Los resultados inciertos bloquean otro intento hasta que los compruebes. Las páginas públicas de Lever inspeccionadas para esta versión requirieron intervención manual; no se ha verificado un envío a una empresa real. Consulta [el recorrido y sus límites](docs/operations/assisted-applications.md).

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
2. Desde **Inicio**, abre **Guía para empezar**. Guarda tu nombre y correo; las preferencias de empleo pueden esperar.
3. Sigue la guía para añadir y confirmar una experiencia y preparar y revisar tu primer PDF. Puedes volver cuando quieras: el progreso se calcula con lo que has guardado.
4. En **Buscar empleo**, guarda tu primera búsqueda. También puedes añadir una oferta manualmente desde **Ofertas guardadas**.
5. Abre la oferta y elige **Preparar CV para esta vacante**. Completa tu perfil, selecciona el contenido y el idioma del PDF y revisa la vista previa.
6. Aprueba el CV y pulsa **Continuar con esta solicitud**. El CV queda vinculado a ella. En **Mis solicitudes**, registra avances y notas; la asistencia de Lever requiere una autorización separada y los formularios no compatibles se completan manualmente en la web de la empresa.

La preparación del CV conserva nombre, idioma y selección por oferta en esta pestaña, para que puedas volver después de editar tu perfil. Es temporal: se borra al cerrar sesión y puede perderse al cerrar la pestaña; genera el PDF para guardar una versión. Si cambian los datos seleccionados, la app te pide revisarlos. Al volver de una oferta a la lista, se conservan la búsqueda y los filtros.

Para guardar una copia, abre **Ajustes y privacidad → Crear copia de seguridad** y descarga tanto la copia verificada como su clave. Descárgalas antes de reiniciar la app o crear otra copia. Los originales quedan en `data/backups/<id>/` (la clave en `keys/`). Restaurar todavía requiere la terminal; las copias antiguas no se eliminan automáticamente.

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
- Las fuentes externas necesitan una revisión explícita de la empresa y del permiso de lectura pública. Las búsquedas guardadas utilizan los catálogos públicos integrados; las empresas que sigues necesitan revisión. No cubrimos todo el mercado laboral.
- Las copias incluyen la base de datos y los PDF, con huellas y un manifiesto firmado. La restauración necesita el archivo de clave separado y crea una base y carpeta nuevas; nunca sobrescribe un espacio existente. El archivo **no está cifrado**. Consulta la [guía de recuperación](docs/operations/backup-restore.md).
- La instalación completa, recuperación y uso en navegador se han comprobado en macOS. CI comprueba compilación y lógica en Linux y Windows; eso no valida sus instalaciones completas. El lanzador depende de utilidades de procesos Unix: el inicio y cierre nativos en Windows no están soportados. La instalación en Linux/WSL sigue sin validación de extremo a extremo.

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

Las pruebas E2E usan servicios privados, datos ficticios y una base desechable. Necesitan un usuario local que pueda crear bases de datos o `E2E_ADMIN_DATABASE_URL`. Consulta la [guía E2E](docs/operations/e2e-testing.md). Se realizan comprobaciones de solo lectura para verificar que el espacio real no cambió. `pnpm run test:backup` comprueba archivos de copia sin base de datos. `pnpm run test:integration` comprueba copia y restauración con bases desechables si defines `CAREER_BACKUP_TEST_ADMIN_URL`; sin esa variable, la suite se omite. `pnpm run test:setup` recorre una instalación limpia con un administrador local. `pnpm run test:assisted` comprueba el nuevo flujo; su suite de base de datos requiere `CAREER_ASSIST_TEST_ADMIN_URL`. `runner` explica dónde autorizar desde la interfaz. `test:evals` sigue pendiente.

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

## Comunidad y contribuciones

Aceptamos issues, propuestas, traducciones y pull requests en español o inglés. Consulta [cómo contribuir](CONTRIBUTING.md), [convivencia](CODE_OF_CONDUCT.md) y [reportes de seguridad](SECURITY.md).

## Licencia

Uso no comercial gratuito bajo [PolyForm Noncommercial 1.0.0](LICENSE), con un [permiso adicional para tu propia búsqueda de empleo](LICENSE-PERSONAL-USE.md), aunque busques empleo remunerado. Puedes clonar, adaptar y compartir el proyecto para los fines permitidos conservando la licencia y los avisos. La venta, el alojamiento de pago y su reutilización en productos u operaciones comerciales no están autorizados, con las excepciones expresas de la licencia estándar para organizaciones no comerciales. Estas incluyen determinadas instituciones benéficas, educativas y gubernamentales independientemente de su financiación.

Es **código disponible con restricciones no comerciales** (*source available*). No es open source aprobado por la OSI. La licencia establece condiciones legales; no impide técnicamente las copias ni garantiza que puedan perseguirse todas las infracciones. Tus CV y demás documentos profesionales siguen siendo tuyos; esta licencia de software no concede derechos sobre tus datos personales.

Los componentes de terceros conservan sus [propias licencias y avisos](THIRD_PARTY_NOTICES.md). Estos términos acompañan al código actual; los archivos de versiones anteriores no los incluían. La versión v0.3.0 incluye la licencia y los términos de contribución.

[Preparación del repositorio público](docs/operations/public-repository.md).
