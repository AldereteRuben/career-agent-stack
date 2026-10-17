# Tasks

## 1. Application follow-up and interviews

- [x] 1.1 Persist next step and follow-up date, validate real calendar dates, and keep follow-up edits in application history; domain tests and API typecheck pass.
- [x] 1.2 Persist interview wall time as a UTC instant plus IANA time zone; reject invalid, nonexistent, and ambiguous wall times; Europe/Madrid winter/summer and daylight-saving boundary tests pass.
- [x] 1.3 Add bilingual tracker controls, due-state badges, and follow-up sorting; add a browser scenario for tracker behavior. Dashboard and E2E typechecks pass; browser execution awaits CI because this isolated checkout has no `DATABASE_URL`.

## 2. Resume profile and contact selection

- [x] 2.1 Add optional phone, city, and up to four labeled HTTPS links to profile validation and editing; add an ES/EN browser scenario with Unicode and long text. Runtime browser execution awaits CI because this isolated checkout has no `DATABASE_URL`.
- [x] 2.2 Allow each generated PDF to select available contact fields and retain that selection for manual and AI-assisted generation and document freshness checks; AI-document selection tests pass. Real-PDF persistence test is gated on its disposable-database setting and was skipped locally.
- [x] 2.3 Add the professional-summary fact to the existing approval flow and verify contact details remain absent from AI snapshots and prompts; the privacy snapshot test passes.

## 3. Verification

- [x] 3.1 Run the available unit, typecheck, lint, API test, and strict OpenSpec checks using synthetic data only; update capability specs. Migration integration and browser runtime tests were skipped because this checkout has no disposable-database URL; CI will run those checks.
