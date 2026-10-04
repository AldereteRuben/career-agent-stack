# Auditoría de casos límite — v0.7.1

Fecha: 2026-10-04. Base revisada: `3d268518c48dd16f7141e85dd110500b03ea5c57`.
Estado: seis hallazgos corregidos e incorporados a v0.7.2; las verificaciones de regresión y cierre se documentan al final.

## Método y alcance

Revisión del código y reproducciones con Chromium, API y PostgreSQL desechables. Datos ficticios, cachés de proveedores vacías sembradas para evitar consultas externas y ningún formulario real enviado. Se revisan concurrencia, borradores de CV, etapas cerradas, límites de búsqueda, historial extenso y recuperación de sesión. Es una pasada dirigida a casos límite, no una repetición de toda la suite E2E ni una certificación de accesibilidad.

El programa de reproducción y las capturas permanecen localmente en `output/playwright/edge-audit-2026-10-04/`, excluidos de Git. Los fallos iniciales del programa de prueba se corrigieron antes de dar por confirmados los resultados.

## Lista priorizada

### E01 — P2: una pestaña desactualizada sobrescribe la etapa guardada

- Código: `apps/dashboard/app/applications/page.tsx:130`; `apps/api/src/server.ts:386`.
- Reproducción: abrir una solicitud en versión 1; otro cliente la cambia a rechazada y obtiene versión 2; desde la vista antigua seleccionar retirada.
- Resultado: el navegador envía solamente `recruitmentStage: WITHDRAWN`, recibe HTTP 200 y sustituye la etapa recién guardada. No manda `expectedVersion`, aunque el servidor admite esa protección. El historial conserva los cambios, pero no evita el conflicto silencioso.
- Corrección: enviar la versión mostrada en todos los cambios del seguimiento; ante conflicto, actualizar los datos y conservar la intención del usuario para que revise antes de reintentar.
- Aceptación: dos pestañas no pueden sobrescribirse sin un aviso de conflicto; tampoco los cambios de estado ni las correcciones de etapa.

### E02 — P2: «Usar como base» reemplaza un borrador de CV sin confirmación

- Código: `apps/dashboard/app/documents/page.tsx:195`; `apps/dashboard/lib/session-draft.ts:62`.
- Reproducción: poner un nombre propio al CV en edición y seleccionar inglés; abrir CV guardados y reutilizar una versión en español.
- Resultado: el nombre y el idioma se sustituyen de inmediato, sin confirmación. La misma operación reemplaza la selección de experiencias del borrador de destino.
- Corrección: detectar un borrador distinto antes de copiar; ofrecer conservarlo o reemplazarlo explícitamente. Cubrir también un borrador existente en otra oferta de destino.
- Aceptación: cancelar conserva exactamente nombre, idioma y selección; confirmar carga la versión elegida y mantiene el contexto de la oferta.

### E03 — P2: las solicitudes retiradas ofrecen acciones que siempre fallan

- Código: `apps/dashboard/app/applications/page.tsx:167`; `apps/dashboard/components/assisted-application.tsx:85`.
- Reproducción: solicitud con estado `DRAFT` y etapa `WITHDRAWN`, oferta compatible y un CV aprobado disponible.
- Resultado: siguen visibles «Preparar mi solicitud» y «Revisar datos y destino». La primera operación devuelve `APPLICATION_CLOSED_OR_UNCERTAIN`; la segunda termina con HTTP 409 / `APPLICATION_RESUME_CLOSED`. El servidor bloquea correctamente ambas operaciones; el problema es la promesa de la interfaz.
- Corrección: compartir el criterio de solicitud cerrada entre los componentes, incluyendo `REJECTED`, `WITHDRAWN` y `HIRED`; mostrar el historial y el siguiente paso permitido.
- Aceptación: recorrer las tres etapas terminales, con y sin CV, y comprobar que las opciones ofrecidas se pueden completar. La reproducción dinámica de esta pasada cubre `WITHDRAWN`; las otras dos se identifican por la misma condición del código.

### E04 — P2: un fallo temporal se interpreta como pérdida de sesión

