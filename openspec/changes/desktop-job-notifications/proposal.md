# Proposal

## Why

Automatic saved searches are easy to miss while Career Stack is in the background. Issue #38 proposes a local, privacy-safe operating-system notification after a successful automatic run finds new jobs.

## What changes

- Add an opt-in desktop notification setting, off by default, with a test button in Settings.
- Queue one count-only notification in the same database transaction that completes an eligible automatic search; never notify for manual runs, failures, partial runs, or zero new jobs.
- Deliver through the local OS notification provider on macOS and Linux. Windows reports the provider as unavailable until it can support a bounded delivery call; an explicit notification action opens the local jobs list where supported.
- Localize notification text using the app language saved in Settings. Do not put job titles, companies, salaries, descriptions, or URLs in notification content.
- Show whether the provider is available and whether the last send was accepted or failed. OS permission itself is not queryable consistently across all supported platforms; the test notification is the supported way to request/verify it, and OS settings remain authoritative.
- Disabling notifications marks queued events disabled so re-enabling does not replay old alerts.

## Out of scope

Email, browser service workers, remote notification services, mobile notifications, digests, and notifications for search errors or manual runs.
