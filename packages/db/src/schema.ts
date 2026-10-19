import { boolean, check, date, primaryKey, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { CompanyResearchNotes } from '@career/domain';

export const providerEnum = pgEnum('provider_id', ['greenhouse', 'lever', 'ashby']);
export const permissionEnum = pgEnum('permission_status', ['APPROVED_FOR_SCOPE', 'UNKNOWN', 'BLOCKED']);
export const associationEnum = pgEnum('association_status', ['VERIFIED', 'UNVERIFIED']);
export const factApprovalEnum = pgEnum('fact_approval', ['SUGGESTED', 'USER_APPROVED', 'REJECTED']);
export const applicationStateEnum = pgEnum('application_state', ['DRAFT', 'PREPARING', 'REVIEW_REQUIRED', 'READY', 'IN_PROGRESS', 'UNKNOWN', 'CONFIRMED', 'CANCELLED']);
export const recruitmentStageEnum = pgEnum('recruitment_stage', ['NO_RESPONSE', 'RECRUITER_CONTACT', 'ASSESSMENT', 'INTERVIEW', 'FINAL_INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN', 'HIRED']);
export const shortlistEnum = pgEnum('shortlist_decision', ['UNREVIEWED', 'SHORTLISTED', 'SKIPPED', 'ARCHIVED']);
export const availabilityEnum = pgEnum('job_availability', ['OPEN', 'POSSIBLY_CLOSED', 'CLOSED', 'UNKNOWN']);

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const changed = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const workspaces = pgTable('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  discoveryEnabled: boolean('discovery_enabled').notNull().default(false),
  name: varchar('name', { length: 160 }).notNull().default('My career workspace'),
  timezone: varchar('timezone', { length: 100 }).notNull().default('Europe/Madrid'),
  // Increased by "delete all my data" (ADR 020); session cookies carry it, so older sessions stop working.
  sessionGeneration: integer('session_generation').notNull().default(0),
  createdAt: created(), updatedAt: changed(),
});

export const profileVersions = pgTable('profile_versions', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(), locale: varchar('locale', { length: 20 }).notNull().default('en-GB'), profile: jsonb('profile').$type<Record<string, unknown>>().notNull().default({}), createdAt: created(),
}, (t) => [uniqueIndex('profile_versions_workspace_revision_uq').on(t.workspaceId, t.revision), unique('profile_versions_workspace_id_uq').on(t.workspaceId, t.id)]);

export const profileFacts = pgTable('profile_facts', {
  details: jsonb('details').$type<import('@career/domain').StructuredEntry>(),
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), profileVersionId: uuid('profile_version_id').notNull(), kind: varchar('kind', { length: 64 }).notNull(), statement: text('statement').notNull(), tags: jsonb('tags').$type<string[]>().notNull().default([]), source: varchar('source', { length: 40 }).notNull().default('USER_ENTERED'), importId: uuid('import_id'), approvalStatus: factApprovalEnum('approval_status').notNull().default('SUGGESTED'), approvedAt: timestamp('approved_at', { withTimezone: true }), createdAt: created(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.profileVersionId], foreignColumns: [profileVersions.workspaceId, profileVersions.id], name: 'profile_facts_workspace_revision_fk' }).onDelete('cascade'), index('profile_facts_workspace_approval_idx').on(t.workspaceId, t.approvalStatus), index('profile_facts_workspace_import_idx').on(t.workspaceId, t.importId).where(sql`${t.importId} is not null`)]);

export const answerVersions = pgTable('answer_versions', {
  aiProvenance: jsonb('ai_provenance').$type<Record<string, unknown>>(),
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), semanticKey: varchar('semantic_key', { length: 100 }).notNull(), jurisdiction: varchar('jurisdiction', { length: 2 }).notNull(), questionScope: varchar('question_scope', { length: 160 }).notNull(), questionText: varchar('question_text', { length: 500 }), value: jsonb('value'), strategy: varchar('strategy', { length: 40 }).notNull(), approvalStatus: varchar('approval_status', { length: 30 }).notNull().default('UNANSWERED'), reviewAfter: timestamp('review_after', { withTimezone: true }), revision: integer('revision').notNull(), createdAt: created(),
}, (t) => [uniqueIndex('answer_versions_workspace_key_jurisdiction_scope_revision_uq').on(t.workspaceId, t.semanticKey, t.jurisdiction, t.questionScope, t.revision)]);

export const boards = pgTable('boards', {
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastRunStatus: varchar('last_run_status', { length: 30 }),
  lastNewCount: integer('last_new_count').notNull().default(0),
  lastError: varchar('last_error', { length: 80 }),
  failureCount: integer('failure_count').notNull().default(0),
  // Jobs listed by the previous complete refresh; a much smaller complete refresh gives no absence evidence (ADR 021).
  lastCompleteCount: integer('last_complete_count'),
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), provider: providerEnum('provider').notNull(), tenant: varchar('tenant', { length: 200 }).notNull(), region: varchar('region', { length: 40 }).notNull(), companyName: varchar('company_name', { length: 200 }).notNull(), companyDomain: varchar('company_domain', { length: 253 }).notNull(), careersUrl: text('careers_url').notNull(), associationStatus: associationEnum('association_status').notNull().default('UNVERIFIED'), permissionStatus: permissionEnum('permission_status').notNull().default('UNKNOWN'), allowedApplicationOrigins: jsonb('allowed_application_origins').$type<string[]>().notNull().default([]), enabled: boolean('enabled').notNull().default(false), reviewedAt: timestamp('reviewed_at', { withTimezone: true }), reviewDueAt: timestamp('review_due_at', { withTimezone: true }), lastSuccessfulRefreshAt: timestamp('last_successful_refresh_at', { withTimezone: true }), createdAt: created(), updatedAt: changed(),
}, (t) => [unique('boards_workspace_id_uq').on(t.workspaceId, t.id), uniqueIndex('boards_workspace_provider_region_tenant_uq').on(t.workspaceId, t.provider, t.region, t.tenant), index('boards_workspace_enabled_idx').on(t.workspaceId, t.enabled)]);

