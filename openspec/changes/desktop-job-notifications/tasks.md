# Tasks

- [x] Add database settings and privacy-safe event queue with migration and deletion coverage.
- [x] Enqueue eligible V1/V2 automatic search results transactionally and prevent replay after opt-out.
- [x] Add local OS notification provider, guarded loopback click-through, and delivery worker.
- [x] Add bilingual Settings control, test notification, and honest provider/permission status.
- [x] Add unit and disposable-database coverage for privacy, localization, opt-in, completion status, manual runs, and disabled delivery.
- [x] Run local typecheck, lint, build, search/deletion/integration/UI tests, OpenSpec validation, and the concurrency/privacy/migration review.
- [x] Run CI after opening the draft PR; all required checks passed in run 39209639940.
- [x] Confirm the proposed design in issue #38 before promoting this draft to ready for review; confirmed in issue comment 6261723728.
- [x] Verify the Settings panel in Spanish and English at 390 px, confirm no horizontal overflow, and exercise persisted opt-in/opt-out in the headed isolated E2E scenario.
