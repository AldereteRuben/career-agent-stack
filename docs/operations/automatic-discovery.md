# Automatic job discovery / Búsqueda automática

## Saved role/company searches — v0.7.0

**English:** Open **Find jobs**, enter a role, company or both, optionally choose location and work mode, then save the search. The local service reads the public Remotive and Arbeitnow listings and filters their results. No employer URL or API key is required. Select a 6, 12 or 24 hour schedule; pause or edit it from the saved search. Closing the browser does not stop checks, but the local service and computer must stay on.

Coverage is limited to the listings these sources expose. Remotive covers remote roles and delays its public feed by 24 hours. Arbeitnow emphasizes European listings. Missing or broad location restrictions need review on the original listing. This does not search LinkedIn or the entire web. Results keep source attribution and links; they are not guarantees of eligibility or current availability. “New” means first found by this installation.

Each provider is read at most once per six hours across searches/workspaces. Repeated refreshes reuse its saved feed. Source failures retain earlier results, label reduced freshness/coverage and apply backoff. Searches, schedules and matched jobs persist across restarts. Restoring a backup pauses searches and disables preparation until you enable it again.

**Español:** En **Buscar empleo**, escribe un puesto, una empresa o ambos, y opcionalmente una ubicación y modalidad. Guarda la búsqueda y elige cada 6, 12 o 24 horas. La app consulta Remotive y Arbeitnow y filtra sus resultados sin pedirte enlaces de empresas ni claves. Puedes pausar o editar cada búsqueda. Cerrar la pestaña no detiene las consultas; apagar el equipo o el servicio local sí.

La cobertura depende de esas fuentes: Remotive publica puestos remotos con 24 horas de retraso y Arbeitnow se centra en Europa. Revisa las restricciones de ubicación en la oferta original. No se busca en LinkedIn ni en todo internet. Se conservan las ofertas previas si falla una fuente, y se avisa de resultados antiguos o incompletos. Al restaurar una copia, las búsquedas quedan pausadas y sin preparación automática.

## Optional application preparation

Turn on **Prepare applications** for a saved search to produce review drafts for matches. The service selects existing approved profile facts and approved saved answers; it does not invent qualifications or use a language model. A name, email and confirmed experience are required for a PDF. Missing details appear in **Prepared applications** with links to fix the profile. Documents await approval and are never sent by the search worker.

Repeated preparation with the same inputs reuses the draft. Changed profile content regenerates on the same application while preserving previous PDF files. Approved/user-selected documents and submitted, uncertain or closed applications are protected. A job from an aggregator may need its direct employer application URL before Lever assistance is available.

Activa **Preparar candidaturas** para obtener borradores con la experiencia confirmada y respuestas aprobadas. Los datos pendientes aparecen en **Candidaturas preparadas**. Revisa y aprueba el PDF antes de usarlo. Esta opción no autoriza envíos. Los enlaces de un agregador pueden necesitar el enlace directo al formulario de la empresa para usar la asistencia de Lever.

## Individually followed companies

The existing employer-board schedule remains independent of saved role/company searches:


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

## v0.8 enhanced searches / Búsquedas mejoradas

New searches use versioned matching and a persistent queue. Saving returns before external sources or PDF generation finish. Each run records the criteria revision, lease owner and per-source progress. Editing or pausing fences older results; interrupted reservations can be reclaimed. Source caches and provider request budgets survive a restart.

Las búsquedas nuevas usan reglas versionadas y una cola persistida. Guardar responde antes de esperar a las fuentes o generar PDFs. Cada ejecución conserva revisión, reserva y progreso por fuente. Editar o pausar invalida publicaciones anteriores; las reservas vencidas pueden recuperarse. Reiniciar conserva cachés y presupuestos.

Himalayas uses one bounded canonical query, preserving explicit role modifiers, and at most three pages. Known Spanish/English equivalent role phrases can share a provider query; the original full criteria are checked locally. Query caches last 24 hours, unused entries expire after seven days, and detailed operational history is retained for thirty days while preserving the latest useful published results. Confirmed company boards are read from local snapshots; this does not grant access to unconfirmed companies or schedule duplicate provider reads.

Himalayas usa una consulta canónica acotada y hasta tres páginas, conservando los modificadores del puesto. Las equivalencias conocidas ES/EN pueden compartir consulta; los criterios originales completos se comprueban localmente. Su caché dura 24 horas y las entradas sin uso caducan tras siete días. La actividad detallada se conserva treinta días, manteniendo los últimos resultados útiles. Las empresas confirmadas se leen desde sus datos locales; esto no autoriza empresas sin confirmar ni duplica consultas externas.

Review state belongs to each search. Saving/archiving belongs to the underlying job. Strong duplicates may share an action only when historical decisions/applications are unambiguous. Historical IDs, PDFs and application records are preserved. Failed or bounded feeds never close missing listings.

La revisión pertenece a cada búsqueda; guardar o archivar pertenece a la oferta. Las repeticiones con identidad fuerte solo comparten acciones si no hay decisiones o candidaturas históricas contradictorias. Los IDs, PDFs y solicitudes se conservan. Una fuente fallida o limitada nunca cierra ofertas ausentes.
