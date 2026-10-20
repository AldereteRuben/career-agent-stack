# Manual Profile Improvement Pack Specification

## Purpose

Help a person prepare professional-profile text from their own approved evidence without sending it to LinkedIn or inventing credentials.

## Requirements

### Requirement: Profile copy uses approved evidence only

The profile page SHALL derive headline suggestions, an About draft and experience bullets only from facts with `USER_APPROVED` status. Every suggestion SHALL show its source evidence and copy that evidence with the text. Approved experience statements SHALL be reused verbatim as bullets.

#### Scenario: A fact is pending review

- **WHEN** an experience is suggested but not approved
- **THEN** none of its text or tags appears in the profile pack

#### Scenario: Approved structured experience is available

- **WHEN** an approved experience includes a role and organization
- **THEN** the pack may form a deterministic headline and About sentence from those fields and cite the approved statement

### Requirement: Suggestions do not become profile facts

The profile pack SHALL label skill gaps as missing approved evidence, not as proof that the person lacks a skill. Portfolio prompts SHALL be identified as ideas, link to their source listings and SHALL NOT create or update profile facts.

#### Scenario: A listing asks for an unevidenced skill

- **WHEN** a skill-gap result has no approved profile evidence
- **THEN** the pack describes the gap as a review prompt and links to the saved listing

### Requirement: Profile pack stays manual and private

The profile pack SHALL not use an AI provider, fetch LinkedIn pages, or publish to LinkedIn. Copy actions SHALL be initiated by the person and SHALL leave text visible if clipboard access is unavailable.

#### Scenario: Person copies a suggestion

- **WHEN** the person activates a copy button
- **THEN** the suggestion and its evidence are copied locally without making a network request

### Requirement: Profile pack is accessible in Spanish and English

The profile pack SHALL use the selected interface language and SHALL remain readable and operable by keyboard at phone widths.

#### Scenario: Narrow viewport

- **WHEN** the profile is viewed at phone width
- **THEN** the content wraps without horizontal page overflow
