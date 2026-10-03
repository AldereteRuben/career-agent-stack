# Job source validation (v0.2)

`apps/api/src/sources.ts` reads public job boards from Greenhouse, Lever and Ashby. It uses only each provider's documented, unauthenticated public read endpoint, with one `GET` per refresh. It never sends credentials, applies to jobs or writes to a provider.

## Primary references

| Provider | Official documentation | Endpoint the adapter calls |
| --- | --- | --- |
| Greenhouse | [Job Board API](https://developers.greenhouse.io/job-board.html) (now served from `docs.greenhouse.io/job-board.html`). It says GET endpoints need no authentication. | `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true` |
| Lever | [Postings API README](https://github.com/lever/postings-api/blob/master/README.md). It documents a global and an EU instance. | `GET https://api.lever.co/v0/postings/{site}?mode=json` and `GET https://api.eu.lever.co/v0/postings/{site}?mode=json` |
| Ashby | [Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api) | `GET https://api.ashbyhq.com/posting-api/job-board/{board_name}?includeCompensation=true` |

## Supported coverage

The `region` value is trimmed and compared without regard to case. Any provider/region pair not listed below is rejected **before any request is made**.

| Provider | Region | Host | Notes |
| --- | --- | --- | --- |
| `greenhouse` | `global` | `boards-api.greenhouse.io` | The Job Board API documents no other host. `eu` → `BOARD_REGION_UNSUPPORTED`. |
| `lever` | `global` | `api.lever.co` | |
| `lever` | `eu` | `api.eu.lever.co` | An EU site queried on the global host returns `200 []`. Live run: `lever` on `api.lever.co` returned 0 postings, while the same site on `api.eu.lever.co` returned 6. The region must match the board URL: `jobs.eu.lever.co` → `eu`. |
| `ashby` | `global` | `api.ashbyhq.com` | No regional host is documented. |

Any other `provider` value → `SOURCE_PROVIDER_UNSUPPORTED`. Tenants must match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$` (`BOARD_TENANT_INVALID`).

### Field mapping

| `ProviderJob` field | Greenhouse | Lever | Ashby |
| --- | --- | --- | --- |
| `externalId` | `id` (safe integer → string) | `id` | `id`, else the last path segment of `jobUrl` (not every documented example lists `id`) |
| `title` | `title` (entities decoded) | `text` | `title` |
| `location` | `location.name` | `categories.location`, else `categories.allLocations` joined with ` / ` | `location` |
| `description` | `content`: Greenhouse entity-encodes this HTML, so it is decoded once and then converted to text | `descriptionPlain` + each `lists[]` entry (`text` heading plus `content` items as `• ` lines) + `additionalPlain`. HTML fields are the fallback. | `descriptionPlain`, else `descriptionHtml` converted to text |
| `jobUrl` | `absolute_url` | `hostedUrl` | `jobUrl` |
| `applyUrl` | `absolute_url` | `applyUrl` | `applyUrl` |
| `postedAt` | `first_published` | `createdAt` (epoch ms) | `publishedAt` |
| `updatedAt` | `updated_at` | `null` (not documented) | `null` (not documented) |
| `raw` | job object as received | posting as received | job as received |

Rules applied to every provider:

- **Plain text.** The adapter removes scripts, styles and comments, keeps paragraph and line breaks, and turns list items into `• ` lines. It decodes named and numeric entities, collapses repeated spaces, and caps descriptions at 200,000 characters. Titles and locations are trimmed to one line of at most 300 code points, matching `varchar(300)`. Truncation never splits a surrogate pair.
- **Dates.** The adapter accepts ISO‑8601 strings (`YYYY-MM-DD[THH:MM[:SS[.fff]]][Z|±HH:MM]`) and epoch milliseconds between 1995‑01‑01 and one year after now. Any other date becomes `null`, including free text, epoch seconds and impossible calendar dates.
- **URLs.** Only absolute `https` URLs with a dotted host and no credentials are kept, and fragments are removed. Job URLs may be on a company's own domain, because Greenhouse `absolute_url` can point to a custom careers site.
- **IDs.** An ID is a non-negative safe integer, or a string matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$`, which fits `external_job_id varchar(300)`. Duplicate IDs within one feed are dropped after the first.
- **Listing.** Ashby jobs are surfaced only when `isListed === true`, as in v0.1.

## Failure behaviour

| Condition | Result |
| --- | --- |
| Non-2xx status | `SOURCE_HTTP_<status>` |
| Any redirect (3xx, followed response, or off-host final URL) | `SOURCE_REDIRECT_REJECTED`. Fetch also runs with `redirect: 'error'`. |
| Timeout (20 s) / DNS or socket error | `SOURCE_TIMEOUT` / `SOURCE_NETWORK_ERROR` |
| `Content-Type` present and not JSON | `SOURCE_CONTENT_TYPE_INVALID` |
| Declared `Content-Length` over the cap, or the streamed body passes the cap | `SOURCE_RESPONSE_TOO_LARGE`. The body is read as a stream and cancelled as soon as it passes 16 MiB. It is never buffered whole first. |
| Invalid UTF‑8 / invalid JSON | `SOURCE_ENCODING_INVALID` / `SOURCE_JSON_INVALID` |
| Wrong top-level shape, more than 10,000 jobs, or every job malformed | `SOURCE_SCHEMA_INVALID` |
| An individual malformed job (missing title, invalid URL or ID, malformed `%`-escape in an Ashby URL used for the ID, wrong types) | Skipped and counted in `skipReasons`. The rest of the board is returned. |

The cap was raised from v0.1's 2,000,000 bytes. On 2026‑10‑03 two of the real feeds below were larger than that: GitLab's Greenhouse board was 3,295,253 bytes and Ashby's own board was 2,053,621 bytes. Both would have failed every refresh under v0.1.

The exported contract is unchanged: `readBoard(board)` still resolves to `ProviderJob[]`, and `normalizeJobUrl` behaves as before. New exports are additive. `readBoardWithReport` adds byte, received, unlisted and skipped counts. `sourceHost` and `sourceUrl` resolve a board to its endpoint. The optional `SourceReadOptions` (`fetch`, `timeoutMs`, `maxBytes`) is a test seam.

## Tests (offline)

```sh
pnpm --filter @career/api exec tsx --test test/sources.test.ts
```

The tests use a deterministic fetch double and make no network calls. They cover:

- the endpoint, method and redirect policy for each provider/region
- region, provider and tenant rejection before any request
- HTTP 404/429/500/503
- all three redirect forms, timeouts and network errors
- declared and streamed oversize bodies, where the stream is cancelled near the cap
- a body exactly at the cap
- HTML content type, truncated JSON and invalid UTF‑8
- top-level schema errors, and per-job skips with reasons
- Greenhouse entity-encoded content, Lever `lists`, and Ashby unlisted jobs and URL-derived IDs
- date, URL and entity edge cases

## Live validation (opt-in)

```sh
pnpm --filter @career/api exec tsx scripts/verify-sources.ts --live [--out <summary.json>] [provider:region:tenant ...]
```

Without `--live` the script exits with code 2 and makes no requests. With `--live` it calls the production adapter once per target, one target at a time with a 1 s pause, and prints one JSON line per target. The line holds the endpoint, outcome, byte and job counts, field-coverage counts, date ranges, description length statistics, and two checks: `markupLeaks` (tags or entities left in plain text) and `offHostJobUrls`. The script prints and records **aggregate counts only**. No raw feed or posting text is written. The script exits with code 1 if any target errors or leaks markup, so expected negative targets make the exit code 1. Default targets: `greenhouse:global:gitlab lever:global:leverdemo lever:eu:lever ashby:global:ashby`.

### Recorded run — 2026‑10‑03 (Node 24, adapter v0.2)

| Target | Endpoint | Outcome | Bytes | Jobs received / valid | postedAt / updatedAt present | postedAt range | Markup leaks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `greenhouse:global:gitlab` | `https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true` | OK | 3,295,253 | 210 / 210 | 210 / 210 | 2026‑03‑06 → 2026‑10‑02 | 0 |
| `lever:global:leverdemo` | `https://api.lever.co/v0/postings/leverdemo?mode=json` | OK | 88,152 | 11 / 11 | 11 / — | 2017‑01‑17 → 2026‑09‑01 | 0 |
| `lever:eu:lever` | `https://api.eu.lever.co/v0/postings/lever?mode=json` | OK | 111,100 | 6 / 6 | 6 / — | 2020‑06‑03 → 2020‑07‑21 | 0 |
| `ashby:global:ashby` | `https://api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true` | OK | 2,053,621 | 62 / 62 | 62 / — | 2024‑03‑04 → 2026‑10‑02 | 0 |
| `lever:global:lever` (EU site, wrong region) | `https://api.lever.co/v0/postings/lever?mode=json` | OK, empty | 2 | 0 / 0 | — | — | 0 |
| `greenhouse:eu:gitlab` | none (rejected locally) | `BOARD_REGION_UNSUPPORTED` | — | — | — | — | — |
| `ashby:global:this-board-does-not-exist-zz` | `https://api.ashbyhq.com/posting-api/job-board/this-board-does-not-exist-zz?includeCompensation=true` | `SOURCE_HTTP_404` | — | — | — | — | — |

No jobs were skipped on any live feed. All job URLs were on the provider's hosted domain. In `leverdemo`, 1 of 11 postings has no description text at all.

## Known limits

- Lever's `skip`/`limit` pagination is not used. The adapter reads the full list, which the 16 MiB cap and 10,000-job limit bound.
- Greenhouse `content=true` includes full HTML for every job. Very large boards could still reach the cap, and they fail with `SOURCE_RESPONSE_TOO_LARGE` rather than being partially read.
- New boards reject unsupported provider/region combinations at creation. A legacy Greenhouse or Ashby board saved with region `eu` fails at refresh with `BOARD_REGION_UNSUPPORTED` instead of being read from the global host.
- Board refresh uses `readBoardWithReport` and reports `coverage: 'PARTIAL'` with a `skipped` count when per-job validation drops jobs.
- Changing description formatting changes snapshot hashes, so the first v0.2 refresh of an existing board stores one new snapshot per job.
