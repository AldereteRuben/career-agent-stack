# Optional assistant / Asistente opcional

## Connect / Conectar

Career Stack v0.9.0 supports the official **Codex CLI 0.160.0 on macOS**, authenticated with a ChatGPT plan. Install Codex through the [official instructions](https://developers.openai.com/codex/cli/). Check `codex --version` when troubleshooting. A different version is rejected until its isolation and protocol are verified; installing a newer CLI does not automatically certify compatibility. Career Stack never installs it on page load.

Open **Profile and tools → Settings and privacy → Assistant**, then explicitly check the account. If signed out, continue through the official sign-in page. Confirm the masked account with **Use this account**. The same connection flow appears beside contextual assistant actions and preserves the text you were editing.

ES: abre **Perfil y herramientas → Ajustes y privacidad → Asistente**, comprueba la cuenta e inicia sesión en la página oficial si hace falta. Confirma la cuenta enmascarada. La ayuda contextual también permite conectar sin perder lo escrito. Las funciones habituales no requieren IA. Linux, Windows y otras versiones de Codex no están certificados para esta integración. Claude queda aplazado.

## What is shared / Qué se comparte

Each action previews the request, job description, selected approved experience and question that it will use. Name, email and contact fields are excluded by the application. Review the preview: contact information typed inside free text remains text you chose to share. The selected content is processed by OpenAI under your account; local storage does not mean all processing stays on your computer.

Optional remembered permission applies to that action and data categories for the connected account. Automatic analysis has its own permission for selected searches. Revoke either in Settings. Revocation stops pending work and requests cancellation of active work; it cannot retract text already sent.

ES: revisa los datos antes de continuar. La aplicación excluye los campos de nombre y contacto, pero debes revisar cualquier dato personal escrito dentro de un texto libre. Guardar localmente y procesar con OpenAI son cosas distintas. Puedes recordar el permiso por acción o revocarlo en Ajustes. El análisis automático tiene un permiso separado para las búsquedas elegidas.

## Review results / Revisar resultados

- Search suggestions populate editable fields. Salary, industry and other unsupported constraints are not silently applied as filters.
- Job summaries keep references to the original posting and selected experience. They do not establish work authorization or a hiring probability.
- Resume suggestions preserve their source facts. Edit or restore the original wording, generate a PDF, then approve that exact version. Generation alone is not approval. Older PDFs retain their bytes and history.
- Answers are saved as a new, unapproved version with the original question, country, scope and expiry. Questions requiring personal decisions ask for your input. Source changes can prevent reuse.
- Results are persisted. Reopening a contextual action recovers matching work without automatically starting another task. A timeout or uncertain completion does not silently retry.

ES: las propuestas siempre se revisan. Crear una búsqueda, generar un PDF y aprobarlo son acciones separadas. Las respuestas nuevas empiezan sin aprobar. Si cambian los datos que respaldan una propuesta, revisa las fuentes y prepara una versión nueva cuando corresponda. Cerrar la pestaña no borra una tarea aceptada.

## Automatic analysis / Análisis automático

After a successful manual job analysis, choose whether to analyze future jobs. Select searches, approved facts and a daily maximum, review the exact scope, then activate. The service must remain running. It analyzes new canonical jobs from those searches; it does not process the old backlog or automatically regenerate every changed result.

The installation caps automatic starts at **five per pass and ten per UTC day**, with a lower daily maximum if chosen. Manual work has priority. These are local task counts, not a guarantee of subscription availability or a monetary spending cap. No API-key fallback, account rotation or automatic paid upgrade is used. Pause stops further scheduling and cancels pending work. Ordinary searches keep working.

ES: después de un análisis manual, selecciona búsquedas, experiencia y máximo diario; revisa y activa. Empieza desactivado. Pausar los análisis mantiene la búsqueda habitual. Los límites locales cuentan tareas: no equivalen a dinero ni garantizan cuota disponible en ChatGPT.

## Usage, disconnect and recovery / Uso, desconexión y recuperación

Usage windows are shown only when the official interface reports them, together with observation time. Missing information means unknown, never unlimited or zero. Connection checks and refreshes are explicit. Disconnect revokes Career Stack's grant and stops its queue; it does not sign out the official CLI used elsewhere. An authoritative account change or sign-out invalidates the grant. A temporary inspection failure does not change the global login.

Restore creates an isolated destination, revokes connections and permissions, pauses policies, and cancels/interrupts unfinished tasks. Suggestions and their source history remain. No restored task resumes inference automatically. Exported assistant records omit account fingerprints, official account context and process leases.

ES: el consumo solo se muestra si la interfaz oficial lo informa; un dato desconocido no significa uso ilimitado. Desconectar no cierra la sesión de Codex en otras herramientas. Restaurar una copia conserva resultados pero exige reconectar y autorizar de nuevo cualquier procesamiento.

For administrators, `CAREER_AI_ENABLED=false` disables execution and hides contextual assistant controls. Ordinary app features are unaffected. Native isolation, four authorized synthetic real tasks, test evidence and remaining limits are recorded in [v0.9.0 validation](../releases/v0.9.0-validation.md).

## History and retention / Historial y conservación

Settings offers an explicit preview before clearing unreferenced assistant history. Active work and proposals backing saved resumes or answers are preserved. The service removes terminal work without a proposal after 30 days, and discarded proposals 30 days after dismissal; pending review is not discarded automatically. Minimal hashes/IDs remain to prevent deleted automatic work from running again and to preserve single-use permission/idempotency. Today's task counters are not reset by clearing history.

Deletion affects this local installation. It does not delete older external backups or provider-side records. Restoring a backup preserves its deletion markers so cleanup cannot restart already consumed automatic tasks.

ES: en Ajustes puedes revisar qué historial se borrará antes de confirmarlo. Se conservan las tareas activas y las fuentes de CV y respuestas guardadas. Los trabajos terminados sin propuesta caducan a los 30 días; las propuestas descartadas, 30 días después de descartarlas. Las propuestas pendientes no desaparecen automáticamente. Se mantienen identificadores mínimos para impedir repeticiones y no se reinician los límites diarios. El borrado local no modifica copias externas ni registros del proveedor.
