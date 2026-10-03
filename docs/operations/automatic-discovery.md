# Automatic discovery / Búsqueda automática — v0.6.0

## Use it / Cómo usarla

**English:** Add companies and confirm their official board links in Companies I follow, then choose Turn on automatic search. Set your target roles and preferences in My profile to improve fit ordering. Home links to New to review, where newly discovered jobs are ranked by fit. Open a job, read the matching explanation, and mark it as reviewed when finished. Reviewing does not create or submit an application. Reviewed jobs remain in Active unless you archive them.

**Español:** Añade empresas y confirma sus enlaces oficiales en Empresas que sigo. Después pulsa Activar búsqueda automática. Indica los puestos y preferencias en Mi perfil para ordenar el encaje. Inicio enlaza a Nuevas por revisar, donde se ordenan las ofertas descubiertas por encaje. Abre una oferta, lee la explicación y márcala como revisada al terminar. Revisar no crea ni envía una solicitud. Las revisadas siguen en Activas salvo que las archives.

## Timing and controls / Horarios y controles

- The local API checks for due companies every five seconds, processing one company at a time. Successful checks schedule the next run six hours later plus up to five minutes of jitter. Manual checks share the same limits and locks.
- Activity by company shows the last attempt, number of new jobs, incomplete/failed reads and the next scheduled attempt. Dates are displayed in the browser's local time. Counts are new saved records, not a promise of suitable vacancies.
- The service runs independently of the browser tab. The computer and local API must remain running. Nothing installs an operating-system startup service or wakes a sleeping computer.
- Schedules are stored in PostgreSQL. On restart/resume, overdue companies run once, spread across ticks; missed intervals are not replayed. An interrupted attempt reserves its interval, preventing rapid duplicate requests after a crash.
- Pause stops new scheduled checks. An already-started request may finish. Manual checks remain available when the schedule is paused. Disabling a company or letting its confirmation expire excludes it from subsequent automatic checks.
- Activating includes all currently confirmed companies and those you confirm later. No unconfirmed company is queried. Fresh installs, upgrades from before v0.6 and restored backups start paused. Existing enabled v0.6 schedules persist during ordinary restarts.

**Español:** La app consulta cada empresa aproximadamente cada seis horas mientras esté encendida. Puedes cerrar la pestaña. En Actividad por empresa se muestran el último intento, las novedades, los fallos y la próxima consulta, con la hora de tu navegador. Al pausar no comienza otra consulta, aunque una ya iniciada puede terminar. Puedes seguir consultando manualmente. Las empresas nuevas entran en la programación solo después de confirmarlas. Reiniciar conserva la programación; restaurar una copia la pausa. Una consulta interrumpida espera su siguiente horario para evitar repeticiones rápidas.

## Failure handling and scope / Fallos y alcance

- The existing public-read adapters for Greenhouse, Lever and Ashby are reused, with fixed approved API hosts, no redirects, response size caps and request timeouts.
- Failures persist a safe error code and use 6/12/24/48-hour retry delays, honoring a longer valid Retry-After supplied by the provider. A successful read resets the failure count. Manual actions cannot bypass this window.
- Partial or failed reads never close or delete saved jobs. This version does not infer that a job is closed because it disappears from a feed; verify availability with the employer.
- New-to-review means first discovered by a company check after this upgrade (manual or automatic), not newly published. Existing saved jobs are not retroactively labelled new. Provider dates remain in the job detail.
- Duplicate discoveries preserve review/favorite/archive state and reuse unchanged snapshots. Ranking uses existing profile/evidence rules; it does not hide low-scoring jobs or imply hiring probability.
- No AI service, whole-web search, CV transfer, email access or submission is performed by this worker.

**Español:** Los fallos retrasan los reintentos y se respeta la espera que indique la fuente. Las ofertas guardadas se conservan. Una lectura incompleta no marca ofertas como cerradas. «Nueva» significa descubierta por primera vez desde esta actualización, no recién publicada; las consultas manuales también pueden descubrir novedades. El encaje ayuda a ordenar, no garantiza una contratación. Este proceso no utiliza IA, consulta correo ni transmite tu CV.

## Verification

`pnpm run test:discovery` uses a newly created disposable PostgreSQL database and fictional injected source feeds. Set `CAREER_DISCOVERY_TEST_ADMIN_URL` to a loopback maintenance database (postgres/template1), never the real application database. The suite checks defaults, locking/cooldown, pause/resume, permissions, repeated and partial reads, durable retries, restart state and workspace scoping.

`pnpm run test:e2e` uses the existing isolated stack. The v060 scenario exercises real activation/pause endpoints, persistence on reload, the new-job filter, explicit review, English/Spanish and mobile layouts. Company schedules are held in the future, so this browser scenario never contacts real employers. Provider parsing and network limits have separate synthetic tests. These checks do not claim real-employer submission coverage.