- Código: `apps/dashboard/components/shell.tsx:45`.
- Reproducción: responder HTTP 503 únicamente a la comprobación inicial de `/session`; volver a consultar la sesión real después.
- Resultado: la app redirige a `/login` aunque el servidor sigue indicando `authenticated: true`. Para una persona nueva, esto puede parecer que necesita recuperar un código de acceso.
- Corrección: distinguir falta de autenticación de indisponibilidad del servicio; mostrar reintento y conservar el destino original.
- Aceptación: un 503 o un error de red no abre el formulario de acceso; un rechazo auténtico de sesión sí ofrece recuperación sin perder el destino ni el borrador.

### E05 — P3: los criterios largos se recortan silenciosamente

- Código: `apps/api/src/job-search-routes.ts:18`; campos de `apps/dashboard/app/searches/page.tsx`.
- Reproducción: guardar un puesto de 201 caracteres desde el formulario.
- Resultado: HTTP 201 y búsqueda guardada con 200 caracteres. No se comunica que el criterio enviado fue modificado. El mismo recorte se aplica a empresa y ubicación.
- Corrección: validar la longitud de forma consistente en cliente y servidor; mostrar el límite antes de guardar y rechazar entradas demasiado largas sin alterarlas.
- Aceptación: 200 caracteres se guardan íntegros; 201 muestran un error asociado al campo y mantienen el texto para editarlo.

### E06 — P2: el historial oculta solicitudes válidas al superar 500 registros

- Código: `apps/api/src/server.ts:342`; `apps/dashboard/app/applications/page.tsx:86` y `:212`.
- Reproducción: crear una solicitud, añadir otras 500 más recientes y abrir el enlace directo de la primera.
- Resultado: la lista devuelve solo las 500 más recientes; el detalle se busca únicamente en esa lista. La interfaz dice «No encontramos esa solicitud» aunque `GET /applications/:id` devuelve el registro correctamente. No se puede actualizar su etapa desde ese enlace. Además, se renderizan las 500 filas completas, haciendo muy largo el recorrido.
- Corrección: cargar el detalle solicitado por ID independientemente de la página de resultados; paginar la lista con total, navegación y búsqueda accesibles.
- Aceptación: con 501 o más registros, todos siguen accesibles; el enlace antiguo abre su detalle y permite actualizarlo. Un ID realmente inexistente mantiene un mensaje correcto.

## Resultado y orden de corrección

Siete escenarios dirigidos: seis defectos confirmados y un caso de sesión realmente inválida que devuelve HTTP 401 y termina en `/login`. Ese último caso no se registra como un defecto de recuperación sin evidencia adicional. Tampoco se concluye que su borrador se pierda: habría que completar una nueva autenticación para comprobarlo.

Orden recomendado: E01 y E02 (sobrescrituras), E06 (acceso al historial), E03 y E04 (acciones imposibles y recuperación ante fallos), E05 (validación de entrada). Repetir después las reproducciones en ES/EN y móvil, más la suite de regresión completa antes de una nueva publicación.

Las reproducciones terminaron y el entorno desechable se cerró. Las comprobaciones del harness sobre aislamiento y recursos locales protegidos terminaron sin errores. Este fue el resultado del diagnóstico inicial; las correcciones posteriores se detallan abajo.


## Correcciones aplicadas

- **E01:** todos los cambios del seguimiento envían `expectedVersion`. Un HTTP 409 conserva el cambio más reciente, recarga el registro y pide revisar/repetir la acción. Las notas en edición conservan su borrador.
- **E02:** reutilizar una versión comprueba el borrador del destino, incluso si corresponde a otra oferta. Cancelar conserva exactamente su contenido; aceptar lo reemplaza. Los valores de un CV recién generado se guardan explícitamente para que editar esa misma versión no produzca una confirmación innecesaria.
- **E03:** una regla compartida de dominio reconoce estados enviados/cancelados y etapas rechazada, retirada o contratada. El seguimiento y el panel asistido dejan de ofrecer una nueva preparación; también se oculta el recorrido de preparación de una candidatura cerrada. El historial y las notas siguen disponibles.
- **E04:** la comprobación de sesión distingue HTTP 401 de errores temporales. Un fallo temporal conserva la ruta, muestra una explicación ES/EN y permite reintentar; se descartan respuestas de comprobaciones canceladas.
- **E05:** el servidor rechaza criterios de más de 200 caracteres en creación y edición. El formulario mantiene el texto, identifica el campo y lo enfoca con un mensaje accesible en ES/EN.
- **E06:** el seguimiento usa páginas de 25 registros, total y búsqueda por puesto/empresa. El detalle se carga por ID, con recuperación de errores independiente y protección contra respuestas antiguas. Los enlaces a solicitudes fuera de la página actual siguen funcionando; el servidor ajusta una página fuera de rango.

