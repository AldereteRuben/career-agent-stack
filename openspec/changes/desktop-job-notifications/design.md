# Design

## Delivery

`desktop_notification_settings` stores an explicit workspace opt-in and the app locale. It has no row by default, which is equivalent to disabled. The V1 and V2 automatic search finalizers insert a count-only row in `desktop_notification_events` inside their existing successful-write transaction. V2 events are unique by workspace and run. Manual V2 runs and unsuccessful or partial runs do not enqueue alerts.

The API worker claims events with `FOR UPDATE SKIP LOCKED` and a short lease, rechecks the opt-in immediately before sending, then records the result. Turning the setting off atomically marks pending and claimed events disabled. A process crash between OS delivery and acknowledgement can cause a retry after the lease expires; exact-once delivery cannot be guaranteed across a database and an external OS notification process. Notification text contains only the result count, and the native notification group is not populated with job data.

## Native provider and privacy

Use the platform-specific local provider from `node-notifier`, with no remote service. macOS and Linux are supported in this change. Windows currently reports the provider unavailable: its toast callback waits for user activation and cannot be bounded, which would make disabling notifications block indefinitely while the worker holds the opt-out lock. Its action launches the configured loopback web origin at `/jobs?view=new`; the origin must be localhost, `127.0.0.1`, or `::1`, and the browser opener receives an argument without shell interpolation. The user must be logged into the local desktop session for OS notifications to appear.

There is no portable permission-query API across macOS, Windows, and Linux. Settings reports provider availability and the last accepted/failed send, says that OS settings decide final visibility, and offers a test notification. It must not claim that an accepted send proves OS permission is granted.
