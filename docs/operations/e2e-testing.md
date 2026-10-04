# Browser E2E tests

`pnpm run test:e2e` runs `apps/api/e2e/workflow.ts` against a **disposable, isolated stack**. It never writes your workspace data. Read-only fingerprints and database checks verify isolation.

## Isolation guarantees

| Resource | Test run uses | Your workspace |
| --- | --- | --- |
| Database | New `career_e2e_<12 hex>` database on the same local server. It is created through a maintenance database (`postgres`, or `E2E_ADMIN_DATABASE_URL`), migrated from `packages/db/migrations`, and dropped at the end. | Not connected for writes. Read-only checks only (`default_transaction_read_only=on`). |
| API | `tsx src/server.ts` on a free port, with fresh random `APP_SESSION_SECRET` / `APP_ENCRYPTION_KEY` and `DATA_LOCAL_PATH` / `FILES_LOCAL_PATH` in a temporary directory. | The running API on 3001 is not used or restarted. |
| Sign-in token | Written by the isolated API to its temporary data directory. | `data/setup-token` is fingerprinted in memory, never read into output or consumed. |
| Dashboard | `next dev` on a free port from `output/e2e-runs/<run>/dashboard`. Source directories and config files are copied, only installed dependencies are linked, and `.next` is private to the run. | The shared `apps/dashboard/.next` build and the app on 3000 are untouched. |
| Child environment | Inherited variables, minus `DATABASE_URL`, keys, paths, ports and `PG*`, with isolated values supplied explicitly. | — |

The run **stops before opening a browser** if any of these checks fails:

1. The database server in `.env` is not loopback, or the generated name is not a disposable `career_e2e_` name.
2. The new database is not empty or is not the current database of the harness connection.
3. `apps/api/src` does not support `DATA_LOCAL_PATH`. Without it, an isolated API would share the live token file.
4. The isolated API did not write its token to the temporary data directory, or did not create exactly one workspace in the disposable database.
5. The live token fingerprint changed during startup, or the dashboard is not writing to its private `.next`.

Signing in with the isolated token through the isolated dashboard is a further check: the live API would reject that token.

After the scenarios, the run fails if any of the following happened:

- the live token, the live files directory, or the shared `.next/BUILD_ID` changed;
- a row carrying the run marker (`e2e-<run>`) appears in the live database.

The run also reports live row-count changes, as information only, because you may be using the app at the same time.

Every record the tests create carries the run marker. Cleanup does **not** use broad `LIKE` deletes. It drops the whole disposable database and removes the temporary directories. Screenshots and PDFs of fictional data stay in `output/playwright/<run>/`.

## Scenarios

| Name | Regression covered |
| --- | --- |
| `sign-in-and-language-switch` | Isolated sign-in, ES/EN switch, desktop overflow. |
| `es-en-labels-on-every-page` | No Spanish interface words in English mode and vice versa (text, `aria-label`, `placeholder`, `title`), plus `html[lang]`, on every main route. |
| `draft-preserved-when-save-fails` | An intercepted 500 on fact and profile saves keeps the typed draft and creates nothing. Retrying saves exactly once. |
| `facts-not-duplicated-after-profile-revision` | After two profile revisions, an approved fact appears once in the API, the profile page and the document picker, and stays approved. |
| `same-name-pdf-creates-distinct-versions` | Generating two PDFs with the same name gives distinct records, files and revision numbers, and two working downloads that contain the fact. |
| `manual-job-and-application-tracking` | Manual job import, job detail, creating an application and adding a note. |
| `application-deep-link-and-stage-correction` | `/applications?id=…` opens that application, including after a reload. A mistaken stage can be corrected back, with history, without affecting other records, and `?id` is kept. |
| `source-review-and-partial-results` | Both confirmations required, partial results explained, source can be disabled; refresh response is mocked, all other requests use the isolated API. |
| `export-download-and-error-recovery` | Failed export shows actionable feedback; retry downloads JSON with a matching checksum and disabled source permissions. |
| `mobile-drawer-keyboard-and-focus` | At 390 px: the drawer opens with the keyboard and focus moves into it, Tab stays inside, Escape closes it and returns focus, navigating closes it, and there is no horizontal overflow. |
| `v053-notice-actions-wrap-on-mobile` | At 320 px and 390 px, in ES and EN, job/application draft notices and the “sent” confirmation keep text at full width with actions below, inside the viewport, after the message in keyboard order. |
| `v053-linked-resume-review-and-change` | Review or change resume opens the linked PDF (reload, Back, close keep context), another approved resume can be linked from the library, and the unlinked case opens the builder. |
| `v053-home-pending-review-lands-on-saved-list` | Pending-detail links from Home land on the saved list with focus after loading (390 px and desktop); saves do not move scroll or focus; `#experience` stays the add form. |
| `v053-preferences-keep-approved-resume-ready` | Preferences changed in the profile form keep approved and pending PDFs ready; a printed name change blocks approval, linking and assisted preparation until restored; the PDF bytes never change. |