export const jobs = pgTable('jobs', {
  companyResearch: jsonb('company_research').$type<CompanyResearchNotes>().notNull().default({ whatItDoes: '', howItMakesMoney: '', recentNews: '', culture: '', questionsToAsk: '' }),
  companyResearchRevision: integer('company_research_revision').notNull().default(1),
  // The person closed this job; it stays CLOSED whatever sources report until they reopen it (ADR 021).
  closedByUser: boolean('closed_by_user').notNull().default(false),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }),
  seenAt: timestamp('seen_at', { withTimezone: true }),
  // When the person last saved this job; null when it is not saved or was saved before this was recorded.
  savedAt: timestamp('saved_at', { withTimezone: true }),
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), company: varchar('company', { length: 200 }).notNull(), title: varchar('title', { length: 300 }).notNull(), location: varchar('location', { length: 300 }), canonicalUrl: text('canonical_url'), availability: availabilityEnum('availability').notNull().default('UNKNOWN'), shortlistDecision: shortlistEnum('shortlist_decision').notNull().default('UNREVIEWED'), fitScore: integer('fit_score'), evidenceCoverage: integer('evidence_coverage'), eligibility: varchar('eligibility', { length: 20 }).notNull().default('NEEDS_REVIEW'), reasons: jsonb('reasons').$type<string[]>().notNull().default([]), createdAt: created(), updatedAt: changed(),
}, (t) => [unique('jobs_workspace_id_uq').on(t.workspaceId, t.id), index('jobs_workspace_availability_idx').on(t.workspaceId, t.availability), index('jobs_workspace_created_idx').on(t.workspaceId, t.createdAt), index('jobs_workspace_saved_idx').on(t.workspaceId, t.savedAt).where(sql`${t.savedAt} is not null`)]);

export const jobOccurrences = pgTable('job_occurrences', {
  // Consecutive complete board refreshes that did not list this job (ADR 021).
  missedCompleteReads: integer('missed_complete_reads').notNull().default(0),
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), jobId: uuid('job_id').notNull(), provider: providerEnum('provider').notNull(), region: varchar('region', { length: 40 }).notNull(), tenant: varchar('tenant', { length: 200 }).notNull(), externalJobId: varchar('external_job_id', { length: 300 }).notNull(), jobUrl: text('job_url').notNull(), applyUrl: text('apply_url'), sourcePostedAt: timestamp('source_posted_at', { withTimezone: true }), sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }), firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(), lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(), lastSuccessfulRefreshAt: timestamp('last_successful_refresh_at', { withTimezone: true }), sourcePayload: jsonb('source_payload').$type<Record<string, unknown>>().notNull(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.jobId], foreignColumns: [jobs.workspaceId, jobs.id], name: 'job_occurrences_workspace_job_fk' }).onDelete('cascade'), uniqueIndex('job_occurrences_identity_uq').on(t.workspaceId, t.provider, t.region, t.tenant, t.externalJobId)]);

export const jobSnapshots = pgTable('job_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), jobId: uuid('job_id').notNull(), occurrenceId: uuid('occurrence_id'), title: varchar('title', { length: 300 }).notNull(), descriptionText: text('description_text'), snapshotHash: varchar('snapshot_hash', { length: 64 }).notNull(), fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.jobId], foreignColumns: [jobs.workspaceId, jobs.id], name: 'job_snapshots_workspace_job_fk' }).onDelete('cascade'), unique('job_snapshots_workspace_id_uq').on(t.workspaceId, t.id), index('job_snapshots_workspace_job_fetched_idx').on(t.workspaceId, t.jobId, t.fetchedAt, t.id)]);

export const applications = pgTable('applications', {
  documentId: uuid('document_id'),
  nextStep: varchar('next_step', { length: 500 }), followUpDate: date('follow_up_date'), interviewAt: timestamp('interview_at', { withTimezone: true }), interviewTimezone: varchar('interview_timezone', { length: 100 }),
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), jobId: uuid('job_id'), applicationCycle: integer('application_cycle').notNull().default(1), company: varchar('company', { length: 200 }).notNull(), role: varchar('role', { length: 300 }).notNull(), location: varchar('location', { length: 300 }), canonicalUrl: text('canonical_url'), state: applicationStateEnum('state').notNull().default('DRAFT'), recruitmentStage: recruitmentStageEnum('recruitment_stage').notNull().default('NO_RESPONSE'), shortlistDecision: shortlistEnum('shortlist_decision').notNull().default('UNREVIEWED'), notes: text('notes').notNull().default(''), version: integer('version').notNull().default(1), createdAt: created(), updatedAt: changed(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.documentId], foreignColumns: [documentVersions.workspaceId, documentVersions.id], name: 'applications_workspace_document_fk' }), foreignKey({ columns: [t.workspaceId, t.jobId], foreignColumns: [jobs.workspaceId, jobs.id], name: 'applications_workspace_job_fk' }), unique('applications_workspace_id_uq').on(t.workspaceId, t.id), uniqueIndex('applications_workspace_job_cycle_uq').on(t.workspaceId, t.jobId, t.applicationCycle), index('applications_workspace_state_idx').on(t.workspaceId, t.state, t.updatedAt), index('applications_workspace_created_idx').on(t.workspaceId, t.createdAt), index('applications_workspace_follow_up_idx').on(t.workspaceId, t.followUpDate).where(sql`${t.followUpDate} is not null`), index('applications_workspace_interview_idx').on(t.workspaceId, t.interviewAt).where(sql`${t.interviewAt} is not null`)]);

export const applicationEvents = pgTable('application_events', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), applicationId: uuid('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }), actor: varchar('actor', { length: 80 }).notNull().default('USER'), eventType: varchar('event_type', { length: 100 }).notNull(), reason: text('reason'), priorState: varchar('prior_state', { length: 40 }), newState: varchar('new_state', { length: 40 }), evidence: jsonb('evidence').$type<Record<string, unknown>>(), aggregateVersion: integer('aggregate_version').notNull(), createdAt: created(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.applicationId], foreignColumns: [applications.workspaceId, applications.id], name: 'application_events_workspace_application_fk' }).onDelete('cascade'), index('application_events_workspace_application_idx').on(t.workspaceId, t.applicationId, t.createdAt), index('application_events_workspace_created_idx').on(t.workspaceId, t.createdAt)]);

export const workspaceContacts = pgTable('workspace_contacts', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 160 }).notNull(), profileUrl: text('profile_url'), createdAt: created(), updatedAt: changed(),
}, (t) => [unique('workspace_contacts_workspace_id_uq').on(t.workspaceId, t.id), index('workspace_contacts_workspace_name_idx').on(t.workspaceId, t.name)]);

