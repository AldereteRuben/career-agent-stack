# Design

The profile page already loads the workspace's facts. A client component receives them and filters strictly to `USER_APPROVED`; a pure helper creates deterministic text from structured employment facts and approved summary entries. Every generated item displays its supporting approved statement and the copy button includes those statements in the clipboard payload.

The component reuses the existing workspace-local `/skill-gap-report` route. Gaps remain observations about saved listings, not proof of missing capability. Suggested portfolio work is labeled as an idea and links back to the listings that prompted it. No AI provider or LinkedIn integration is used.

The UI uses headings, lists, buttons and links in document order, with bilingual labels and wrapping styles for narrow screens. Copy failure leaves the text visible and selectable.
