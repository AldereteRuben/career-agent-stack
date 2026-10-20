# Tasks

- [x] 1. Extend the pure tracking-metrics calculator with source, role, and country groupings; preserve the existing cohort and totals. Proof: `apps/api/test/tracking-metrics.test.ts` covers multiple providers, unknown source/country, normalization, and the five-application threshold.
- [x] 2. Extend the workspace-scoped endpoint to load only explicitly linked source providers for cohort jobs. Proof: isolated `tracking-metrics` E2E verifies source attribution from persisted synthetic rows; passed in CI run 39212283552.
- [x] 3. Render the three independent breakdowns in Spanish and English on the overview, with exact counts, small-sample suppression, and a clear country-data limitation. Proof: `tracking-metrics` E2E checks both locales and phone width; passed in CI run 39212283552.
- [x] 4. Record the behavior and limits in this OpenSpec change and issue #111.
