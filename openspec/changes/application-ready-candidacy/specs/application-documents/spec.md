# Spec Delta

## Purpose

Gives each application an offer-specific resume and cover letter that rest only on approved facts, that the person reads, edits and approves, and that exist as a PDF and an editable text file in one language.

## ADDED Requirements

### Requirement: Drafts are built locally from approved facts and the offer
The system SHALL build a resume draft and a cover letter draft for an application from approved facts and the offer's latest snapshot, without contacting any service, never using suggested or rejected facts. Each sentence SHALL be an *offer reference* (fixed template with offer fields), *boilerplate* (fixed salutation or closing) or a *candidate claim*. Only a candidate claim says something about the candidate, and it SHALL list the approved facts it rests on.

#### Scenario: Draft without any assistant
- **WHEN** the person asks for documents for an application and no Codex account is connected
- **THEN** both drafts are built and shown for review, each sentence with its supporting facts

#### Scenario: Offer reference accepted
- **WHEN** a sentence is the template "applying for {role} at {company}" built from the offer
- **THEN** it is accepted as an offer reference with no supporting fact

#### Scenario: Salutation and closing
- **WHEN** the draft contains the fixed salutation and closing, and the person rewords the closing to another greeting that names no employer, title, date, number, credential or skill
- **THEN** both remain boilerplate with no citation, no unsupported-claim warning is raised, and the rewording is saved

#### Scenario: Boilerplate edited into a claim
- **WHEN** the person adds a skill, number or date to a boilerplate sentence
- **THEN** it is treated as a candidate claim and needs cited approved facts or knowing confirmation

#### Scenario: Offer data cannot support a candidate claim
- **WHEN** a candidate claim names the offer's company or a requirement from the offer and no cited approved fact contains it
- **THEN** it is rejected as unsupported and cannot be approved unless the person confirms it as written by them

#### Scenario: Requirement without approved fact
- **WHEN** the offer asks for something no approved fact supports
- **THEN** the draft does not claim it, and the review lists it as not confirmed with a link to the profile

#### Scenario: Thin profile
- **WHEN** the person has few approved facts
- **THEN** the draft is short, says so, and never pads it with generic or invented statements

### Requirement: Documents need a saved offer
Every revision SHALL reference the offer snapshot it was built from. Creating documents for an application that has no job, or whose job has no snapshot, SHALL be refused with the named error `409 APPLICATION_HAS_NO_OFFER`, SHALL write nothing, and the interface SHALL explain in Spanish and English that documents need a saved offer.

#### Scenario: Application without a job
- **WHEN** the person asks for documents for an application whose job is empty
- **THEN** the request is refused with `APPLICATION_HAS_NO_OFFER`, no document, revision or file exists, and the page explains why in the person's language

#### Scenario: Job without a snapshot
- **WHEN** the application's job has no snapshot
- **THEN** the same refusal applies

### Requirement: Offer data is a reference, never support
An offer reference SHALL use only a fixed template and offer fields (company, role, location). A candidate claim means any statement about the candidate's experience, skills, education, dates or numbers. Offer data SHALL NOT count as support for a candidate claim, and a sentence SHALL NOT become an offer reference by editing.

#### Scenario: Edited reference becomes a claim
- **WHEN** the person adds experience wording to an offer-reference sentence
- **THEN** it is treated as a candidate claim and needs cited approved facts or knowing confirmation

### Requirement: Review and edit before approval
The person SHALL be able to edit, remove and restore every sentence before approval. A draft SHALL NOT be treated as ready, offered for download as ready or selected for a package until the person approves a specific revision. Approval SHALL be an explicit action by the person, SHALL NOT be implied by editing, saving, opening or exporting, and SHALL bind to the exact revision, text hash, PDF hash and the freshness of the cited facts and the offer snapshot that the person was shown.

#### Scenario: Approving
- **WHEN** the person reviews a draft and chooses "Approve"
- **THEN** that revision becomes approved with the time of approval

#### Scenario: Approval of something other than what was shown
- **WHEN** the revision, a cited fact or the offer snapshot differs from what the person was shown, or a stored file does not match its digest, when they choose "Approve"
- **THEN** approval is refused as out of date, nothing is approved, and the person is shown the current version

#### Scenario: Approval does not re-render
- **WHEN** the person approves a revision whose PDF would render to different bytes if rendered again (for example a different creation timestamp)
- **THEN** approval succeeds if the stored digests and current facts and offer match, the renderer is not called, and the approved PDF is byte-identical to the previewed one

#### Scenario: Newer pending edit beside an approved revision
- **WHEN** an earlier approved revision is still current and a newer pending edit exists
- **THEN** the review shows both and warns that a newer unapproved edit exists wherever the approved revision can be downloaded or selected

#### Scenario: Preview rendered when saved
- **WHEN** a revision is created or edited
- **THEN** its text and PDF are rendered once, stored with SHA-256 and served as the preview, and if rendering fails no revision is created

#### Scenario: Editing an approved revision
- **WHEN** the person changes an approved document
- **THEN** a new revision is created pending approval and the earlier approved revision is kept and unchanged

#### Scenario: Supported edit
- **WHEN** the person rewords a candidate claim, keeps valid citations to approved facts, and adds no employer, title, date, number, credential or skill that the cited facts lack
- **THEN** the edit is saved, keeps its citations and is not marked unsupported

#### Scenario: Origin after a human edit
- **WHEN** the person changes the text of a sentence whose origin is the local builder or Codex
- **THEN** its origin becomes `USER_EDITED`, while an unchanged sentence keeps its origin

