# Contributing / Cómo contribuir

**English** · [Español](#en-español)

Contributions, bug reports, translations, accessibility fixes and documentation improvements are welcome in **English or Spanish**. This is a community source-available project with noncommercial licensing.

## Ways to contribute

- **Report a bug** with the [bug report form](https://github.com/AldereteRuben/career-agent-stack/issues/new?template=bug_report.yml).
- **Propose an improvement**, translation or accessibility fix with the [improvement form](https://github.com/AldereteRuben/career-agent-stack/issues/new?template=feature_request.yml).
- **Ask or discuss** in [Discussions](https://github.com/AldereteRuben/career-agent-stack/discussions). See [getting help](SUPPORT.md).
- **Send a pull request.** For a first contribution, issues labeled [good first issue](https://github.com/AldereteRuben/career-agent-stack/labels/good%20first%20issue) are small and well described; [help wanted](https://github.com/AldereteRuben/career-agent-stack/labels/help%20wanted) marks larger ones where help is welcome. Comment on the issue before you start so nobody duplicates the work.

## Before you start

- Read [the license](LICENSE), [personal-use permission](LICENSE-PERSONAL-USE.md), [code of conduct](CODE_OF_CONDUCT.md) and [security policy](SECURITY.md).
- Search existing issues. Describe larger changes in an issue before implementing them, so maintainers can agree on scope.
- Use fictional profiles and job applications. Never attach a real CV, `.env`, tokens, backups, database dumps, exports or unredacted logs/screenshots.
- For vulnerabilities, follow the private reporting route in `SECURITY.md`.

## Development

Follow the [quick start](README.md) or [inicio en español](README.es.md). Use Node 24 and the pinned pnpm version. Each developer uses a separate local installation; no hosted account or paid AI service is required.

1. Fork the repository, clone your fork, and create a descriptive branch such as `fix/short-description`, `feat/short-description` or `docs/short-description`.
2. Keep the change focused on one topic: one bug, one improvement or one document. Unrelated fixes found along the way go in separate pull requests or issues.
3. Preserve both English and Spanish UI messages and check keyboard access, visible focus and mobile layout for UI changes. Write operating-system-neutral instructions unless a step is platform specific.
4. Run the checks relevant to your change and report what you ran:

```sh
pnpm install --frozen-lockfile
pnpm run build:shared
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:sources
pnpm run test:backup
pnpm run build
```

Database, recovery and browser changes also need the appropriate isolated suites documented in [E2E testing](docs/operations/e2e-testing.md), [backup/restore](docs/operations/backup-restore.md) and [local setup](docs/operations/local-setup.md). Never point destructive tests at a real workspace. Public feed checks are optional and explicitly use `pnpm run verify:sources --live`.

### Commit messages

Use a short imperative summary with a type prefix, as in the existing history:

| Prefix | Use for |
| --- | --- |
| `feat:` | A new capability for users |
| `fix:` | A bug fix |
| `docs:` | Documentation only |
| `test:` | Tests only |
| `build:` | Dependencies, tooling or CI |

For example: `fix: keep the search filter when returning to results`. Keep your own authorship; do not add co-author or generator lines for automated tools, assistants or models.

## Pull requests

1. Open a pull request against `main` and fill in the template: link the issue (`Closes #123`), explain what changed and why, and list checks and limitations. Include sanitized before/after images, in both languages, for visual changes.
2. CI runs automatically. For first-time contributors a maintainer approves the run after reading the changes, so the first run may wait a little.
3. A maintainer reviews the change. Expect questions or requested changes; push new commits to the same branch to answer them and resolve each conversation when it is addressed.
4. Passing CI is necessary but is not approval to merge. Pull requests are merged by a maintainer with **squash merge**, so the pull request title becomes the commit message: write it with the prefixes above.

There is no guaranteed response time. If a pull request has had no answer for two weeks, a polite comment asking for a review is welcome.

### Versions and releases

Do not change version numbers, `RELEASE_VERSION` or `CHANGELOG.md` in your pull request. Merged pull requests accumulate on `main`, and the maintainer publishes a release when a set of changes is ready: they align the versions and the changelog in a release pull request, tag it and publish the release notes. Versions follow [Semantic Versioning](https://semver.org): fixes raise the last number (0.9.2 → 0.9.3) and new features the middle one (0.9.x → 0.10.0). Maintainers label each pull request (`bug`, `enhancement`, `documentation`…) so it appears in the right section of the release notes, which credit every contributor.

## Contribution terms

By intentionally submitting a contribution for inclusion, you confirm that you have the right to submit it and offer your original contribution under `LICENSE` **and** `LICENSE-PERSONAL-USE.md`. You retain ownership of your contribution; no copyright assignment is required. Do not submit third-party code under incompatible terms. Identify any third-party material, retain its notices, and document dependency changes.

AI-assisted contributions are welcome if you review and understand them, can explain their behavior, and have the necessary rights to submit the resulting material. You do not need to declare which tools you used. Never submit private prompts or user data.

## En español

Puedes abrir issues, conversaciones y pull requests en español.

**Formas de contribuir.** Reporta errores con el [formulario de errores](https://github.com/AldereteRuben/career-agent-stack/issues/new?template=bug_report.yml), propone mejoras o traducciones con el [formulario de mejoras](https://github.com/AldereteRuben/career-agent-stack/issues/new?template=feature_request.yml) y haz preguntas en [Discussions](https://github.com/AldereteRuben/career-agent-stack/discussions) (consulta [cómo pedir ayuda](SUPPORT.md)). Para una primera contribución busca issues con la etiqueta [good first issue](https://github.com/AldereteRuben/career-agent-stack/labels/good%20first%20issue) y comenta en el issue antes de empezar.

**Antes de empezar.** Lee la [licencia](LICENSE), el [permiso de uso personal](LICENSE-PERSONAL-USE.md), el [código de conducta](CODE_OF_CONDUCT.es.md) y la [política de seguridad](SECURITY.md). Busca si el problema ya está reportado y, para cambios grandes, abre primero un issue para acordar el alcance. Usa solo datos ficticios.

**Desarrollo.** Sigue el [inicio en español](README.es.md). Haz un fork, crea una rama descriptiva (`fix/descripcion-corta`, `feat/...`, `docs/...`) y mantén el cambio enfocado en un solo tema. Conserva ambos idiomas, revisa teclado, foco visible y móvil en cambios de interfaz, y ejecuta las comprobaciones de la lista de arriba que correspondan.

**Commits.** Un resumen corto con prefijo (`feat:`, `fix:`, `docs:`, `test:`, `build:`), por ejemplo `fix: conservar el filtro al volver a los resultados`. Conserva tu autoría y no añadas líneas de coautoría de herramientas o modelos.

**Pull requests.** Abre el PR contra `main`, completa la plantilla (issue enlazado, qué cambió, comprobaciones y límites) y añade capturas sin datos privados en ambos idiomas si cambia la interfaz. En una primera contribución, un responsable aprueba la ejecución del CI después de leer los cambios. Responde a la revisión con nuevos commits en la misma rama. Los cambios se unen con **squash merge**, así que el título del PR será el mensaje del commit. No hay plazo de respuesta garantizado; si en dos semanas no hay respuesta, puedes dejar un comentario amable.

**Versiones.** No cambies los números de versión, `RELEASE_VERSION` ni `CHANGELOG.md` en tu PR. Los cambios unidos se acumulan en `main` y el responsable publica una versión cuando un conjunto está listo: alinea versiones y changelog en una PR de release, crea la etiqueta y publica las notas. Se usa [versionado semántico](https://semver.org/lang/es/): los arreglos suben el último número (0.9.2 → 0.9.3) y las funciones nuevas el del medio (0.9.x → 0.10.0). Los responsables etiquetan cada PR para que aparezca en la sección correcta de las notas de la versión, donde se reconoce a cada persona que contribuyó.

**Términos.** Al enviar cambios aceptas ofrecer tus aportaciones bajo la licencia no comercial y el permiso adicional de uso personal; conservas su autoría. Las contribuciones asistidas por IA son bienvenidas si las entiendes y puedes explicarlas; no hace falta indicar qué herramientas usaste. Las contribuciones se revisan y no se incorporan automáticamente.
