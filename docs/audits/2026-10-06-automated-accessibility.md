# Revisión automática de accesibilidad de Career Stack v0.9.2

Fecha: 2026-10-06. Base: `697eecf`.
Estado: revisión automática terminada; **la auditoría manual con lectores de pantalla sigue pendiente** (issue #18, parte 2).

Esta revisión pasa axe-core por las pantallas principales en un navegador real. Encuentra una parte de los problemas de accesibilidad,
no todos: no sustituye a una prueba con teclado y lectores de pantalla, y no es una certificación.

## Método

- **Herramienta:** axe-core 4.13.0 (MPL-2.0; llega como dependencia de desarrollo de `eslint-plugin-jsx-a11y`, ver #60).
- **Reglas:** etiquetas `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` y `wcag22aa`, incluido el contraste de color.
- **Navegador:** Chromium 153.0.8010.12 con Playwright 1.63.0, sobre Ubuntu 26.04.1, Node 24.18.0.
- **Aplicación:** compilación de producción de `main` (`697eecf`), servida con `next start`.
- **Datos:** ficticios y simulados en el navegador (la API se intercepta). No se usó ninguna base de datos ni datos reales; nada de lo que se
  muestra viene de un espacio de trabajo real.
- **Variantes:** español e inglés, escritorio (1280 × 900) y móvil (390 × 800).

## Qué se revisó

Nueve rutas, en las cuatro variantes (36 vistas), y además la página propia de error en todas las rutas que no se pudieron renderizar:

| Ruta | Resultado |
| --- | --- |
| `/login` | 0 infracciones |
| `/start` | 0 infracciones |
| `/searches` | 0 infracciones |
| `/jobs` y `/jobs?scope=favorites` | 0 infracciones |
| `/applications` (lista) | 0 infracciones |
| `/profile` | 0 infracciones |
| `/settings` | 0 infracciones |
| Página «no encontrada» (`/nope`) y página de error | 0 infracciones |

**Resultado: 0 infracciones en 36 vistas**, con unas 26 reglas superadas por vista.

## Lo que axe dejó «para revisión manual» (y qué resultó ser)

axe separa lo que puede decidir de lo que no. Revisé a mano los tres casos:

1. **Contraste de los `<select>` en Ofertas, Guardadas y Perfil.** axe no puede calcular el fondo porque la flecha del control es una imagen.
   Calculado a mano: texto `rgb(31, 41, 56)` sobre `rgb(255, 255, 255)` = **14,66 : 1**. Sin problema (AA exige 4,5 : 1).
2. **Símbolos decorativos expuestos a los lectores de pantalla** (`⌑`, `⌖`, `＋`, `✓`). axe no puede juzgar el contraste de un carácter que no es texto,
   pero el árbol de accesibilidad de Chromium sí los incluye (por ejemplo `- text: ⌑` y `- text: ✓ Experiencia técnica APROBADO POR TI`).
   **Barrera menor real → issue #64.**
3. **`aria-labelledby` en un `<div>` sin rol** (lista «Lo que has guardado» de Mi perfil, `app/profile/page.tsx:257`). La etiqueta puede ignorarse y la
   región no se anuncia por su nombre. **Barrera menor real → issue #65.**

Ninguna de las dos barreras es una infracción de axe; son hallazgos de revisión manual, y no he probado cómo las leen NVDA, VoiceOver ni TalkBack.

## Lo que no se pudo revisar

Con los datos simulados no se pudieron renderizar estas pantallas (la página falló y mostró la de error, que sí se revisó). Hacen falta datos de la
API real o simulaciones más completas:

- Detalle de una solicitud (`/applications?id=…`) y la cola «Por revisar» (`/applications?view=review`, a la que redirige `/preparations`).
- Mis CV (`/documents`), Empresas que sigo (`/boards`) y Resumen (`/overview`).

## Lo que esta revisión no cubre

- Lectores de pantalla (NVDA, VoiceOver, TalkBack, Orca) y cómo anuncian cada pantalla.
- Orden de foco y foco visible con teclado, en todos los flujos.
- Contraste en estados que no se muestran al cargar: pasar el cursor, foco, deshabilitado, errores y avisos transitorios.
- Ampliación del texto al 200 % y ancho de 320 px.
- Contenido dentro de la vista previa del PDF, y movimiento reducido (`prefers-reduced-motion`).
- Modo oscuro y colores forzados: la interfaz no tiene tema oscuro.
- Flujos con datos reales: crear una búsqueda, revisar ofertas, preparar una solicitud de principio a fin.

## Cómo repetirla

La comprobación es un script de Playwright que abre cada ruta con la API interceptada, inyecta `axe.min.js` y ejecuta `axe.run` con las etiquetas de
arriba. No está en el repositorio: depende de los datos simulados de cada pantalla. Si se quiere en el CI, hay que decidir antes cómo mantener esos datos
(o ejecutarlo contra la API desechable de `pnpm run test:e2e`, que necesita un administrador de PostgreSQL).

## Resumen en inglés

Automated check with axe-core 4.13.0 (rules `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) in Chromium 153 on the production build of `697eecf`,
with simulated fictional data, in Spanish and English at 1280 × 900 and 390 × 800. Nine routes (36 views) plus the not-found and error pages: **0 violations**.
Items axe left for manual review: select contrast (measured 14.66:1, fine), decorative symbols exposed in the accessibility tree (#64) and an
`aria-labelledby` on a role-less `div` (#65). Detail of an application, review queue, resumes, companies and overview could not be rendered with simulated
data and were not audited. This is not a screen reader audit, a keyboard-focus audit or a certification; part 2 of #18 remains open.
