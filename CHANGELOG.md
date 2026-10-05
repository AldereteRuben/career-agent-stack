# Changelog

## 0.9.2

- One search creation method at a time: describe the role with Codex or choose filters. Switching methods keeps the draft; account connection stays inside the search.
- Compact automatic-search status and on-demand explanations keep offers closer to the top. Similar search names include location, work mode, frequency and a distinguishing number.
- Job-specific summary links open and focus the correct assistance section after asynchronous loading. Search cards show summaries in progress or saved, scoped to the job and language.
- A visible automatic-summary guide lets people choose a job, review the first summary and then explicitly authorize future summaries with a daily limit.
- Refresh local assistant state on focus; retry failed capability reads. An automation status failure does not hide the working account connection.
- Show the linked CV approval status and prioritize reviewing pending CVs over downloading them.
- Explain account refresh, display friendly plan names and distinguish portal failures from cached or bounded results.
- Accept Himalayas timestamps in Unix seconds, milliseconds and ISO format. Version its reader cache so old parse failures do not block a corrected read; host limits remain enforced.
- No new migration, provider or automatic permission. See [upgrade, verification and limits](docs/releases/v0.9.2.md).

## 0.9.1

- Prevent duplicate application tracking when selecting a resume for equivalent job records.
- Exclude expired saved answers from preparation and require a new reviewed version; show expiry in the profile.
- Preserve manually edited assistant answers on repeated review and retain natural-language search drafts across navigation.
- Remove obsolete profile selections with a clear notice after a profile revision.
- Recover failed and interrupted tasks, retry history reads, and reconnect to an existing task after a concurrent start.
- Reject replay of an assistant preview whose task was deleted, requiring a fresh sharing review.
- Refresh permissions and automatic-summary settings together after revocation or pause.
- Read provider-reported quota before Codex dispatch; unavailable quota remains unknown.
- Align the application tracking button and serialize local starts to avoid simultaneous builds. Disable pnpm dependency reinstallation before launcher coordination.
- No new migration or provider. Claude remains deferred; all new AI checks use synthetic data and mocked inference. See [upgrade and verification](docs/releases/v0.9.1.md).

## 0.9.0

- Optional official Codex connection with masked account confirmation, explicit sharing previews, revocable permissions and observed subscription limits. Native execution is certified only for macOS and CLI 0.160.0 with ChatGPT plan authentication; Claude is deferred.
- Contextual help for editable search criteria, evidence-backed job summaries, resume wording with exact-PDF review, and unapproved answer drafts. Ordinary searches remain usable without AI.
- Optional future-job analysis for selected searches and facts, off by default, with local daily limits, manual priority, pause and no historical bulk regeneration.
- Durable scoped queue, account-change invalidation, cancellation, stale-source checks and persisted results; no application retry after uncertain inference and no paid API fallback.
- Additive migration 0010 preserves prior PDFs. Export omits connection context; backup restore revokes grants, pauses policies and interrupts unfinished work while retaining history.
- ES/EN controls and privacy wording distinguish local storage from optional external processing. See [setup and limits](docs/operations/assistant.md) and [release evidence](docs/releases/v0.9.0-validation.md).

## 0.8.2

- Open directly in Find jobs and keep three primary destinations: Find jobs, Saved jobs and My applications. Profile and tools contains the remaining screens, including the previous overview.
- Start a search with a role and optional location. Reveal company, work mode, sources and frequency only when needed; restored nondefault criteria stay visible.
- Check immediately and repeat daily by default while the local service runs, without requiring a profile or resume. Source choices, permissions and automatic preparation defaults are unchanged.
- Offer Edit and Pause directly for one search; retain visible search choices and management for multiple searches.
- Keep Save job near the job title, show the description before optional fit analysis, and guide application preparation in context.
- Use scope-specific job titles and useful empty states; manual import and tracking remain available as secondary actions.
- Cover first-use ES/EN flows, keyboard navigation, mobile layouts and existing search/application regressions in isolated browser tests.
- Upgrade and verification: [v0.8.2](docs/releases/v0.8.2.md). No new migration or source.

## 0.8.1