export const applicationContacts = pgTable('application_contacts', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), applicationId: uuid('application_id').notNull(), contactId: uuid('contact_id').notNull(),
  role: varchar('role', { length: 120 }).notNull(), note: text('note').notNull().default(''), createdAt: created(), updatedAt: changed(),
}, (t) => [
  unique('application_contacts_workspace_id_uq').on(t.workspaceId, t.id),
  uniqueIndex('application_contacts_application_contact_uq').on(t.workspaceId, t.applicationId, t.contactId),
  foreignKey({ columns: [t.workspaceId, t.applicationId], foreignColumns: [applications.workspaceId, applications.id], name: 'application_contacts_workspace_application_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.workspaceId, t.contactId], foreignColumns: [workspaceContacts.workspaceId, workspaceContacts.id], name: 'application_contacts_workspace_contact_fk' }).onDelete('cascade'),
  index('application_contacts_workspace_application_idx').on(t.workspaceId, t.applicationId),
]);

export const documentVersions = pgTable('document_versions', {
  paperSize: varchar('paper_size', { length: 6 }).notNull().default('A4'),
  language: varchar('language', { length: 2 }),
  printedContactFields: jsonb('printed_contact_fields').$type<string[]>().notNull().default(['email']),
  claimsContractVersion: integer('claims_contract_version'), claimsBasis: jsonb('claims_basis').$type<Record<string, unknown>>(),
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), name: varchar('name', { length: 200 }).notNull(), revision: integer('revision').notNull(), profileRevisionId: uuid('profile_revision_id'), jobSnapshotId: uuid('job_snapshot_id'), mediaType: varchar('media_type', { length: 120 }).notNull(), storagePath: text('storage_path').notNull(), sha256: varchar('sha256', { length: 64 }).notNull(), claims: jsonb('claims').$type<Array<{ text: string; sourceFactIds: string[]; approvalStatus: string }>>().notNull().default([]), approvalStatus: varchar('approval_status', { length: 30 }).notNull().default('PENDING_REVIEW'), createdAt: created(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.profileRevisionId], foreignColumns: [profileVersions.workspaceId, profileVersions.id], name: 'document_versions_workspace_profile_revision_fk' }), unique('document_versions_workspace_id_uq').on(t.workspaceId, t.id), foreignKey({ columns: [t.workspaceId, t.jobSnapshotId], foreignColumns: [jobSnapshots.workspaceId, jobSnapshots.id], name: 'document_versions_workspace_job_snapshot_fk' }), uniqueIndex('document_versions_workspace_name_revision_uq').on(t.workspaceId, t.name, t.revision), check('document_versions_paper_size_check', sql`${t.paperSize} in ('A4', 'LETTER')`), check('document_versions_claims_contract_check', sql`${t.claimsContractVersion} is null or ${t.claimsContractVersion} = 1`), index('document_versions_workspace_created_idx').on(t.workspaceId, t.createdAt)]);

// Offer-specific documents are separate from the general resume attached to applications.
export const applicationDocuments = pgTable('application_documents', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), applicationId: uuid('application_id').notNull(),
  kind: varchar('kind', { length: 20 }).notNull(), language: varchar('language', { length: 2 }).notNull(), createdAt: created(),
}, (t) => [
  unique('application_documents_workspace_id_uq').on(t.workspaceId, t.id),
  uniqueIndex('application_documents_application_kind_language_uq').on(t.workspaceId, t.applicationId, t.kind, t.language),
  foreignKey({ columns: [t.workspaceId, t.applicationId], foreignColumns: [applications.workspaceId, applications.id], name: 'application_documents_workspace_application_fk' }).onDelete('restrict'),
  check('application_documents_kind_check', sql`${t.kind} in ('RESUME', 'COVER_LETTER')`),
  check('application_documents_language_check', sql`${t.language} in ('es', 'en')`),
]);
export const applicationDocumentRevisions = pgTable('application_document_revisions', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), documentId: uuid('document_id').notNull(), revision: integer('revision').notNull(), parentRevision: integer('parent_revision'),
  claims: jsonb('claims').$type<Array<Record<string, unknown>>>().notNull(), contentHash: varchar('content_hash', { length: 64 }).notNull(), offerSnapshotId: uuid('offer_snapshot_id').notNull(), offerHash: varchar('offer_hash', { length: 64 }).notNull(), factsHash: varchar('facts_hash', { length: 64 }).notNull(),
  paperSize: varchar('paper_size', { length: 10 }).notNull(), textStoragePath: text('text_storage_path').notNull(), textSha256: varchar('text_sha256', { length: 64 }).notNull(), pdfStoragePath: text('pdf_storage_path').notNull(), pdfSha256: varchar('pdf_sha256', { length: 64 }).notNull(),
  confirmedUnsupportedIds: jsonb('confirmed_unsupported_ids').$type<string[]>().notNull().default([]), approvedAt: timestamp('approved_at', { withTimezone: true }), approvedBy: varchar('approved_by', { length: 160 }), createdAt: created(),
}, (t) => [
  unique('application_document_revisions_workspace_id_uq').on(t.workspaceId, t.id),
  uniqueIndex('application_document_revisions_document_revision_uq').on(t.workspaceId, t.documentId, t.revision),
  foreignKey({ columns: [t.workspaceId, t.documentId], foreignColumns: [applicationDocuments.workspaceId, applicationDocuments.id], name: 'application_document_revisions_workspace_document_fk' }).onDelete('restrict'),
  foreignKey({ columns: [t.workspaceId, t.offerSnapshotId], foreignColumns: [jobSnapshots.workspaceId, jobSnapshots.id], name: 'application_document_revisions_workspace_offer_snapshot_fk' }).onDelete('restrict'),
  check('application_document_revisions_revision_check', sql`${t.revision} > 0`),
  check('application_document_revisions_paper_size_check', sql`${t.paperSize} in ('A4', 'LETTER')`),
  check('application_document_revisions_approved_check', sql`${t.approvedAt} is null or ${t.approvedBy} is not null`),
]);

export const applicationFollowUpDrafts = pgTable('application_follow_up_drafts', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), applicationId: uuid('application_id').notNull(),
  language: varchar('language', { length: 2 }).notNull(), subject: text('subject').notNull(), body: text('body').notNull(),
  createdAt: created(), updatedAt: changed(),
}, (t) => [
  unique('application_follow_up_drafts_workspace_id_uq').on(t.workspaceId, t.id),
  uniqueIndex('application_follow_up_drafts_application_uq').on(t.workspaceId, t.applicationId),
  foreignKey({ columns: [t.workspaceId, t.applicationId], foreignColumns: [applications.workspaceId, applications.id], name: 'application_follow_up_drafts_workspace_application_fk' }).onDelete('restrict'),
  check('application_follow_up_drafts_language_check', sql`${t.language} in ('es', 'en')`),
]);