El contrato de listado sin parámetros se conserva para clientes existentes; el seguimiento usa el nuevo contrato paginado. No se necesita migración de base de datos.


### Ajustes encontrados durante la regresión

La nueva comprobación de sesión expuso una carrera existente en el perfil: su carga podía terminar antes de que el contenedor autenticado mostrase las secciones. El perfil ahora se monta dentro del contenedor autenticado y descarta respuestas anteriores; se repitieron los recorridos de foco por anclas y guardado de preferencias. También se normaliza el borrador tras generar un CV, de modo que editar la misma versión no pida reemplazar un borrador diferente.

Las pruebas antiguas de reutilización ahora aceptan explícitamente la confirmación cuando corresponde. Se hicieron independientes los datos iniciales de las pruebas de continuidad del CV y del enlace desde Inicio al perfil: ya no dependen de que otro escenario haya dejado un PDF obsoleto o una oferta guardada.


## Verificación final de las correcciones

- `pnpm test:edge-cases`: **10/10** en la ejecución `0117669ffb3c`, con ES/EN, móvil de 390 px, conservación/cancelación de borradores, edición de un CV recién generado, 501 solicitudes, conflictos, filtros y recuperación de fallos.
- Pruebas de dominio: **32/32**; búsquedas (incluyendo PostgreSQL desechable): **22/22**; preparación: **5/5**; solicitudes asistidas con formularios sintéticos: **11/11**. Total: **70/70**, sin casos omitidos.
- `pnpm typecheck`, `pnpm lint` y `git diff --check`: sin errores.
- Las incidencias detectadas en el recorrido general se corrigieron y repitieron: versiones PDF con el mismo nombre (`854687b07638`), continuidad y foco de CV (`e14182a37f02`), preferencias y reutilización cuando falta la oferta original (`e17dbc913054`), y navegación desde Inicio al perfil (`87a58cf285de`). Estos resultados corresponden a repeticiones dirigidas; la primera ejecución general incluyó fallos y no se presenta como una ejecución íntegra en verde.

Las capturas y registros quedan bajo `output/playwright/` y no se incluyen en Git. Ninguna prueba envió solicitudes a una empresa real.

El recorrido general inicial terminó con 26/31. Los cinco escenarios fallidos figuran arriba con su repetición aprobada después de los ajustes; no quedan fallos conocidos de ese recorrido sin una repetición aprobada. La app local se recompiló y reinició después de cerrar las bases de datos desechables. `pnpm status` confirma API y dashboard ejecutando la compilación actual; `/healthz` responde correctamente y `/login` devuelve HTTP 200. Las dependencias se verificaron mediante una instalación congelada sin cambios; se actualizó únicamente la fecha del marcador local de instalación porque pnpm conserva la anterior cuando no reinstala nada.

### Cierre para v0.7.2

La ejecución completa posterior terminó con **31/31 escenarios aprobados** en una sola pasada (`a6d2b5fffef5`). La suite adicional de casos límite se repitió con **10/10 aprobados** (`673200ebdc68`). Las bases desechables y los procesos de pruebas se cerraron correctamente.

Se repitieron también todas las comprobaciones automatizadas con sus conexiones desechables habilitadas: **175/175, sin omisiones** (dominio 32, fuentes 19, descubrimiento 13, búsquedas 22, archivos de respaldo 30, API de respaldo 6, restauración/migración 17, preparación 7 y asistencia 29). Lint, TypeScript del workspace y de E2E pasaron.

La publicación exige CI en verde sobre el commit de release, seguido de main, tag anotado y GitHub Release. Los enlaces de publicación quedan en las [notas de v0.7.2](../releases/v0.7.2.md).