- Put job results first, keep searches visible as compact choices, and move management and portal detail into secondary controls.
- Distinguish running, failed, limited, paused, first empty and already-reviewed searches; adjusting a search opens the correct edit flow.
- Explain when an early repeat check can run again; an already-running check no longer reads as a revision conflict.
- Share reviewed/saved/archived state across search results, found jobs and counts. Restoring a job keeps it reviewed; safe identity groups share decisions and conflicting groups stay separate.
- Refresh deduplicated totals and each search count immediately after a decision, preserving result focus and background-arrival behavior.
- Use Found jobs for the complete list and Saved for chosen jobs, with consistent ES/EN actions and keyboard-accessible filters.
- Guide missing profile details with the job context preserved. Approved resumes continue toward the application; tracking and PDF inspection stay available as secondary actions.
- Improve card spacing and mobile result visibility, and add isolated regression coverage for these paths.
- Upgrade and verified limits: [v0.8.1](docs/releases/v0.8.1.md). No new migration or source.

## 0.8.0

- Save searches promptly and process persisted, revision-bound runs in the background, with per-source progress and recovery.
- Add bounded Himalayas search and confirmed-company results; preserve existing source choices until opt-in.
- Explain bilingual role matching and location uncertainty, group strong job identities without deleting history, and retain review state per search.
- Add a daily inbox, visible search cards, saved/archived filters and stable background-arrival notices.
- Show first results automatically and prevent late detail reads from reverting a successful job review.
- Limit enhanced automatic preparation and protect existing applications; restored automation remains paused.
- Verification and limits: [v0.8.0](docs/releases/v0.8.0.md).

## 0.7.2

- Protect application updates from stale tabs and resume drafts from unconfirmed replacement.
- Paginate and search the application tracker; open records by ID independently of the current page, including histories above 500 records.
- Hide preparation actions for terminal hiring stages, retry temporary session-check outages without redirecting to login, and reject oversized search criteria without truncation.
- Add isolated edge-case regressions covering conflicts, draft replacement, large histories, recovery, and ES/EN mobile behavior.

- Preserve profile input and anchor focus during asynchronous loading; avoid unnecessary draft replacement prompts after PDF generation.
- Verification and existing limits: [v0.7.2](docs/releases/v0.7.2.md). No new migration or external source.

## 0.7.1

- Keeps browser tab metadata in the selected language and removes a vulnerable transitive esbuild version from the migration tooling.

- Search-first onboarding, visible saved-search cards, simpler defaults and preserved search context through profile, resume and application screens.
- Local results and preparation queues refresh while visible and when returning to the tab. Background arrivals preserve focus, drafts and action errors without querying providers again.
- Inline search errors focus the missing criterion; failed source checks retain honest recovery guidance instead of suggesting filter changes. Broad locations are labelled as requiring confirmation.
- One automatic preparation action is available from jobs, the profile and applications without a resume. Saving experience leads directly to explicit confirmation; generated resumes open for review.
- Unsent records say “No contact yet”, manual state corrections are secondary, and unsupported forms offer a direct manual continuation. Closed applications do not offer another submission. Preparation and submission activity is localized.
- Imported HTML descriptions render as readable text; provisional matches do not show a misleading score. Compact job metadata, responsive controls, shorter guidance and consistent resume views reduce unnecessary scrolling.
- Validation and release evidence: [v0.7.1](docs/releases/v0.7.1.md). No new data migration, external provider or unattended submission capability.

## 0.7.0

- Saved automatic searches by role and/or company, optional location/work mode, and selectable 6/12/24-hour schedules. Remotive and Arbeitnow public feeds need no API keys or manually entered employer URLs. Source links, attribution, coverage and freshness are visible; source reads are shared and rate limited across searches.
- Find jobs becomes the first action on Home. Saved searches can be edited, paused and resumed. The creation form closes after saving so results take priority; lists include pagination, next-check times and ES/EN mobile layouts.
- Optional automatic application preparation selects confirmed profile facts and approved answers, creates a PDF awaiting review, and records missing details. Repeated inputs reuse the draft; changed inputs update the same application while preserving old PDFs and protecting approved documents and submitted/uncertain applications.
- Experimental single-application Lever submission adds separate authorization for the exact contact values and approved PDF. One-use permits prevent concurrent/double sends. Confirmation requires a successful submission response and a new visible receipt; uncertain outcomes block retries until reconciled. Manual handoff remains available.
- New additive search migration, private export support, and backup restoration that pauses saved searches and disables preparation. Schedules require the local service and computer to remain running.
- Validation uses disposable databases, fictional feeds, synthetic browser forms and isolated UI flows. No employer applications are sent during development tests.

Coverage is limited to the public source feeds, not LinkedIn or the whole web. Remotive listings have a 24-hour delay. Preparation uses deterministic evidence matching, not AI-generated claims. Automatic sending is experimental: public Lever forms inspected for this release required CAPTCHA/custom controls and remain manual-only; real-employer submission is not verified. See [release evidence and limitations](docs/releases/v0.7.0.md).