// AI persistence is deliberately inert until G0 enables an adapter. These tables contain metadata and
// explicitly consented snapshots only; they never contain provider credentials.
export const aiConnections = pgTable('ai_connections', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: varchar('provider', { length: 24 }).notNull(), officialContextRef: text('official_context_ref'), maskedIdentity: varchar('masked_identity', { length: 200 }),
  accountFingerprint: varchar('account_fingerprint', { length: 64 }).notNull(), binaryVersion: varchar('binary_version', { length: 100 }),
  capabilities: jsonb('capabilities').$type<Record<string, boolean>>().notNull().default({}), selectedModel: varchar('selected_model', { length: 160 }),
  revision: integer('revision').notNull().default(1), state: varchar('state', { length: 32 }).notNull().default('UNAVAILABLE'), active: boolean('active').notNull().default(true),
  createdAt: created(), updatedAt: changed(),
}, (t) => [unique('ai_connections_workspace_id_uq').on(t.workspaceId, t.id), uniqueIndex('ai_connections_active_provider_uq').on(t.workspaceId, t.provider).where(sql`${t.active}`)]);
export const aiConsents = pgTable('ai_consents', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), connectionId: uuid('connection_id').notNull(), provider: varchar('provider', { length: 24 }).notNull(),
  accountFingerprint: varchar('account_fingerprint', { length: 64 }).notNull(), connectionRevision: integer('connection_revision').notNull(), revision: integer('revision').notNull(),
  operation: varchar('operation', { length: 32 }).notNull(), dataCategories: jsonb('data_categories').$type<string[]>().notNull(), searchIds: jsonb('search_ids').$type<string[] | null>(),
  remembered: boolean('remembered').notNull().default(false), noticeVersion: varchar('notice_version', { length: 64 }).notNull(), grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(), revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [unique('ai_consents_workspace_id_uq').on(t.workspaceId, t.id), uniqueIndex('ai_consents_revision_uq').on(t.workspaceId, t.connectionId, t.operation, t.revision), foreignKey({ columns: [t.workspaceId, t.connectionId], foreignColumns: [aiConnections.workspaceId, aiConnections.id], name: 'ai_consents_workspace_connection_fk' }).onDelete('cascade')]);
export const aiAutomationPolicies = pgTable('ai_automation_policies', {
  activatedAt: timestamp('activated_at', { withTimezone: true }).notNull().defaultNow(), locale: varchar('locale', { length: 2 }).notNull().default('es'), selectedFactIds: jsonb('selected_fact_ids').$type<string[]>().notNull().default([]), selectionSnapshot: jsonb('selection_snapshot').$type<Record<string, unknown>>(),
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), connectionId: uuid('connection_id').notNull(), consentId: uuid('consent_id').notNull(), searchIds: jsonb('search_ids').$type<string[]>().notNull(),
  active: boolean('active').notNull().default(false), paused: boolean('paused').notNull().default(true), maximumDailyStarts: integer('maximum_daily_starts').notNull().default(10), revision: integer('revision').notNull().default(1), updatedAt: changed(),
}, (t) => [uniqueIndex('ai_automation_active_workspace_uq').on(t.workspaceId).where(sql`${t.active}`), check('ai_automation_daily_check', sql`${t.maximumDailyStarts} between 0 and 10`), unique('ai_automation_policies_workspace_id_uq').on(t.workspaceId, t.id), foreignKey({ columns: [t.workspaceId, t.connectionId], foreignColumns: [aiConnections.workspaceId, aiConnections.id], name: 'ai_automation_workspace_connection_fk' }).onDelete('cascade'), foreignKey({ columns: [t.workspaceId, t.consentId], foreignColumns: [aiConsents.workspaceId, aiConsents.id], name: 'ai_automation_workspace_consent_fk' }).onDelete('cascade')]);
export const aiRuns = pgTable('ai_runs', {
  searchId: uuid('search_id'), automationPolicyId: uuid('automation_policy_id'), automationPolicyRevision: integer('automation_policy_revision'),
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), connectionId: uuid('connection_id').notNull(), consentId: uuid('consent_id').notNull(),
  provider: varchar('provider', { length: 24 }).notNull(), model: varchar('model', { length: 160 }), connectionRevision: integer('connection_revision').notNull(), consentRevision: integer('consent_revision').notNull(), accountFingerprint: varchar('account_fingerprint', { length: 64 }).notNull(),
  operation: varchar('operation', { length: 32 }).notNull(), origin: varchar('origin', { length: 16 }).notNull(), status: varchar('status', { length: 24 }).notNull().default('QUEUED'),
  idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(), contentIdentity: varchar('content_identity', { length: 64 }).notNull(), accountLockKey: varchar('account_lock_key', { length: 64 }).notNull(),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(), snapshotHash: varchar('snapshot_hash', { length: 64 }).notNull(), inputVersions: jsonb('input_versions').$type<Record<string, unknown>>().notNull(),
  priority: integer('priority').notNull().default(0), reservationPassId: uuid('reservation_pass_id'), reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(), reservedDay: date('reserved_day').notNull(),
  leaseToken: uuid('lease_token'), leaseOwner: varchar('lease_owner', { length: 160 }), leaseUntil: timestamp('lease_until', { withTimezone: true }), attempt: integer('attempt').notNull().default(0),
  retryOf: uuid('retry_of'), error: jsonb('error').$type<Record<string, unknown>>(), startedAt: timestamp('started_at', { withTimezone: true }), completedAt: timestamp('completed_at', { withTimezone: true }), createdAt: created(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.searchId], foreignColumns: [savedJobSearches.workspaceId, savedJobSearches.id], name: 'ai_runs_workspace_search_fk' }), foreignKey({ columns: [t.workspaceId, t.automationPolicyId], foreignColumns: [aiAutomationPolicies.workspaceId, aiAutomationPolicies.id], name: 'ai_runs_workspace_policy_fk' }), unique('ai_runs_workspace_id_uq').on(t.workspaceId, t.id), uniqueIndex('ai_runs_idempotency_uq').on(t.workspaceId, t.idempotencyKey), foreignKey({ columns: [t.workspaceId, t.connectionId], foreignColumns: [aiConnections.workspaceId, aiConnections.id], name: 'ai_runs_workspace_connection_fk' }).onDelete('cascade'), foreignKey({ columns: [t.workspaceId, t.consentId], foreignColumns: [aiConsents.workspaceId, aiConsents.id], name: 'ai_runs_workspace_consent_fk' }).onDelete('restrict'), index('ai_runs_queue_idx').on(t.status, t.priority, t.reservedAt), index('ai_runs_account_idx').on(t.accountLockKey, t.status), check('ai_runs_operation_check', sql`${t.operation} in ('SEARCH_DRAFT', 'JOB_ANALYSIS', 'RESUME_DRAFT', 'ANSWER_DRAFT', 'DOCUMENT_REWORD', 'RESUME_IMPORT')`)]);
