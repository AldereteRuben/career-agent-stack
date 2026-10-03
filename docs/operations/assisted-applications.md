# Assisted applications / Solicitudes asistidas

## Español

Disponible de forma experimental para páginas de empleo alojadas en **Lever** (global y UE). Necesitas un escritorio local y Chromium instalado por `pnpm run bootstrap`. No necesitas configurar claves de Lever ni servicios de IA.

1. Completa tu nombre y correo en **Mi perfil**. Revisa tus hechos, genera un CV y apruébalo en **Documentos**.
2. Abre una candidatura cuyo enlace original sea de Lever. Desde una vacante también puedes elegir **Empezar seguimiento**.
3. En **Solicitud asistida**, elige el CV e introduce teléfono y empresa actual solo si quieres rellenarlos. Pulsa **Revisar datos y destino**.
4. Lee el destino exacto y los valores. Marca la autorización y pulsa **Abrir y autocompletar**. Caduca tras diez minutos y se usa una sola vez.
5. Revisa la ventana visible de Chromium. El adaptador solo rellena campos de contacto reconocidos; no adjunta el CV ni acepta condiciones. La conexión está pausada durante esta revisión.
6. Si el formulario es compatible, puedes autorizar por separado **Adjuntar el CV y enviar esta solicitud**. La autorización incluye el destino, los contactos y el PDF aprobado; sirve una sola vez. Un resultado incierto requiere comprobarlo antes de otro intento.
7. Para continuar manualmente, descarga el CV. Marca la revisión y pulsa **Tomar el control de la ventana**. Desde ese momento el sitio puede guardar o transmitir datos, incluso antes del envío final.
8. En esa misma ventana, adjunta el CV, responde las preguntas, resuelve CAPTCHA y envía tú. Si recargas, revisa de nuevo todos los campos.
9. Vuelve a la app y registra qué comprobaste: enviada, no enviada o resultado incierto. Se cierra la ventana. La confirmación se guarda como tu declaración.

Si el resultado es incierto, compruébalo en la página o en tu correo antes de repetir. La app bloqueará otro intento hasta que lo aclares. No autoriza reintentos automáticos. Si el perfil o el CV cambian, cierra el intento, comprueba el resultado y prepara una autorización nueva.

**El envío automático es experimental y se limita a formularios sencillos reconocidos de Lever, con autorización individual.** No funciona con CAPTCHA, autenticación, declaraciones legales sin revisar, preguntas adicionales ni cargas de archivos que necesiten un flujo no reconocido. Otros ATS no están incluidos. Para un formulario desconocido se ofrece continuar manualmente. No se guardan cookies, capturas ni sesiones del navegador. El historial de intentos sí contiene datos personales y se incluye en exportaciones y copias privadas.

## English

Experimental support covers **Lever-hosted job pages**, global and EU. You need a local desktop and Chromium installed by `pnpm run bootstrap`. No Lever API key or AI service is required.

1. Save your name and email in **My profile**. Review facts, generate a resume and approve it in **Documents**.
2. Open an application with a Lever original URL, or choose **Start tracking** from a job.
3. In **Assisted application**, select the resume and optionally provide phone/current company. Choose **Review data and destination**.
4. Review the exact URL and values, give consent, then choose **Open and autofill**. Consent expires after ten minutes and works once.
5. Inspect the visible Chromium window. Only recognized contact fields are filled; files and legal checkboxes are untouched. Its connection is paused during review.
6. If the form is supported, you can separately authorize **Attach the resume and submit this application**. Authorization covers the destination, contact values and approved PDF and is consumed once. Uncertain outcomes require reconciliation before another attempt.
7. To continue manually, download the selected resume, confirm your review, and **Take control of the window**. The employer site can now save or transmit data before final submission.
8. Attach the resume, complete questions, handle CAPTCHA and submit yourself in that same window. Recheck all fields if you reload.
9. Return to the app and record what you checked: submitted, not submitted, or uncertain. The window closes. Confirmation is your statement, not independent employer verification.

An uncertain result blocks another attempt until you reconcile it against the site or your email. Changed profile/document inputs require fresh preparation. Automatic submission is experimental and limited to recognized simple Lever forms with individual authorization. CAPTCHA, authentication, legal declarations needing review, additional questions and unsupported upload flows require manual completion. Other ATS platforms are not included. Browser cookies, screenshots and sessions are not stored; attempt history contains personal data and is included in private exports/backups.

## Troubleshooting and verification

- **Browser cannot open:** use a local graphical desktop, then run `pnpm --filter @career/api exec playwright install chromium` if Chromium is missing. Headless SSH/container deployment is not a supported user workflow.
- **Form not recognized:** take manual control only after checking the destination. Do not repeatedly retry autofill. The restricted browser may block unsupported external resources.
- **Window lost, restart or restore:** resolve the uncertain attempt manually; no grant or browser resumes automatically.
- **Another window is open:** finish or close its attempt before opening another assisted window.
- **Changed profile or PDF:** generate and approve a current CV, resolve/cancel the previous attempt, then prepare a new one.

Run `pnpm run test:assisted` for synthetic Chromium and URL/consent checks. To include the disposable database suite, set `CAREER_ASSIST_TEST_ADMIN_URL` to a local maintenance database such as `postgresql://USER@127.0.0.1:5432/postgres`. Without it, database tests are explicitly skipped. These tests never fill a real employer form.

The isolated UI scenario `assisted-application-preparation` verifies EN/ES, mobile layout, consent and cancellation without opening an ATS. Browser execution is checked separately with synthetic HTML, and API states with an injected fake browser. This is not a real employer submission E2E test. See [the design decision](../decisions/015-assisted-applications.md).


## v0.7.0 submission evidence and limitations

The submission adapter checks the exact reviewed form and contact values, verifies the approved PDF hash, restricts the browser to one submission POST, and consumes a persisted permit before transmission. Confirmation requires a successful response and a newly visible matching receipt. A click, timeout or HTTP error does not establish success. Uncertain outcomes close the browser and block automatic retry; restart/restore never resumes a send.

Synthetic browser tests inspect the actual multipart PDF/contact payload and cover missing/stale receipts, HTTP failures and unsupported fields. API tests use a disposable database and fake browser to exercise authorization, races, stale inputs and duplicate blocking. These are not real-employer submission tests. Read-only inspection of two public Lever forms found CAPTCHA and extra controls, so both require manual continuation. Do not interpret this release as validated unattended submission to arbitrary Lever jobs.

Las pruebas no envían solicitudes a empresas reales. Dos formularios públicos inspeccionados tenían CAPTCHA y controles adicionales. Se documentan como no compatibles con envío automático; el recorrido manual sigue disponible. Una confirmación automática registra evidencia del portal; una confirmación manual registra tu declaración.
