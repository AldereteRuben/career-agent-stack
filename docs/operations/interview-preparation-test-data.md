# Interview-preparation test data / Datos de prueba de preparación de entrevistas

All interview-preparation tests use invented people, employers, job descriptions, facts, notes and answers. They must never read the developer's workspace, import a real CV, contact an employer, or send data to a provider unless a test explicitly injects a fake provider.

| Test layer | Fictional records |
| --- | --- |
| Domain | QA Engineer; TypeScript and Playwright requirements; one approved fictional achievement; one suggested Docker fact that must not count as evidence. |
| API and consent | Synthetic Co / Designer; approved and suggested facts, an unrelated fact, a submitted-resume sentence, and a private note used to prove that only selected categories enter a preview. The provider is an injected fake. |
| Browser E2E | A run-specific `Interview UI {marker}` QA role on `example.com`, one approved Playwright achievement, a user-written onboarding question and a fictional mock answer. The browser uses the disposable E2E workspace. |
| Encrypted backup and restore | `Ada Example` at `Fictional Co`, an `Example Engineer` offer, a synthetic approved fact, a note, a fictional question and answer, and evidence hashes. The integration suite creates a loopback-only disposable database and restores to a separately named disposable database. |

The run marker and generated UUIDs prevent collisions; they are not identity data. Assertions should match the fixture values and identifiers rather than reading or copying a developer profile. The E2E fixture proves the user-facing preparation flow and JSON export. The integration fixture proves that encrypted backup and isolated restore retain evidence provenance and linked session turns. Route tests separately prove workspace isolation, stale evidence, allowed AI payload categories and deletion.
