# Adzuna job search

Career Stack can optionally search Adzuna's public job listings for personal research. The adapter uses the documented HTTPS Search API, up to three pages of 20 listings per saved-search query, and a 24-hour query cache. Every returned page walk is recorded as `BOUNDED`; absence from a query never closes an existing job.

## Local credentials

Register for an Adzuna API ID and key, then add them to the private project-root `.env` file:

```dotenv
ADZUNA_APP_ID=your-local-app-id
ADZUNA_APP_KEY=your-local-app-key
ADZUNA_COUNTRY=es
```

Supported country codes are `at`, `au`, `be`, `br`, `ca`, `ch`, `de`, `es`, `fr`, `gb`, `in`, `it`, `nl`, `nz`, `pl`, `sg`, `za`, and `us`. The default is `es`. Restart the local API after changing the file. Do not add credentials to settings, issues, logs, fixtures, screenshots, or version control. The dashboard exposes only whether both credentials are present.

Only the search role, company and location are sent to Adzuna. Career Stack never sends a CV or contact details to this provider. Requests go to the fixed `https://api.adzuna.com` host, reject redirects, time out after eight seconds and cap response bodies at 4 MiB. Returned advert links are accepted only for the configured country's Adzuna domain and are upgraded to HTTPS.

## Limits and attribution

Career Stack applies a 2.5-second minimum between API requests, a 50-request daily cap, 300 per week, 1,200 per month, and a 24-hour cache per query. It reserves the maximum three requests before paging, so failed reads also consume the local budget. These local caps are deliberately below Adzuna's published default limits and may need adjustment if Adzuna changes its terms.

Every displayed Adzuna result carries a visible `Adzuna` link to the configured local domain, sized at least 116 × 23 CSS pixels. The original advert link remains available from the result. The API terms permit personal research; they require Adzuna attribution for published vacancy data and reserve organizational or other use for separate written permission. Do not use this source for organizational, academic, government, or hosted-service research unless Adzuna has granted the required permission.

## References

- [Adzuna Search API](https://developer.adzuna.com/docs/search)
- [Adzuna API Terms of Service](https://developer.adzuna.com/docs/terms_of_service)

The API and terms were checked on 2026-10-19. Adzuna may change its documentation, limits, access or terms; review these references before expanding or deploying this integration.
