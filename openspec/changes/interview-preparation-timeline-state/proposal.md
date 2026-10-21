# Interview preparation state in the timeline

## Why

People can schedule an interview without remembering whether they prepared or practiced for it. Showing a small preparation state beside the interview makes the calendar useful for follow-through without exposing sensitive practice content.

## Scope

- Add a derived preparation status to interview items returned by `GET /api/v1/timeline`.
- Derive the status from the latest plan for the application and the latest session under that plan.
- Keep the endpoint workspace-scoped, read-only and limited to status metadata.
- Document the API field and cover the states, isolation and content privacy in integration tests.

## Out of scope

- Showing new labels or actions in the dashboard.
- Returning plan items, questions, answers, notes, feedback or learning items.
- Creating, updating or completing preparation data as a side effect of reading the timeline.
