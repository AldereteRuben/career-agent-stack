# Spec Delta

## Purpose

Lets the person download selected approved documents of one application as a single ZIP, ready to attach manually.

## ADDED Requirements

### Requirement: Only approved current documents of one application
The person SHALL select documents from an application and download one ZIP. The selection SHALL exist only in the request and SHALL NOT be stored. The system SHALL refuse revisions that are not approved, are marked as needing review, are superseded by a newer approved revision, or belong to another application or workspace.

#### Scenario: Valid selection
- **WHEN** the person selects an approved resume and an approved cover letter and downloads
- **THEN** a ZIP is delivered containing, for each selected document, its PDF and text file

#### Scenario: Unapproved document
- **WHEN** a selected document is pending review or needs review
- **THEN** the request is refused naming the document and nothing is produced

#### Scenario: Superseded revision
- **WHEN** a selected revision has a newer approved revision
- **THEN** the request is refused naming the document and nothing is produced

#### Scenario: Newer pending edit exists
- **WHEN** an approved current revision is selectable and a newer unapproved edit of the same document exists
- **THEN** it can be selected, the interface warns that a newer unapproved edit exists, and the ZIP contains the approved revision only

#### Scenario: Selection not stored
- **WHEN** a ZIP is downloaded
- **THEN** no selection is saved, exported, backed up or deleted later because none exists

#### Scenario: Other application
- **WHEN** a request includes a document of another application
- **THEN** it is refused as not found

### Requirement: Bounded and well-formed archive
The ZIP SHALL contain at most 20 documents (selected revisions), each as a PDF and a text file, plus one manifest (at most 41 entries), and at most 30,000,000 uncompressed bytes. A larger request SHALL be refused and no document SHALL be left out silently. The manifest SHALL list each file, language, revision, approval time and SHA-256.

#### Scenario: Safe names
- **WHEN** names are generated
- **THEN** they have no path separators, are unique, and non-ASCII names are flagged as UTF-8 in the ZIP headers

#### Scenario: Name collisions
- **WHEN** two documents would have the same file name
- **THEN** names are made unique and listed in the manifest

#### Scenario: Document limit
- **WHEN** 21 documents are selected
- **THEN** the request is refused, while 20 documents (41 entries) are accepted

#### Scenario: Accented file names
- **WHEN** a file name contains an accent
- **THEN** its ZIP entry has the UTF-8 name flag set in the local and central headers and opens with the same name

#### Scenario: Integrity
- **WHEN** the ZIP is opened
- **THEN** every file matches the digest in the manifest

### Requirement: No submission and honest contents
Downloading SHALL NOT submit, send or upload anything. The manifest and interface SHALL say that the ZIP is not encrypted and that the person attaches files manually. The ZIP MAY contain the approved resume and cover-letter content (including whatever contact details those documents print) and the manifest, and SHALL contain no other profile fields, no unrelated facts and no notes.

#### Scenario: Download is local
- **WHEN** the ZIP is downloaded
- **THEN** no request leaves the workspace and the application state does not change to submitted

### Requirement: Bilingual, keyboard and mobile use
Selection and download SHALL be bilingual, keyboard operable with a visible count of selected items and an announced result, and usable at 390 px.

#### Scenario: Keyboard selection
- **WHEN** the person selects documents with the keyboard and activates download
- **THEN** the selection count is announced and the download starts
