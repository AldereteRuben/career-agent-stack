# Design

The timeline API adds `interviewPreparationStatus` to each `INTERVIEW` item. The finite values are `NO_PLAN`, `PLAN_READY`, `MOCK_IN_PROGRESS` and `MOCK_COMPLETED`.

For the interview applications already selected by the date and type filters, the API selects only the newest plan ID per application in the requesting workspace. It then selects only session IDs and statuses for those plan IDs and derives the newest session status. A plan with no sessions is `PLAN_READY`; an application with no plan is `NO_PLAN`. Neither query reads plan items or session turns. The operation is read-only and makes no per-interview request.

The API and dashboard timeline types describe this field, while the dashboard presentation remains unchanged for this change. The operations guide documents the values and privacy boundary. Integration coverage exercises each state, newest-plan/newest-session precedence, workspace isolation, absence of session content, and no writes during a GET.