export const aiDocumentRewordProposals = pgTable('ai_document_reword_proposals', {
  workspaceId: uuid('workspace_id').notNull(), runId: uuid('run_id').notNull(), sentenceId: varchar('sentence_id', { length: 80 }).notNull(), proposalSha256: varchar('proposal_sha256', { length: 64 }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.runId, t.sentenceId], name: 'ai_document_reword_proposals_pk' }),
  foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [aiRuns.workspaceId, aiRuns.id], name: 'ai_document_reword_proposals_workspace_run_fk' }).onDelete('cascade'),
]);
export const llmUsage = pgTable('llm_usage', { id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), aiRunId: uuid('ai_run_id'), availability: varchar('availability', { length: 16 }).notNull().default('UNAVAILABLE'), provider: varchar('provider', { length: 80 }).notNull(), model: varchar('model', { length: 160 }), operation: varchar('operation', { length: 100 }).notNull(), status: varchar('status', { length: 30 }).notNull(), inputTokens: integer('input_tokens'), outputTokens: integer('output_tokens'), costUsd: text('cost_usd'), createdAt: created() }, (t) => [uniqueIndex('llm_usage_ai_run_uq').on(t.workspaceId, t.aiRunId), foreignKey({ columns: [t.workspaceId, t.aiRunId], foreignColumns: [aiRuns.workspaceId, aiRuns.id], name: 'llm_usage_workspace_ai_run_fk' }), check('llm_usage_availability_check', sql`${t.availability} in ('KNOWN','STALE','UNAVAILABLE')`)]);
export const aiAccountLeases = pgTable('ai_account_leases', {
  accountLockKey: varchar('account_lock_key', { length: 64 }).primaryKey(), runId: uuid('run_id'), workspaceId: uuid('workspace_id'), leaseToken: uuid('lease_token'), leaseOwner: varchar('lease_owner', { length: 160 }), leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [aiRuns.workspaceId, aiRuns.id], name: 'ai_account_leases_workspace_run_fk' }).onDelete('cascade')]);
export const aiArtifacts = pgTable('ai_artifacts', {
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  revision: integer('revision').notNull().default(1),
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), runId: uuid('run_id').notNull(), schemaVersion: integer('schema_version').notNull(), promptVersion: varchar('prompt_version', { length: 64 }).notNull(), locale: varchar('locale', { length: 2 }).notNull(), output: jsonb('output').$type<Record<string, unknown>>().notNull(), sources: jsonb('sources').$type<Record<string, unknown>>().notNull(), state: varchar('state', { length: 24 }).notNull().default('PENDING_REVIEW'), approvedAt: timestamp('approved_at', { withTimezone: true }), approvedHash: varchar('approved_hash', { length: 64 }), createdAt: created(),
}, (t) => [unique('ai_artifacts_workspace_id_uq').on(t.workspaceId, t.id), uniqueIndex('ai_artifacts_run_uq').on(t.workspaceId, t.runId), foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [aiRuns.workspaceId, aiRuns.id], name: 'ai_artifacts_workspace_run_fk' }).onDelete('cascade')]);
export const aiUsageSnapshots = pgTable('ai_usage_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), connectionId: uuid('connection_id').notNull(), availability: varchar('availability', { length: 16 }).notNull(), windows: jsonb('windows').$type<Array<Record<string, unknown>>>().notNull().default([]), source: varchar('source', { length: 80 }).notNull(), observedAt: timestamp('observed_at', { withTimezone: true }).notNull(), createdAt: created(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.connectionId], foreignColumns: [aiConnections.workspaceId, aiConnections.id], name: 'ai_usage_workspace_connection_fk' }).onDelete('cascade'), index('ai_usage_workspace_connection_idx').on(t.workspaceId, t.connectionId, t.observedAt)]);
export const aiDailyBudgets = pgTable('ai_daily_budgets', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), controlDay: date('control_day').notNull(), automaticReserved: integer('automatic_reserved').notNull().default(0), automaticStarted: integer('automatic_started').notNull().default(0), manualReserved: integer('manual_reserved').notNull().default(0), updatedAt: changed(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.controlDay] })]);
// Minimal deletion markers preserve one-off consent, idempotency and automatic deduplication without source/output text.
export const aiRunTombstones = pgTable('ai_run_tombstones', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), runId: uuid('run_id').notNull(),
  consentId: uuid('consent_id').notNull(), idempotencyHash: varchar('idempotency_hash', { length: 64 }).notNull(),
  jobId: uuid('job_id'), canonicalIdentity: varchar('canonical_identity', { length: 64 }), reservationPassId: uuid('reservation_pass_id'), createdAt: created(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.runId] }), uniqueIndex('ai_tombstone_idempotency_uq').on(t.workspaceId, t.idempotencyHash), index('ai_tombstone_job_idx').on(t.workspaceId, t.jobId), index('ai_tombstone_identity_idx').on(t.workspaceId, t.canonicalIdentity), index('ai_tombstone_consent_idx').on(t.workspaceId, t.consentId)]);

export const deletionJobs = pgTable('deletion_jobs', { id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), status: varchar('status', { length: 30 }).notNull().default('PENDING'), requestedAt: created(), completedAt: timestamp('completed_at', { withTimezone: true }) });

export const sourcePolicyReviews = pgTable('source_policy_reviews', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }), capability: varchar('capability', { length: 50 }).notNull(), accessClass: varchar('access_class', { length: 60 }).notNull(), permissionStatus: permissionEnum('permission_status').notNull(), apiHost: varchar('api_host', { length: 255 }).notNull(), referenceUrl: text('reference_url'), notes: text('notes').notNull().default(''), adapterVersion: varchar('adapter_version', { length: 80 }).notNull(), fixtureCoverage: integer('fixture_coverage').notNull().default(0), reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull(), reviewDueAt: timestamp('review_due_at', { withTimezone: true }), createdAt: created(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.boardId], foreignColumns: [boards.workspaceId, boards.id], name: 'source_policy_workspace_board_fk' }).onDelete('cascade'), check('source_policy_fixture_coverage_check', sql`${t.fixtureCoverage} between 0 and 100`)]);

export const searchProfiles = pgTable('search_profiles', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }), name: varchar('name', { length: 160 }).notNull(), targetTitles: jsonb('target_titles').$type<string[]>().notNull().default([]), countries: jsonb('countries').$type<string[]>().notNull().default([]), workModes: jsonb('work_modes').$type<string[]>().notNull().default([]), unknownLocationPolicy: varchar('unknown_location_policy', { length: 40 }).notNull().default('NEEDS_REVIEW'), maximumPostedAgeDays: integer('maximum_posted_age_days').notNull().default(14), enabled: boolean('enabled').notNull().default(false), boardIds: jsonb('board_ids').$type<string[]>().notNull().default([]), createdAt: created(), updatedAt: changed(),
});

