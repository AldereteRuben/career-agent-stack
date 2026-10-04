# Himalayas source / Fuente de Himalayas

## Contract checked / Contrato comprobado

Checked 2026-10-04 against the [Remote Jobs API documentation](https://himalayas.app/docs/remote-jobs-api) and [OpenAPI 3.1 specification](https://himalayas.app/docs/openapi.json).

Verificado el 2026-10-04 con la [documentación de Remote Jobs API](https://himalayas.app/docs/remote-jobs-api) y la [especificación OpenAPI 3.1](https://himalayas.app/docs/openapi.json).

The adapter uses the fixed HTTPS endpoint `https://himalayas.app/jobs/api/search`. Search filters are `q`, `country`, and 1-based `page`. The API accepts a country code, name, slug, or common abbreviation. The adapter combines role and company text in `q`; it does not turn a free-text company name into a company slug. Results contain `jobs`, `totalCount`, `limit`, and `updatedAt` (Unix milliseconds). Search pagination uses `page`; `nextCursor` is documented for the separate browse endpoint, not search.

El adaptador usa el endpoint HTTPS fijo `https://himalayas.app/jobs/api/search`. Los filtros son `q`, `country` y `page` desde 1. La API acepta código de país, nombre, slug o abreviatura habitual. El adaptador combina puesto y empresa en `q`; no convierte un nombre de empresa libre en un slug. La respuesta incluye `jobs`, `totalCount`, `limit` y `updatedAt` (milisegundos Unix). La búsqueda pagina con `page`; `nextCursor` corresponde al endpoint de exploración general, no al de búsqueda.

`guid` is the external ID. The OpenAPI contract describes `applicationLink` as the direct application destination and gives an employer-hosted URL as its example; it does not promise that the link host is Himalayas. The adapter retains that destination only when it is HTTPS and has a public DNS host (no credentials, non-default port, IP literal, localhost, or reserved local/test suffix). It marks `raw.__careerStackSource` as `himalayas` and `raw.__careerStackSourceUrl` as `https://himalayas.app` so the UI can provide the required source attribution alongside the direct application link. API responses must have a JSON content type and the final response URL must remain at the fixed Himalayas search endpoint.

`guid` es el ID externo. El contrato OpenAPI describe `applicationLink` como el destino directo de candidatura y usa como ejemplo un enlace alojado por la empresa; no garantiza que el host sea Himalayas. El adaptador conserva ese destino únicamente si usa HTTPS y un host DNS público (sin credenciales, puerto no estándar, IP literal, localhost ni sufijos locales/de prueba reservados). Marca `raw.__careerStackSource` como `himalayas` y `raw.__careerStackSourceUrl` como `https://himalayas.app` para que la interfaz atribuya la fuente junto al enlace directo de candidatura. Las respuestas deben tener tipo de contenido JSON y su URL final debe seguir en el endpoint fijo de búsqueda de Himalayas.

Himalayas supplies `pubDate` and `updatedAt` as millisecond timestamps. Publication dates before 2000 or more than 24 hours in the future are treated as unknown; invalid response timestamps fail with `SOURCE_INVALID_RESPONSE`. Description HTML is reduced to plain text before it is returned.

Himalayas entrega `pubDate` y `updatedAt` como marcas de tiempo en milisegundos. Las fechas de publicación anteriores a 2000 o con más de 24 horas en el futuro se consideran desconocidas; una fecha de respuesta inválida produce `SOURCE_INVALID_RESPONSE`. La descripción HTML se convierte a texto antes de devolverla.

The source marks `workMode` as `remote`. Country restrictions are exposed in `raw.__careerStackCountries` as alpha-2 codes; an empty restriction list also sets `raw.__careerStackWorldwide` to `true`. The provider describes an empty list as unrestricted worldwide availability. Only recognized country codes/names are sent as the `country` filter; cities and unknown text are left for the caller's local location filter. This expresses the listing's geographic evidence only; timezone requirements remain in the provider's raw fields.

La fuente marca `workMode` como `remote`. Las restricciones de país se exponen en `raw.__careerStackCountries` como códigos alpha-2; una lista vacía también establece `raw.__careerStackWorldwide` en `true`. El proveedor define la lista vacía como disponibilidad mundial sin restricciones geográficas. Solo se envían como filtro `country` los códigos/nombres de país reconocidos; las ciudades y el texto desconocido quedan para el filtro local del consumidor. Esto representa solo la evidencia geográfica del anuncio; las restricciones horarias permanecen en los datos del proveedor.

## Bounded read policy / Límites de lectura

- At most 3 pages per search response, one request at a time, using the fixed host and `redirect: error`.
- An 8-second timeout and 4 MiB maximum response body apply to each request.
- HTTP 429 is surfaced as `SOURCE_HTTP_429`, with parsed `Retry-After` when supplied. Other HTTP failures preserve their status in the provider error code.
- `coverage` is `BOUNDED` if `totalCount` and `limit` indicate more result pages than were read. `PARTIAL` means one or more rows were invalid or a later page failed; already validated jobs are returned and retained. The caller should preserve either state; neither represents a complete search.
- This adapter does not mirror the catalog or persist a cache. The source says its data refreshes every 24 hours; coordinate query caching and per-installation request budgets in the search scheduler.

- Máximo de 3 páginas por respuesta, una petición cada vez, con host fijo y `redirect: error`.
- Se aplican 8 segundos de espera máxima y 4 MiB por cuerpo de respuesta.
- HTTP 429 se informa como `SOURCE_HTTP_429` y se interpreta `Retry-After` si existe. Los demás fallos HTTP conservan su estado en el código de error.
- `coverage` es `BOUNDED` cuando `totalCount` y `limit` indican más páginas de las leídas. El consumidor debe conservar este estado; una respuesta limitada no representa una búsqueda completa.
- `coverage` es `PARTIAL` si hay filas inválidas o falla una página posterior; se devuelven y conservan las ofertas ya validadas. El consumidor debe conservar cualquiera de esos estados; ninguno representa una búsqueda completa.
- Este adaptador no replica el catálogo ni persiste una caché. La fuente indica que actualiza los datos cada 24 horas; el planificador de búsqueda debe coordinar la caché por consulta y el presupuesto de peticiones por instalación.

## Bounded live contract check / Comprobación limitada en vivo

On 2026-10-04, three read-only requests were made to the documented search endpoint (`q=software&page=1`, `q=software&page=2`, `q=design&page=1`), with an 8-second timeout, redirect rejection, and no listing output retained. All 3 returned HTTP 200 JSON, each reported 20 jobs, integer `totalCount`, numeric millisecond `updatedAt`, numeric `pubDate`, and string `title`, `companyName`, `guid`, and `applicationLink`. The search responses did not include `nextCursor`; page 2 returned a normal 20-job result. No conclusion about full result quality, stable totals across pages, or rate limits beyond the documentation is drawn from this sample.

El 2026-10-04 se hicieron tres peticiones de solo lectura al endpoint documentado (`q=software&page=1`, `q=software&page=2`, `q=design&page=1`), con espera máxima de 8 segundos, rechazo de redirecciones y sin conservar datos de anuncios. Las tres devolvieron HTTP 200 JSON, cada una indicó 20 ofertas, `totalCount` entero, `updatedAt` numérico en milisegundos, `pubDate` numérico y los campos de texto `title`, `companyName`, `guid` y `applicationLink`. Las respuestas de búsqueda no incluyeron `nextCursor`; la página 2 devolvió 20 ofertas. Esta muestra no permite concluir sobre calidad total, estabilidad del total entre páginas ni límites de frecuencia más allá de la documentación.

Himalayas requires visible attribution and a link to [himalayas.app](https://himalayas.app) when displaying its job data. Ensure the integrated results UI identifies Himalayas as the source and provides that link.

Himalayas requiere atribución visible y un enlace a [himalayas.app](https://himalayas.app) al mostrar sus ofertas. La interfaz integrada debe identificar a Himalayas como fuente e incluir ese enlace.
