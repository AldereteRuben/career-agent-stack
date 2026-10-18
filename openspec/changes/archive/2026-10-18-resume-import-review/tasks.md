# Tasks

## 1. Parsing without AI (T4, T8)

- [x] 1.1 Add `parseResume`, `parseResumeDateRange`, `resumeHeading` and `resumeProposalFact` in `packages/domain/src/resume-sections.ts`, with fictional Spanish, English and bilingual fixtures (`packages/domain/test/resume-fixtures.ts`). Proven by `packages/domain/test/resume-sections.test.ts` in `pnpm run test:unit`.

## 2. Preview and review screen (T5)

- [x] 2.1 Add preview and review logic (duplicates, default selection, pending imports, bilingual error copy) in `apps/dashboard/lib/resume-import.ts`. Proven by `apps/dashboard/lib/resume-import.test.ts` in `pnpm run test:ui-logic`.
- [x] 2.2 Add `/profile/import` with PDF and paste input, preview, save, per-entry confirm/correct/discard, explicit batch confirmation and whole-import undo. Proven by dashboard typecheck, lint and the `resume-import-pdf-review-to-matching` browser scenario.

## 3. Entry points and documentation (T11, T9)

- [x] 3.1 Link the import from the profile shortcuts, the profile entry card (pending imports) and the profile setup guide. Proven by the browser scenario, which starts from the profile link.
- [x] 3.2 Document the import in `README.md`, `README.es.md` and `docs/operations/assistant.md`, and update the ADR 018 status.

## 4. Verification

- [x] 4.1 Run `pnpm run test:e2e` with `E2E_ONLY=resume-import-pdf-review-to-matching` in the isolated stack. The final isolated run passes the sign-in setup and complete import-to-matching flow.

## 5. Follow-up

Codex-assisted import (ADR 018, task T6) remains deferred by design and is out of scope for this change.