export const savedJobSearches = pgTable('saved_job_searches', {
  revision: integer('revision').notNull().default(1), matcherVersion: integer('matcher_version').notNull().default(1),
  providerIds: jsonb('provider_ids').$type<string[]>().notNull().default(['remotive', 'arbeitnow']), includeRelated: boolean('include_related').notNull().default(false),
  idempotencyKey: varchar('idempotency_key', { length: 100 }),
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 200 }), company: varchar('company', { length: 200 }),
  location: varchar('location', { length: 200 }), workMode: varchar('work_mode', { length: 16 }).notNull().default('any'),
  frequencyHours: integer('frequency_hours').notNull().default(12), enabled: boolean('enabled').notNull().default(true),
  autoPrepare: boolean('auto_prepare').notNull().default(false), language: varchar('language', { length: 2 }).notNull().default('en'),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }), nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  lastRunStatus: varchar('last_run_status', { length: 24 }), lastResultCount: integer('last_result_count').notNull().default(0),
  lastNewCount: integer('last_new_count').notNull().default(0), lastError: varchar('last_error', { length: 80 }),
  failureCount: integer('failure_count').notNull().default(0), createdAt: created(), updatedAt: changed(),
}, (t) => [unique('saved_job_searches_workspace_id_uq').on(t.workspaceId, t.id), index('saved_job_searches_due_idx').on(t.enabled, t.nextRunAt)]);

/** Public feed cache is shared across workspaces; entries contain normalized public job listings only. */
export const jobSearchProviderCache = pgTable('job_search_provider_cache', {
  provider: varchar('provider', { length: 24 }).primaryKey(),
  payload: jsonb('payload').$type<Array<Record<string, unknown>>>().notNull().default([]),
  coverage: varchar('coverage', { length: 16 }).notNull().default('COMPLETE'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }), nextFetchAt: timestamp('next_fetch_at', { withTimezone: true }),
  failureCount: integer('failure_count').notNull().default(0), lastError: varchar('last_error', { length: 80 }),
  lastCompleteCount: integer('last_complete_count'),
  updatedAt: changed(),
});

export const jobSearchSources = pgTable('job_search_sources', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), jobId: uuid('job_id').notNull(),
  provider: varchar('provider', { length: 24 }).notNull(), externalId: varchar('external_id', { length: 300 }).notNull(),
  sourceUrl: text('source_url').notNull(), postedAt: timestamp('posted_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  // Consecutive complete, freshly downloaded feeds of this provider that did not list this job (ADR 021).
  missedCompleteReads: integer('missed_complete_reads').notNull().default(0),
  raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.jobId], foreignColumns: [jobs.workspaceId, jobs.id], name: 'job_search_sources_workspace_job_fk' }).onDelete('cascade'), uniqueIndex('job_search_sources_identity_uq').on(t.workspaceId, t.provider, t.externalId), index('job_search_sources_job_idx').on(t.workspaceId, t.jobId), check('job_search_sources_provider_check', sql`${t.provider} in ('remotive','arbeitnow','himalayas','adzuna')`)]);

export const savedJobSearchMatches = pgTable('saved_job_search_matches', {
  workspaceId: uuid('workspace_id').notNull(), searchId: uuid('search_id').notNull(), jobId: uuid('job_id').notNull(),
  matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(), lastMatchedAt: timestamp('last_matched_at', { withTimezone: true }).notNull().defaultNow(),
  autoPreparedAt: timestamp('auto_prepared_at', { withTimezone: true }), autoPrepareAttempts: integer('auto_prepare_attempts').notNull().default(0), autoPrepareError: varchar('auto_prepare_error', { length: 80 }), autoPrepareNextAttemptAt: timestamp('auto_prepare_next_attempt_at', { withTimezone: true }),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.searchId], foreignColumns: [savedJobSearches.workspaceId, savedJobSearches.id], name: 'saved_job_search_matches_workspace_search_fk' }).onDelete('cascade'), foreignKey({ columns: [t.workspaceId, t.jobId], foreignColumns: [jobs.workspaceId, jobs.id], name: 'saved_job_search_matches_workspace_job_fk' }).onDelete('cascade'), uniqueIndex('saved_job_search_matches_identity_uq').on(t.workspaceId, t.searchId, t.jobId), index('saved_job_search_matches_search_idx').on(t.searchId, t.lastMatchedAt), index('saved_job_search_matches_pending_idx').on(t.autoPreparedAt, t.autoPrepareNextAttemptAt, t.workspaceId)]);

/** Explicit workspace-level rules for hiding, never deleting, job search results. */
export const jobFilterPreferences = pgTable('job_filter_preferences', {
  workspaceId: uuid('workspace_id').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  preferences: jsonb('preferences').$type<{ excludedCompanies: string[]; requiredTerms: string[]; excludedTerms: string[] }>().notNull().default({ excludedCompanies: [], requiredTerms: [], excludedTerms: [] }),
  updatedAt: changed(),
});

/** Per-job restore is an explicit exception and does not edit the global preference lists. */
export const jobFilterOverrides = pgTable('job_filter_overrides', {
  workspaceId: uuid('workspace_id').notNull(), jobId: uuid('job_id').notNull(), createdAt: created(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.jobId], name: 'job_filter_overrides_pkey' }), foreignKey({ columns: [t.workspaceId, t.jobId], foreignColumns: [jobs.workspaceId, jobs.id], name: 'job_filter_overrides_workspace_job_fk' }).onDelete('cascade')]);

/** Explicit personal feedback about an offer; kept separate from seen, saved and computed match state. */
export const jobMatchFeedback = pgTable('job_match_feedback', {
  workspaceId: uuid('workspace_id').notNull(), jobId: uuid('job_id').notNull(),
  rating: varchar('rating', { length: 20 }).notNull(), reason: varchar('reason', { length: 24 }),
  createdAt: created(), updatedAt: changed(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.jobId], name: 'job_match_feedback_pkey' }),
  foreignKey({ columns: [t.workspaceId, t.jobId], foreignColumns: [jobs.workspaceId, jobs.id], name: 'job_match_feedback_workspace_job_fk' }).onDelete('cascade'),
  check('job_match_feedback_rating_check', sql`${t.rating} in ('INTERESTED','NOT_FOR_ME')`),
  check('job_match_feedback_reason_check', sql`${t.reason} is null or ${t.reason} in ('LOCATION','SENIORITY','WORK_MODE','ROLE_TYPE','REQUIREMENT','OTHER')`),
  index('job_match_feedback_workspace_created_idx').on(t.workspaceId, t.createdAt)]);
