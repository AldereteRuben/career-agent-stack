# Spec Delta

## Purpose

Lets the person optionally ask Codex to reword sentences of an existing local draft, only with per-draft confirmation of the exact payload, with cited sources and without any invented fact. Codex never drafts a document from scratch. Rewording is a synchronous request, controlled like any other Codex run, whose proposals are returned in the response and stored nowhere until the person accepts them.

## ADDED Requirements

### Requirement: Explicit per-draft confirmation with an exact payload
Codex rewording SHALL be off by default, SHALL only reword sentences the local builder already produced, and SHALL be confirmed for each draft. A remembered or standing consent, and any automation policy, SHALL NOT authorize a document request. Without confirmation nothing SHALL be sent.

#### Scenario: Preview then send
- **WHEN** the person asks Codex to reword a cover letter
- **THEN** the preview lists every sentence to be sent and sending happens only after "Confirm"

#### Scenario: Remembered consent is not enough
- **WHEN** the person previously allowed assistant help and asks for a document rewording
- **THEN** the preview and a new confirmation are still required

#### Scenario: Preview equals payload
- **WHEN** the person confirms a previewed request
- **THEN** the data received by the provider is byte-identical to the previewed payload, and if a sentence changed after the preview the request is refused and nothing is sent

#### Scenario: Automatic origin
- **WHEN** a request for document wording comes from an automatic origin (scheduled, background or automation policy)
- **THEN** it is refused, no run is recorded and nothing is sent

### Requirement: The rewording run obeys the assistant's run controls
Each confirmation SHALL create its own one-off consent record, and the run SHALL be recorded as operation `DOCUMENT_REWORD`, directly as running and never queued. It SHALL hold the Codex account lease and the workspace's single running slot and abort on timeout or client disconnect. A busy account or workspace SHALL be refused with `409 AI_BUSY`. The worker SHALL NOT claim it and the queue's validity pass SHALL NOT cancel it. There is no manual daily budget.

#### Scenario: Worker does not claim the run
- **WHEN** a rewording run is in progress or has finished
- **THEN** its record is never in the queued state, the worker does not claim or execute it, and the queue's validity pass leaves it running until the route ends it

#### Scenario: Crash during a run
- **WHEN** the API stops while a rewording run is in progress
- **THEN** the run record expires as interrupted, the account lease is freed, and queued runs in the workspace can proceed

#### Scenario: Account or workspace busy
- **WHEN** a queued assistant run holds the Codex account lease, or a run in the workspace is running or cancel-requested
- **THEN** the rewording request is refused with `AI_BUSY`, nothing is sent and no proposal hash is recorded

#### Scenario: Usage without a budget
- **WHEN** a rewording run completes
- **THEN** its usage is recorded, the run uses the UTC control day and the manual reservation counter is unchanged; no daily budget refuses it, and only a busy account or workspace does

#### Scenario: Client disconnects
- **WHEN** the client disconnects or the timeout is reached during the run
- **THEN** the provider call is aborted, the run ends as failed, the lease is released and no proposal hash is recorded

#### Scenario: Deletion during a run
- **WHEN** a workspace deletion is requested while a rewording run is in flight
- **THEN** it answers `503 DELETION_BUSY` until the run ends, and nothing is deleted partially

### Requirement: User cancel and revocation still stop the run
An explicit user cancel, or revocation of the consent or the connection, SHALL abort the provider call of a rewording run, and the route SHALL end the record as cancelled rather than leave it cancel-requested until the lease expires.

#### Scenario: User cancel or revocation
- **WHEN** the person cancels the run, or revokes the consent or the connection, while it is in progress
- **THEN** the provider call is aborted, the record ends as cancelled, the lease is released and no proposal hash is recorded

### Requirement: The rewording run is recoverable and atomic
The run record and the account lease SHALL both be renewed by a heartbeat specific to this operation, keyed by the run's lease token, and SHALL outlast the longest execution, so a crash is recovered as interrupted. Expired leases SHALL be cleared first, then the busy check (running and cancel-requested runs) and the writes, with the account lease upserted, SHALL be one atomic step under the queue lock. The final status write SHALL NOT overwrite a run that recovery already ended.

#### Scenario: Atomic busy check
- **WHEN** two rewording requests, or a request and a queue claim, arrive together
- **THEN** exactly one run proceeds and the other is refused with `AI_BUSY`

#### Scenario: Expired lease row
- **WHEN** an expired account lease row still exists when a rewording request arrives
- **THEN** it is cleared or replaced and the request is not refused with an error other than `AI_BUSY`

#### Scenario: Late finish after recovery
- **WHEN** the route finishes after recovery already ended its run as interrupted
- **THEN** the interrupted record is not overwritten and no proposal hash is recorded

### Requirement: Only candidate claims are reworded
Only `CANDIDATE_CLAIM` sentences SHALL be sent for rewording. `OFFER_REFERENCE` and `BOILERPLATE` sentences SHALL NOT be reworded, and a proposal for one SHALL be rejected.

#### Scenario: Reference or boilerplate not sent
- **WHEN** the preview is built for a draft with offer references and a closing
- **THEN** only candidate claims are listed and sent

#### Scenario: Proposal for a non-claim sentence
- **WHEN** the provider returns a proposal for an offer reference or boilerplate sentence
- **THEN** the output is rejected and the draft is unchanged