## 0.6.1

- Company confirmation and disabling use company-specific labels, distinct from global automatic discovery.
- New-to-review jobs check for background changes while visible and when returning to the tab. An explicit Update results action preserves filters; cards and focus stay in place until the update is requested. Background errors preserve existing results and offer retry.
- Lists recover to a valid page after the last item on a page is reviewed, retaining query, availability and scope.
- Mark as reviewed shows a success notice with keyboard continuation. Failed attempts remain retryable and a successful retry clears the error; reviewed archived jobs retain accurate archive copy.
- Initial discovery errors replace loading feedback. Refresh failures label cached state Out of date, hide unverified schedules and block setting changes until recovery. Status polling and action errors are separate; stale reads cannot overwrite a toggle.
- Failed and interrupted checks do not promise retries while paused. Company refresh failures reload cooldowns immediately, and recovered company-list reads clear their own prior loading error.
- Isolated browser regression covers ES/EN, narrow layouts, failure/recovery, review focus, pagination and asynchronous arrivals without real employer requests. No data migration or automation preference change.

## 0.6.0

- Opt-in automatic discovery of confirmed Greenhouse, Lever and Ashby company boards, integrated into the local API lifecycle. Schedules survive restarts and catch up once when overdue; the browser tab can be closed.
- Shared manual/automatic refresh service with PostgreSQL locking, six-hour intervals with jitter, bounded exponential backoff and Retry-After support. Failed and partial reads preserve saved jobs and never infer closures.
- Home and Companies I follow show search status, activation/pause, last results and the next check. New companies must still be confirmed; expired and disabled companies are excluded. All controls and explanations are available in ES/EN.
- New to review inbox ordered by profile fit, scoped to this workspace, with explicit Mark as reviewed. Reviewed jobs remain available under Active; repeat discovery preserves favorites, archives and review state.
- Additive migration keeps existing jobs, documents and settings. Automation starts paused; restoring a backup explicitly pauses automation, including compatibility with older backup schemas.
- Company-entry fields, help text and actions stay within their card at desktop and mobile widths. Add a company from the search panel or Home opens the form and focuses its name field when ready.
- Automated coverage includes fictional source execution, persistence, cooldown/concurrency, retries, review scope, backup restoration, and isolated browser flows in ES/EN at mobile sizes.

Local-only: checks require the service and computer to be running. No system startup service, whole-web search, AI tailoring, email access or automatic application submission is added. Source execution is tested with fictional feeds; no new real-employer submission validation is claimed.

## 0.5.3

- Notices with actions (unsaved job and application drafts, note drafts, stage and “sent” confirmations, retry and reload prompts, stale-resume prompts) keep their text at full width and place the buttons below it, wrapping within the screen. At 320 px and 390 px there is no horizontal overflow in Spanish or English. Reading and keyboard order is message first, then actions; roles are unchanged.
- Applications → Review or change resume opens the linked PDF first, marked as linked to this application. From there you can choose another approved resume or use it as a starting point, keeping the application and job context; reload, Back and closing the preview keep the right document. Previews of approved resumes and the library offer the same actions, and the linked resume is not offered for linking again.
- Home links for pending profile details open the list of saved details instead of the add form. The profile lands on the requested section and moves focus to it once the profile has finished loading; later reloads after saves do not move scroll position or focus. Adding and reviewing remain separate links.
- An existing PDF stays approvable, linkable and usable for assisted preparation while everything it prints is unchanged: the name and email of the profile revision it was generated from, and each source fact (the same entry or an exact copy carried into a newer profile revision, still confirmed, printing the same text). Saving only job preferences, work country or other unprinted fields no longer asks you to regenerate it. A different printed name or email, edited, rejected or archived facts, claims without evidence, or a different job context still block it. Approval, application linking, assisted preparation and consent, and the guide use the same check. Stored PDFs are never rewritten; their hashes are unchanged.
- Assisted consent now covers the destination, application version, displayed fields and exact PDF, without the profile revision id, so a preference-only save does not void a prepared consent. Printed-identity or fact changes still invalidate it.
- The isolated E2E harness prepares the PDF.js assets inside its private dashboard copy, so it also works on a fresh checkout or worktree.
- Regression coverage: domain tests for printed identity, printed statements and stale/current decisions; disposable-database tests for preference-only revisions, name/email changes and restoration, edited/rejected/changed-detail/evidence-free sources, linking and consent; E2E scenarios for notices at 320/390 px, linked-resume review and change, landing on saved details, and preference changes made through the profile form. v0.3.1, v0.5.1 and v0.5.2 scenarios that treated any profile save as stale now use real printed-identity changes and also assert that unprinted changes keep PDFs current.