/** Consent snapshots are one-use records; no browser cookies or session state is persisted. */
export const assistedAttempts = pgTable('assisted_attempts', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  applicationId: uuid('application_id').notNull(), status: varchar('status', { length: 40 }).notNull().default('PREPARED'),
  plan: jsonb('plan').$type<import('@career/domain').AssistedPlan>().notNull(), digest: varchar('digest', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), consentedAt: timestamp('consented_at', { withTimezone: true }),
  result: jsonb('result').$type<{ filled?: string[]; manual?: string[]; reason?: string; outcome?: string }>().notNull().default({}),
  createdAt: created(), updatedAt: changed(),
}, (t) => [foreignKey({ columns: [t.workspaceId, t.applicationId], foreignColumns: [applications.workspaceId, applications.id], name: 'assisted_attempts_workspace_application_fk' }).onDelete('cascade'),
  uniqueIndex('assisted_attempts_one_active_uq').on(t.workspaceId, t.applicationId).where(sql`${t.status} in ('PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN')`),
  check('assisted_attempts_status_check', sql`${t.status} in ('PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN', 'CONFIRMED', 'NOT_SUBMITTED', 'CANCELLED', 'INVALIDATED', 'FAILED')`),
]);


/** Persisted background searches. Public query caches are separate from personal result/review state. */
export const searchRuns = pgTable('search_runs', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), searchId: uuid('search_id').notNull(),
  revision: integer('revision').notNull(), criteria: jsonb('criteria').$type<Record<string, unknown>>().notNull(),
  status: varchar('status',{length:16}).notNull().default('QUEUED'), manual: boolean('manual').notNull().default(false),
  owner: uuid('owner'), leaseUntil: timestamp('lease_until',{withTimezone:true}), error: varchar('error',{length:80}),
  createdAt: created(), startedAt: timestamp('started_at',{withTimezone:true}), finishedAt: timestamp('finished_at',{withTimezone:true}),
},t=>[unique().on(t.workspaceId,t.id),foreignKey({columns:[t.workspaceId,t.searchId],foreignColumns:[savedJobSearches.workspaceId,savedJobSearches.id]}).onDelete('cascade'),
  uniqueIndex('search_active_run_uq').on(t.workspaceId,t.searchId,t.revision).where(sql`${t.finishedAt} is null`), index('search_runs_queue_idx').on(t.status,t.leaseUntil,t.createdAt)]);