### Requirement: Exact payload shown and sent
Before anything leaves the device the person SHALL see the exact payload: the instructions, the offer fields chosen and every sentence sent with its kind and cited facts. The preview SHALL carry a SHA-256 over the exact prompt messages handed to Codex, and the messages sent SHALL be the messages previewed and hashed. If the draft changed since the preview, nothing SHALL be sent.

#### Scenario: Every sentence listed
- **WHEN** the preview is shown
- **THEN** each sentence that will be sent is visible and nothing outside the preview is sent

#### Scenario: Consent covers the data categories
- **WHEN** the person confirms
- **THEN** the one-off consent lists exactly the data categories `APPROVED_FACTS` and `JOB_POSTING`

#### Scenario: Declined or no account
- **WHEN** the person declines, or no account is connected, or assistant help is disabled
- **THEN** the local draft remains available and nothing is sent

### Requirement: Citations required, invented facts rejected
Every proposed sentence SHALL cite one or more shared approved facts. The system SHALL reject output that cites a fact that was not shared, cites none, or introduces an employer, title, date, number, credential or skill that no cited fact contains. A rejected output SHALL leave the existing draft unchanged and tell the person why.

#### Scenario: Valid proposal
- **WHEN** Codex returns sentences that each cite shared facts and add no new fact
- **THEN** they are returned in the response as proposals marked "suggested by Codex" for the person to accept, edit or discard, and no revision is created and no sentence text is stored until the person accepts

#### Scenario: Invented fact
- **WHEN** a sentence states a number or skill that no cited fact contains
- **THEN** the output is rejected and no sentence is added

#### Scenario: Unknown citation
- **WHEN** a sentence cites a fact id that was not shared
- **THEN** the output is rejected

### Requirement: Proposals never approve themselves
Codex proposals SHALL require the same review and explicit approval as manual text. Accepted proposals SHALL be recorded with their origin so the review shows what Codex wrote and what the person edited; a proposal the person changes before accepting SHALL be stored as `USER_EDITED`.

#### Scenario: Edited proposal
- **WHEN** the person rewords a proposal before saving it
- **THEN** the sentence is saved through the ordinary edit rules with origin `USER_EDITED`, not `CODEX`

#### Scenario: Accept and approve
- **WHEN** the person accepts proposals and approves the revision
- **THEN** the approval is recorded as the person's action and each sentence keeps its origin

### Requirement: Accepting a proposal verifies what was recorded
A run SHALL record one SHA-256 per validated proposed sentence over its text and cited fact ids together, in a hash-only table written in the transaction that marks the run succeeded; the run's insert-time snapshot stays immutable. Accepting SHALL read those hashes and create one revision only if every submitted sentence matches and the targeted revision is still the newest, checked under a lock on the logical document. Anything altered, unrecorded or extra SHALL be refused.

#### Scenario: Matching proposal accepted
- **WHEN** the person accepts the proposals exactly as returned
- **THEN** one new revision is created with those sentences marked `CODEX`, after the citation and no-new-fact checks pass again

#### Scenario: Proposal text altered
- **WHEN** an accept request carries text or cited fact ids for a sentence that differ from the recorded proposal hash, or a sentence the run never proposed
- **THEN** it is refused with a mismatch error and no revision is created

#### Scenario: Run history cleared or expired
- **WHEN** an accept request names a run whose record or proposal hashes were removed by clearing or expiring the assistant history
- **THEN** it is refused with the named error `409 AI_PROPOSAL_EXPIRED`, not a server error, and nothing is created

#### Scenario: Run reused or stale
- **WHEN** an accept request names a run already accepted, or the draft has a newer revision than the run targeted
- **THEN** it is refused and nothing is created

#### Scenario: Concurrent double accept
- **WHEN** two accept requests for the same run arrive together
- **THEN** exactly one revision is created, the other fails, and no orphan file remains

### Requirement: Privacy and cleanup of assistant data
Prompts and responses SHALL follow the existing assistant data rules: no credentials, no unselected facts, no extra contact details. Assistant records SHALL keep only hashes and identifiers, never sentence, fact or proposal text, and the run SHALL NOT use review-artifact rows. Sentences marked `USER_UNSUPPORTED` SHALL NOT be sent.

#### Scenario: Proposal text lives only in the response and the accepted revision
- **WHEN** proposals are returned and later accepted
- **THEN** their text exists only in the response and then inside the new revision, so workspace deletion removes it with the revisions

#### Scenario: Unselected facts
- **WHEN** a fact is not selected for the request
- **THEN** it is absent from the preview and from what is sent

#### Scenario: Workspace deleted
- **WHEN** a workspace with accepted Codex sentences and run records is deleted
- **THEN** the sentences are removed with the revisions, the proposal-hash rows are removed before the run records, and no document text exists in assistant records

#### Scenario: Nothing stored before acceptance
- **WHEN** Codex returns valid proposals and the person has not accepted them
- **THEN** the assistant tables hold no sentence, fact or proposal text, only hashes and identifiers, and the draft has no new revision

#### Scenario: Unsupported sentence
- **WHEN** a revision contains a `USER_UNSUPPORTED` sentence and the person asks for rewording
- **THEN** that sentence is absent from the preview and from what is sent
