# Automated accessibility checks / Comprobaciones automáticas de accesibilidad

## Choice / Elección

The repository uses ESLint 10, while its existing `eslint-plugin-jsx-a11y` version declares peer support only through ESLint 9. Keep that static lint setup unchanged and add axe scans to the Playwright browser suite instead. Axe checks the rendered interface and can detect issues that JSX-only lint rules cannot.

El repositorio usa ESLint 10, mientras que la versión existente de `eslint-plugin-jsx-a11y` declara compatibilidad hasta ESLint 9. Se conserva esa configuración de lint y se añaden análisis de axe a la suite de navegador con Playwright. Axe inspecciona la interfaz renderizada y puede detectar problemas que no ve un lint estático de JSX.

The test-only dependency is `@axe-core/playwright` 4.13.0, licensed MPL-2.0; it brings `axe-core` 4.13.0, also MPL-2.0. Neither package is modified or shipped with the app. The license inventory and MPL text are recorded in [third-party notices](../../THIRD_PARTY_NOTICES.md) and [dependency license texts](../../docs/legal/dependency-license-texts.txt).

La dependencia, solo para pruebas, es `@axe-core/playwright` 4.13.0, con licencia MPL-2.0; incluye `axe-core` 4.13.0, también MPL-2.0. No se modifica ni se distribuye ninguno de los paquetes con la aplicación. El inventario y el texto de la licencia están en [avisos de terceros](../../THIRD_PARTY_NOTICES.md) y [textos de licencias](../../docs/legal/dependency-license-texts.txt).

## Coverage / Cobertura

The browser test scans the profile, search creation/saved-search view, job results, job detail, application tracker and application form against WCAG 2 A/AA, WCAG 2.1 A/AA, WCAG 2.2 AA and axe best-practice rules. It reports the rule, impact, help text and affected selectors when a scan fails.

La prueba de navegador analiza el perfil, la creación/lista de búsquedas, los resultados, el detalle de una oferta, el seguimiento de solicitudes y el formulario de solicitud con reglas WCAG 2 A/AA, WCAG 2.1 A/AA, WCAG 2.2 AA y buenas prácticas de axe. Si falla, informa de la regla, el impacto, la explicación y los selectores afectados.

Automated scans cover only detectable rules. They do not prove conformance or replace a manual contrast and screen-reader audit. A manual audit with its tools, versions, browser and flows remains outstanding for issue #18.

Los análisis automáticos solo cubren reglas detectables. No demuestran conformidad ni sustituyen una auditoría manual de contraste y lectores de pantalla. La auditoría manual, con herramientas, versiones, navegador y flujos, sigue pendiente en el issue #18.
