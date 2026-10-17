# Spec Delta

## ADDED Requirements

### Requirement: Resume contact details remain under the person's control
The profile MAY contain a phone number, city, and up to four labeled HTTPS links without URL credentials. A person SHALL choose which available contact fields appear on each generated resume. The saved PDF SHALL become stale when one of its printed contact values changes.

#### Scenario: Person selects resume contact fields
- **WHEN** the person generates or edits a resume
- **THEN** the PDF includes only the selected available email, phone, city, and links, and the document retains that selection

#### Scenario: Printed contact details change
- **WHEN** a selected contact value changes after resume generation
- **THEN** the document is marked stale until regenerated and reviewed again

#### Scenario: Contact detail is not sent to AI
- **WHEN** an AI-assisted resume draft is requested
- **THEN** phone, city, and profile links are absent from the AI request and source snapshot

### Requirement: Professional summaries require approval
Professional summaries SHALL use the existing fact review and resume approval flow. AI-generated wording SHALL remain a proposal until reviewed by the person.

#### Scenario: Person adds a professional summary
- **WHEN** a summary is entered or proposed for a resume
- **THEN** it follows the same source, approval, and PDF review rules as other profile facts
