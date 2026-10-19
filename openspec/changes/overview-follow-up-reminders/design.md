# Design

The overview requests the existing timeline endpoint for `INTERVIEW` and `FOLLOW_UP` over the local day through 30 days ahead. The API already returns overdue follow-ups independently of the selected date range.

A small client component displays a card only when it has events or needs to explain a loading error. It shows up to three overdue items and three upcoming items, with the event date, local time when present, role/company, and a direct application link. The full timeline remains the place to see all events. Refresh uses the existing local refresh hook and does not trigger a new job search or provider request.

The card stays bilingual and stacks event details on narrow screens. It does not create or modify application data and introduces no new permission or notification behavior.