Limits: PDFs generated before the PDF language was recorded are compared against both Spanish and English renderings of the same unchanged fact. A PDF without a recorded profile revision is treated as stale after any profile save. Existing backup-restoration, platform and dependency-alert limitations still apply.

## 0.5.2

- PDF previews pass independent byte buffers to PDF.js, removing the temporary URL lifetime race during navigation and retries. Existing PDFs remain unchanged.
- Pending resumes whose source profile changed explain why a fresh version is needed before offering approval. Creation returns the same readiness and job metadata as the library; the library refreshes when opening a preview or returning to the window.
- Reusing a resume restores its job, language and selected facts across navigation/reload, while preserving an explicitly selected application or job. Unavailable source jobs and draft-storage failures have actionable feedback.
- Resume headings distinguish preparation, review and saved documents. Prepare resume always opens the builder. Profile has one primary continuation action. The stale-resume notice keeps its text and action within mobile widths.
- Regression coverage exercises repeated PDF opening, reload and Back navigation, stale-profile recovery, original-job and explicit-application context, unavailable jobs, and mobile layouts in Spanish and English.
- Includes the validated dependency maintenance merged after v0.5.1: Drizzle, rate-limit, dotenv, Node 24/React declarations, supported TypeScript lint peer and pinned GitHub Actions.

Existing backup-restoration, platform and dependency-alert limitations still apply.

## 0.5.1

- Home's main action now names its actual destination. The first-resume guide resumes a current PDF awaiting review instead of asking for another copy.
- Resume library and preview state live in the URL. Reload, Back and Forward keep the selected view/document. Closing a preview and changing its content are separate actions; reusing a PDF preserves its recorded language.
- Saved resumes show creation date/time, version and PDF language. A nullable language column records new PDFs; older files remain unchanged and show “Language not recorded”.
- Sign out is a separate button, explains draft loss before leaving, and clears drafts only after the session is successfully closed. A failed sign-out keeps the session and drafts recoverable.
- Profile job preferences and repeated guidance are folded; saved-state badges are quieter. Opening job, application and company forms moves keyboard focus to their headings.
- Backup results show their creation time. JSON export is under advanced options. Repeated profile/resume actions have labelled groups for accessibility.
- Verification covers upgrade preservation, resume reload/history, pending-review continuation, optional preferences, form focus, and cancelled/failed/successful sign-out, in ES/EN and mobile layouts.

Known limits from v0.5.0 still apply: backup restoration needs a terminal, backup download links last until another backup or API restart, native Windows startup is unsupported, and dependency alerts remain pending. No existing profile entries or PDFs are deleted by this patch.

## 0.5.0

- Bilingual getting-started guide: name/email, confirmed experience, and a reviewed first resume. Progress comes from saved data; drafts survive reloads and concurrent profile changes are handled without discarding them.
- Home keeps job preferences optional and links back to the guide. Completed guides open the saved resume library directly.
- Shorter sign-in screen with expandable, operating-system-neutral instructions.
- Settings creates a verified database/PDF backup without a terminal, with progress, retry, and separate archive/key downloads. It uses the running API configuration, authenticated downloads, private temporary files, and the existing verified archive writer.
- Release procedure recorded in AGENTS.md: validation, main push, annotated tag, published GitHub release, and remote verification for every completed version.
- E2E actions now have bounded timeouts; screenshots disable transitions to avoid capturing a sidebar mid-animation.

Limits: restoration still requires a terminal. UI backup links are available until another backup or API restart; completed copies remain under `data/backups`. Backups are not encrypted and old copies are not removed automatically. Native Windows startup/shutdown and full Linux/WSL installation remain unverified/unsupported as documented. Existing dependency alerts remain pending.

## 0.4.1

Usability improvements in Spanish and English.

- Guided sign-in with a masked access-code field and a macOS recovery launcher that creates and copies a new one-time code. Existing sessions and workspace data are preserved.
- Consistent job/application terminology, clearer empty states and manual job entry instructions.
- Resume prerequisites appear before the builder; name, email and confirmed experience are required in the UI. Country is optional for resume preparation.
- Opening a PDF moves keyboard focus to the preview; closing it restores focus. Cancelling profile edits returns focus to saved entries.
- Company forms preserve drafts in the current tab, explain the two required links and clearly state that job refreshes are manual.
- Settings distinguishes recovery backups from JSON data exports and puts technical capability details behind an expandable section.
- A shared release constant supplies the API and dashboard version.
- Updated shared branding, aligned profile controls and select arrows, full-width prepare/saved-resume views, compact saved resume actions and aligned company panels.
- Generic installation wording with operating-system-specific shortcuts clearly labelled.

