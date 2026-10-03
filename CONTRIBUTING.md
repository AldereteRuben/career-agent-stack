# Contributing / Cómo contribuir

Contributions, bug reports, translations, accessibility fixes and documentation improvements are welcome in **English or Spanish**. This is a community source-available project with noncommercial licensing.

## Before you start

- Read [the license](LICENSE), [personal-use permission](LICENSE-PERSONAL-USE.md), [conduct rules](CODE_OF_CONDUCT.md) and [security policy](SECURITY.md).
- Search existing issues. Describe larger changes in an issue before implementing them, so maintainers can agree on scope.
- Use fictional profiles and job applications. Never attach a real CV, `.env`, tokens, backups, database dumps, exports or unredacted logs/screenshots.
- For vulnerabilities, follow the private reporting route in `SECURITY.md`.

## Development

Follow the [quick start](README.md) or [inicio en español](README.es.md). Use Node 24 and the pinned pnpm version. Each developer uses a separate local installation; no hosted account or paid AI service is required.

1. Fork the repository when it is public, clone your fork, and create a descriptive branch.
2. Keep the change focused. Preserve both English and Spanish UI messages and check keyboard access and visible focus for UI changes.
3. Run the checks relevant to your change and report what you ran:

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

4. Open a pull request against `main`, link the issue, explain the change, and list checks and limitations. Include sanitized before/after images for visual changes.
5. A maintainer reviews changes before merging. Passing CI is necessary but is not approval to merge. External workflow runs may require maintainer approval.

## Contribution terms

By intentionally submitting a contribution for inclusion, you confirm that you have the right to submit it and offer your original contribution under `LICENSE` **and** `LICENSE-PERSONAL-USE.md`. You retain ownership of your contribution; no copyright assignment is required. Do not submit third-party code under incompatible terms. Identify any third-party material, retain its notices, and document dependency changes.

AI-assisted contributions are welcome if you review and understand them, can explain their behavior, disclose substantive assistance in the PR, and have the necessary rights to submit the resulting material. Never submit private prompts or user data.

## En español

Puedes abrir issues y PR en español. Primero revisa si el problema ya está reportado. Haz cambios pequeños, conserva ambos idiomas y explica qué comprobaste. Al enviar cambios aceptas ofrecer tus aportaciones bajo la licencia no comercial y el permiso adicional de uso personal; conservas su autoría. Las contribuciones se revisan y no se incorporan automáticamente.