The dashboard copy runs the dashboard's PDF.js asset step itself, so a fresh checkout or worktree needs no prior dashboard build.

Locators prefer roles, `href`s and form structure, and they match Spanish or English copy so that wording changes do not break them. Outcomes are checked against the isolated API.

## Options

```bash
E2E_ONLY=same-name-pdf-creates-distinct-versions pnpm run test:e2e   # subset (sign-in always runs)
E2E_HEADED=1 pnpm run test:e2e                                        # visible browser
E2E_KEEP=1 pnpm run test:e2e                                          # keep DB, temp dirs and logs for debugging
```

With `E2E_KEEP=1`, remove the leftovers yourself afterwards: `dropdb career_e2e_<run>`, the printed temporary directory, and `output/e2e-runs/<run>`.

## Requirements and status

- The disposable database is created and dropped through a local maintenance connection and owned by the `DATABASE_URL` role. The API therefore runs with its normal privileges. If that role lacks `CREATEDB`, which is the case for a hand-made `career` role on Homebrew, use a local admin connection that is only used to create and drop the database:
  `E2E_ADMIN_DATABASE_URL=postgresql://$USER@127.0.0.1:5432/postgres pnpm run test:e2e`.
  Without either, the run stops before it starts anything.
- Playwright Chromium is installed by bootstrap. `pdftotext` (poppler) is optional; without it, PDF text is not checked and the run prints a note.
- The type check runs without starting anything: `pnpm --filter @career/api exec tsc -p e2e/tsconfig.json`.
- Browser and fixture requests share pacing below the production rate limit. Production limits stay enabled.

## Last local verification

2026-10-04: v0.8.0 passed **31/31** general scenarios in run `c7fb6b4421e6` and **10/10** edge cases in `5b1711b7ec7d`, after adding a deterministic late-response regression. Disposable-stack teardown and isolation checks passed. The 241 domain/source/discovery/search/backup/integration/preparation/assisted checks also passed without skips. The additional v0.8 UI harness covers real cached execution plus mocked failure states, ES/EN, five viewport widths and 200% text scaling. Native Windows launch/stop, full Linux/WSL installation and a new-user study remain outside this local validation. See [v0.8.0 validation and limits](../releases/v0.8.0-validation.md).

## v0.3 assisted applications

The `assisted-application-preparation` scenario checks the actual isolated API, consent preview, EN/ES, cancellation and mobile width. It does not open or fill a real ATS. `pnpm run test:assisted` separately exercises synthetic Chromium forms and (with `CAREER_ASSIST_TEST_ADMIN_URL`) a disposable database. See [assisted applications](assisted-applications.md).

## Edge-case regression suite

Run `pnpm test:edge-cases` for the 2026-10-04 regression cases. It uses the same disposable stack and accepts `E2E_ADMIN_DATABASE_URL` as above. It covers concurrent application changes, terminal hiring stages, cancelling and confirming resume-draft replacement (including another destination), search-length validation, a 501-record tracker, pagination and search, detail-load recovery, temporary session-check outages, and English mobile layouts. Fictional provider caches prevent external job-feed requests. Screenshots and results are saved under `output/playwright/<run>/edge-cases/` and are excluded from Git.

## v0.8 search workflow

Run `pnpm test:search-ui` with the same local maintenance connection. The wrapper creates and removes its own isolated stack. It checks a real API create → queued execution → persisted result using a fictional provider cache, then exercises deterministic browser fixtures for source states, editing, consent, navigation, pagination, language and responsive layouts. Screenshots remain under `output/playwright/v080-<run>/`, outside Git. The browser fixtures do not measure the availability or relevance of live internet listings.

`pnpm test:searches` covers the source adapters, persistent runs, identity, database filters and preparation limits. Set `CAREER_JOB_SEARCH_TEST_ADMIN_URL` to a loopback maintenance database to run its database suites; without that connection those suites are skipped. `pnpm test:evals` runs the synthetic matching/ranking regression corpus without a database. Final release results and their limits are recorded in [v0.8.0 validation](../releases/v0.8.0-validation.md).

ES: `pnpm test:search-ui` comprueba el recorrido de búsqueda en una instalación desechable. Usa ofertas ficticias y conserva las capturas fuera de Git. `pnpm test:searches` comprueba fuentes, recuperación, filtros y límites; `pnpm test:evals` ejecuta los casos sintéticos de relevancia. Estas pruebas no representan una evaluación con personas nuevas ni de todo el mercado laboral.