#### Scenario: Edit adds an unsupported skill, number or date
- **WHEN** the person edits a candidate claim to add a skill, a number or a date that no cited fact contains
- **THEN** the save is refused naming the sentence and the added item, unless the person explicitly confirms it, in which case it is stored marked `USER_UNSUPPORTED` ("written by you, not backed by a profile fact")

#### Scenario: Unsupported claim needs confirmation at approval
- **WHEN** a revision contains `USER_UNSUPPORTED` sentences and the person chooses "Approve"
- **THEN** approval is refused unless the request confirms every one of those sentences, and the confirmed sentences are recorded with the approval

#### Scenario: Sentence with no citation
- **WHEN** the person writes a candidate claim that cites no approved fact
- **THEN** it is treated as unsupported: refused unless explicitly confirmed, then stored as `USER_UNSUPPORTED`

#### Scenario: Citations are re-checked on save and approval
- **WHEN** a sentence cites a fact id that does not exist, belongs to another workspace, or is not approved at that moment
- **THEN** the save or approval is rejected naming the sentence

### Requirement: Approval verifies a stored preview, never a re-render
The text and PDF of a revision SHALL be rendered once, when the revision is saved, and stored with their SHA-256 as an immutable preview that the person reviews. Approval SHALL verify the stored digests and recheck the current facts, citations and offer, and SHALL NOT re-render or re-hash a newly rendered file.

#### Scenario: Stored file altered
- **WHEN** a stored preview file no longer matches its digest at approval
- **THEN** approval is refused as out of date and nothing is approved

### Requirement: Stale documents need new approval
When an approved fact a document cites is changed, rejected or removed, or the offer's snapshot changes materially, the document SHALL be marked as needing review and SHALL NOT be selectable for a package until reviewed and approved again. Staleness SHALL be computed when read, not stored.

#### Scenario: Fact changes after approval
- **WHEN** a cited fact is edited after the document was approved
- **THEN** the document shows "needs review" and names the changed fact

#### Scenario: Offer hash definition
- **WHEN** staleness of the offer is evaluated
- **THEN** it compares a SHA-256 of the application's immutable company, role and location, the latest snapshot's title and its normalized description text, excluding derived requirements, fetch time, availability and source identifiers

#### Scenario: Offer changes after approval
- **WHEN** the offer's description or title changes in a newer snapshot
- **THEN** the document shows "needs review", while a new snapshot that only differs in fetch time does not

#### Scenario: Skill dictionary change
- **WHEN** the dictionary that derives requirements from the description changes in a release and the snapshot is unchanged
- **THEN** the offer hash is unchanged and approved documents do not read "needs review"

#### Scenario: Offer fields come from the application
- **WHEN** a draft is built
- **THEN** company, role and location in the offer references and in the hash are the application's immutable values, and every revision references the snapshot it was built from

#### Scenario: Superseded revision
- **WHEN** a newer revision of the same document is approved
- **THEN** the earlier approved revision is marked superseded and cannot be downloaded as ready or selected for a package

### Requirement: PDF and editable text from the same content
Each approved revision SHALL be available as a PDF and as a UTF-8 plain text file with identical wording, rendered from the stored claims when the revision is saved, stored with their SHA-256, and never re-rendered at approval or download. The PDF SHALL support A4 and Letter as the existing resume does, for both the resume and the cover letter.

#### Scenario: Download both
- **WHEN** the person downloads an approved cover letter
- **THEN** a PDF and a text file with the same sentences are available, byte-identical to the reviewed preview, with file names that include the application and language

#### Scenario: PDF matches the claims
- **WHEN** an approved PDF is converted back to text
- **THEN** every sentence of the revision appears in order with its accents

#### Scenario: Accented characters
- **WHEN** a document contains Spanish accents and symbols
- **THEN** both files show them correctly

### Requirement: One language per version
Each version SHALL have exactly one language, Spanish or English, chosen at creation. The system SHALL refuse approval of a version whose headings or generated phrases differ from its language. Another language SHALL be a separate version of the same application.

#### Scenario: Same application, two languages
- **WHEN** the person creates a Spanish and an English version for one application
- **THEN** each is reviewed, approved and downloaded independently

#### Scenario: Mixed languages
- **WHEN** a version in English contains Spanish generated headings
- **THEN** approval is refused with a message naming the mismatch

### Requirement: Bilingual, keyboard and mobile interface
The review editor, approval, status messages and errors SHALL be available in Spanish and English, fully usable with the keyboard with visible focus and logical order, and usable at 390 px width without horizontal scrolling. Status and errors SHALL be announced to assistive technology and SHALL NOT rely on color alone.

#### Scenario: Keyboard review
- **WHEN** the person edits, removes and approves a draft using only the keyboard
- **THEN** every control is reachable, focus is visible and the result is announced

#### Scenario: Phone width
- **WHEN** the editor is opened at 390 px
- **THEN** there is no horizontal scroll and actions remain reachable

### Requirement: Workspace and application isolation
Documents SHALL belong to one workspace and one application. A request for a document, draft or file of another workspace or application SHALL behave as not found.

#### Scenario: Other workspace
- **WHEN** a request names a document id from another workspace
- **THEN** it returns not found and reveals nothing

### Requirement: Existing attached resume is unchanged
Documents of this capability SHALL be stored apart from the resume already linked to an application through `document_id`. An upgrade SHALL NOT alter, relink or convert that resume, which keeps its approval state and file and is shown as the attached resume.

#### Scenario: Upgrade with a linked resume
- **WHEN** the feature is installed on a workspace whose application links an approved resume
- **THEN** the application still links the same resume, unchanged, and no document of this capability exists until the person creates one