export const searchRunSources = pgTable('search_run_sources', {
  workspaceId:uuid('workspace_id').notNull(),runId:uuid('run_id').notNull(),provider:varchar('provider',{length:24}).notNull(),
  status:varchar('status',{length:16}).notNull().default('QUEUED'),coverage:varchar('coverage',{length:16}),
  fetchedAt:timestamp('fetched_at',{withTimezone:true}),nextFetchAt:timestamp('next_fetch_at',{withTimezone:true}),error:varchar('error',{length:80}),found:integer('found').notNull().default(0),
},t=>[primaryKey({columns:[t.workspaceId,t.runId,t.provider]}),foreignKey({columns:[t.workspaceId,t.runId],foreignColumns:[searchRuns.workspaceId,searchRuns.id]}).onDelete('cascade')]);
/** Desktop alerts are opt-in and carry no job names, companies, URLs, or salary data. */
export const desktopNotificationSettings = pgTable('desktop_notification_settings', {
  workspaceId: uuid('workspace_id').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false), language: varchar('language', { length: 2 }).notNull().default('en'),
  lastStatus: varchar('last_status', { length: 24 }).notNull().default('NOT_TESTED'), lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }), updatedAt: changed(),
}, t => [check('desktop_notification_settings_language_check', sql`${t.language} in ('en','es')`), check('desktop_notification_settings_status_check', sql`${t.lastStatus} in ('NOT_TESTED','ACCEPTED','UNAVAILABLE','FAILED')`)]);
/** Durable, privacy-safe queue of automatic-search alerts; run_id makes v2 enqueue idempotent. */
export const desktopNotificationEvents = pgTable('desktop_notification_events', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), searchId: uuid('search_id').notNull(), runId: uuid('run_id'),
  newCount: integer('new_count').notNull(), language: varchar('language', { length: 2 }).notNull(), status: varchar('status', { length: 16 }).notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0), leaseUntil: timestamp('lease_until', { withTimezone: true }), lastError: varchar('last_error', { length: 64 }),
  createdAt: created(), deliveredAt: timestamp('delivered_at', { withTimezone: true }),
}, t => [foreignKey({ columns: [t.workspaceId, t.searchId], foreignColumns: [savedJobSearches.workspaceId, savedJobSearches.id], name: 'desktop_notification_events_search_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [searchRuns.workspaceId, searchRuns.id], name: 'desktop_notification_events_run_fk' }).onDelete('cascade'),
  check('desktop_notification_events_count_check', sql`${t.newCount} > 0`), check('desktop_notification_events_language_check', sql`${t.language} in ('en','es')`),
  check('desktop_notification_events_status_check', sql`${t.status} in ('PENDING','SENDING','SENT','FAILED','DISABLED')`),
  uniqueIndex('desktop_notification_events_workspace_run_uq').on(t.workspaceId, t.runId).where(sql`${t.runId} is not null`),
  index('desktop_notification_events_queue_idx').on(t.status, t.leaseUntil, t.createdAt)]);
export const searchQueryCache = pgTable('search_query_cache', {
  provider:varchar('provider',{length:24}).notNull(),queryHash:varchar('query_hash',{length:64}).notNull(),payload:jsonb('payload').$type<Record<string,unknown>[]>().notNull().default([]),
  coverage:varchar('coverage',{length:16}).notNull().default('BOUNDED'),fetchedAt:timestamp('fetched_at',{withTimezone:true}),nextFetchAt:timestamp('next_fetch_at',{withTimezone:true}),
  lastUsedAt:timestamp('last_used_at',{withTimezone:true}).notNull().defaultNow(),error:varchar('error',{length:80}),failures:integer('failures').notNull().default(0),
},t=>[primaryKey({columns:[t.provider,t.queryHash]})]);
export const searchProviderBudget = pgTable('search_provider_budget', {
  provider:varchar('provider',{length:24}).notNull(),day:date('day').notNull(),requests:integer('requests').notNull().default(0),
},t=>[primaryKey({columns:[t.provider,t.day]})]);
export const searchRunResults = pgTable('search_run_results', {
  workspaceId:uuid('workspace_id').notNull(),runId:uuid('run_id').notNull(),searchId:uuid('search_id').notNull(),jobId:uuid('job_id').notNull(),
  score:integer('score').notNull(),reasons:jsonb('reasons').$type<string[]>().notNull().default([]),locationStatus:varchar('location_status',{length:32}).notNull(),
  unknownLocation:boolean('unknown_location').notNull().default(false),postedAt:timestamp('posted_at',{withTimezone:true}),sources:jsonb('sources').$type<Record<string,unknown>[]>().notNull().default([]),
},t=>[primaryKey({columns:[t.workspaceId,t.runId,t.jobId]}),
  foreignKey({columns:[t.workspaceId,t.runId],foreignColumns:[searchRuns.workspaceId,searchRuns.id]}).onDelete('cascade'),
  foreignKey({columns:[t.workspaceId,t.searchId],foreignColumns:[savedJobSearches.workspaceId,savedJobSearches.id]}).onDelete('cascade'),
  foreignKey({columns:[t.workspaceId,t.jobId],foreignColumns:[jobs.workspaceId,jobs.id]}).onDelete('cascade'),index('search_run_results_rank_idx').on(t.workspaceId,t.searchId,t.runId,t.score.desc(),t.jobId)]);
export const searchJobReviews = pgTable('search_job_reviews', {
  workspaceId:uuid('workspace_id').notNull(),searchId:uuid('search_id').notNull(),jobId:uuid('job_id').notNull(),
  firstMatchedAt:timestamp('first_matched_at',{withTimezone:true}).notNull().defaultNow(),seenAt:timestamp('seen_at',{withTimezone:true}),
},t=>[primaryKey({columns:[t.workspaceId,t.searchId,t.jobId]}),
  foreignKey({columns:[t.workspaceId,t.searchId],foreignColumns:[savedJobSearches.workspaceId,savedJobSearches.id]}).onDelete('cascade'),
  foreignKey({columns:[t.workspaceId,t.jobId],foreignColumns:[jobs.workspaceId,jobs.id]}).onDelete('cascade')]);
export const jobIdentityMembers = pgTable('job_identity_members', {
  workspaceId:uuid('workspace_id').notNull(),jobId:uuid('job_id').notNull(),identityKey:varchar('identity_key',{length:64}).notNull(),evidence:jsonb('evidence').$type<Record<string,unknown>>().notNull(),
},t=>[primaryKey({columns:[t.workspaceId,t.jobId]}),foreignKey({columns:[t.workspaceId,t.jobId],foreignColumns:[jobs.workspaceId,jobs.id]}).onDelete('cascade'),index('job_identity_group_idx').on(t.workspaceId,t.identityKey)]);
export const searchPreparationBudget = pgTable('search_preparation_budget', {
  workspaceId:uuid('workspace_id').notNull().references(()=>workspaces.id,{onDelete:'cascade'}),day:date('day').notNull(),attempted:integer('attempted').notNull().default(0),
},t=>[primaryKey({columns:[t.workspaceId,t.day]})]);

/**
 * Job evaluation batches (#110). One running or paused batch per workspace; items keep the report computed for each job
 * so pausing or cancelling never loses what was evaluated. Items do not reference jobs: a job that disappears is
 * reported as failed instead of silently removed.
 */
export const jobReportBatches = pgTable('job_report_batches', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  idempotencyKey: uuid('idempotency_key').notNull(), status: varchar('status', { length: 16 }).notNull().default('RUNNING'), total: integer('total').notNull(),
  reportVersion: integer('report_version').notNull(), createdAt: created(), updatedAt: changed(), finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [
  unique('job_report_batches_workspace_id_uq').on(t.workspaceId, t.id), uniqueIndex('job_report_batches_idempotency_uq').on(t.workspaceId, t.idempotencyKey),
  uniqueIndex('job_report_batches_one_active_uq').on(t.workspaceId).where(sql`${t.status} in ('RUNNING', 'PAUSED')`), index('job_report_batches_workspace_created_idx').on(t.workspaceId, t.createdAt),
  check('job_report_batches_status_check', sql`${t.status} in ('RUNNING', 'PAUSED', 'CANCELLED', 'COMPLETED')`), check('job_report_batches_total_check', sql`${t.total} between 1 and 50`),
]);
export const jobReportBatchItems = pgTable('job_report_batch_items', {
  workspaceId: uuid('workspace_id').notNull(), batchId: uuid('batch_id').notNull(), jobId: uuid('job_id').notNull(), position: integer('position').notNull(),
  company: varchar('company', { length: 200 }), title: varchar('title', { length: 300 }),
  status: varchar('status', { length: 16 }).notNull().default('PENDING'), verdict: varchar('verdict', { length: 24 }), errorCode: varchar('error_code', { length: 40 }),
  report: jsonb('report').$type<import('@career/domain').JobReport>(), evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.batchId, t.jobId] }),
  foreignKey({ columns: [t.workspaceId, t.batchId], foreignColumns: [jobReportBatches.workspaceId, jobReportBatches.id], name: 'job_report_batch_items_workspace_batch_fk' }).onDelete('cascade'),
  index('job_report_batch_items_pending_idx').on(t.workspaceId, t.batchId, t.status, t.position),
  check('job_report_batch_items_status_check', sql`${t.status} in ('PENDING', 'DONE', 'FAILED', 'SKIPPED')`),
  check('job_report_batch_items_verdict_check', sql`${t.verdict} is null or ${t.verdict} in ('GOOD_OPTION', 'REVIEW', 'PROBABLY_NOT_A_FIT')`),
]);

/** Every change of a job's availability and why (ADR 021). Holds no job content beyond the reference. */
export const jobAvailabilityEvents = pgTable('job_availability_events', {
  id: uuid('id').defaultRandom().primaryKey(), workspaceId: uuid('workspace_id').notNull(), jobId: uuid('job_id').notNull(),
  fromState: availabilityEnum('from_state').notNull(), toState: availabilityEnum('to_state').notNull(),
  reason: varchar('reason', { length: 30 }).notNull(), createdAt: created(),
}, (t) => [
  foreignKey({ columns: [t.workspaceId, t.jobId], foreignColumns: [jobs.workspaceId, jobs.id], name: 'job_availability_events_workspace_job_fk' }).onDelete('cascade'),
  index('job_availability_events_job_idx').on(t.workspaceId, t.jobId, t.createdAt),
  check('job_availability_events_reason_check', sql`${t.reason} in ('ABSENT_FROM_SOURCES', 'SEEN_AGAIN', 'CLOSED_BY_USER', 'REOPENED_BY_USER')`),
]);