Validation on macOS: production build, TypeScript, ESLint, 108 unit/integration/synthetic-browser checks, all 17 E2E scenarios (run 91c30fb02eb3), and a clean-install smoke including isolated access-code recovery. The ES/EN layout and focus scenario includes 1096px desktop and 390px mobile captures. GitHub CI passed Linux quality checks and Windows/Linux build plus domain-test jobs (run 37123530516). Backup restoration still requires a terminal. Native Windows startup/shutdown is not supported by the Unix-based launcher; Windows/Linux CI covers build and domain tests, not full installation. No live workspace credentials were reset.

## 0.4.0

A connected profile-to-application workflow. See [verification and limitations](docs/releases/v0.4.0.md).

### Added

- Structured work experience and education with editable dates and current-position/study fields. Canonical older employment entries can be edited as fields; ambiguous text is preserved.
- Profile → Resume → Application navigation preserves the job. Approved resumes can be linked to an application and remain selected for assisted preparation. Repeated continuation reuses the existing open application.
- English/Spanish PDF language selection and zoom controls with scrolling contained within the preview.
- Job title/company search, favorites and availability filters, reversible archiving, and pagination with URL-persisted filters.
- Additive database migration for entry metadata and application-resume links, with upgrade regression coverage.

### Preserved

- Earlier profile text, PDF bytes and application history remain intact. Resume changes are blocked for submitted/closed applications and active assisted attempts.
- Employer submission remains manual. Public-repository preparation and dependency alert follow-ups remain deferred.

## 0.3.1

Profile, resume and draft reliability fixes. See [verification and limitations](docs/releases/v0.3.1.md).

### Fixed

- Resume reuse resolves unchanged copies of facts across profile revisions, including existing data. Edited or archived content is excluded with actionable feedback.
- Editing a profile entry creates a new revision requiring confirmation; earlier PDF content stays intact. Entries can be archived and restored.
- Assisted application options expose only currently usable approved resumes, with a route to regenerate outdated versions. Server checks remain authoritative.
- Job imports, manual application forms and per-application notes survive navigation and reloads in the same tab. Explicit sign-out clears their session drafts; failed saves retain them.
- Job search distinguishes no matches, no saved jobs, loading and request failure, and ignores stale search responses.

### Improved

- Clearer EN/ES navigation, home guidance, profile sections and work-experience date inputs.
- Local PDF preview, readable one-column resume layout and explicit review-state guidance; no draft watermark in generated PDFs.
- Release labels, startup READMEs and third-party notices updated.

## 0.3.0

Assisted applications with explicit consent and manual submission. See [verification and limitations](docs/releases/v0.3.0.md).

### Added

- Experimental contact-field autofill for hosted Lever forms in a visible local browser.
- One-use, expiring consent bound to the destination, profile, selected resume and application version.
- Same-window review and explicit manual handoff; files, custom questions, legal consents, CAPTCHA and submission remain manual.
- Durable attempt history and explicit reconciliation of unknown outcomes; no automatic resubmission.
- Session/restart/restore invalidation, bilingual guidance and synthetic browser/database/UI regression coverage.
- Noncommercial license, personal job-search permission and contribution templates included in this tagged release.

### Limits

- No real employer submission was performed in validation. Lever support is experimental and has no universal-compatibility promise.
- Public-repository preparation and dependency alert follow-ups remain deferred; visibility remains private.

## 0.2.0

Local reliability and recovery release. See the [release verification notes](docs/releases/v0.2.0.md) for the checks performed and platform limits.

### Added

- Coordinated database and document backups with integrity manifests and isolated restoration.
- Repeatable clean-install verification and clearer setup recovery messages.
- Deterministic source-adapter regression tests and an opt-in real-feed validation command.
- Export progress, retryable errors, and browser verification of downloaded JSON.

### Improved

- Bounded streaming reads and validation of external job feeds.
- Job descriptions preserve paragraph breaks and provider-specific requirements sections.
- Partial feed results are identified in the interface.
- Release labels and user guidance in English and Spanish.

## 0.1.0

Initial local workspace: bilingual dashboard, approved profile facts, scoped answers, manually saved and discovered jobs, explainable matching, versioned PDF drafts, application history, and JSON export.
