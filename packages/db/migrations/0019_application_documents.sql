CREATE TABLE "ai_document_reword_proposals" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"sentence_id" varchar(80) NOT NULL,
	"proposal_sha256" varchar(64) NOT NULL,
	CONSTRAINT "ai_document_reword_proposals_pk" PRIMARY KEY("workspace_id","run_id","sentence_id")
);
--> statement-breakpoint
CREATE TABLE "application_document_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"parent_revision" integer,
	"claims" jsonb NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"offer_snapshot_id" uuid NOT NULL,
	"offer_hash" varchar(64) NOT NULL,
	"facts_hash" varchar(64) NOT NULL,
	"paper_size" varchar(10) NOT NULL,
	"text_storage_path" text NOT NULL,
	"text_sha256" varchar(64) NOT NULL,
	"pdf_storage_path" text NOT NULL,
	"pdf_sha256" varchar(64) NOT NULL,
	"confirmed_unsupported_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_document_revisions_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "application_document_revisions_revision_check" CHECK ("application_document_revisions"."revision" > 0),
	CONSTRAINT "application_document_revisions_paper_size_check" CHECK ("application_document_revisions"."paper_size" in ('A4', 'LETTER')),
	CONSTRAINT "application_document_revisions_approved_check" CHECK ("application_document_revisions"."approved_at" is null or "application_document_revisions"."approved_by" is not null)
);
--> statement-breakpoint
CREATE TABLE "application_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"language" varchar(2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_documents_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "application_documents_kind_check" CHECK ("application_documents"."kind" in ('RESUME', 'COVER_LETTER')),
	CONSTRAINT "application_documents_language_check" CHECK ("application_documents"."language" in ('es', 'en'))
);
--> statement-breakpoint
ALTER TABLE "ai_document_reword_proposals" ADD CONSTRAINT "ai_document_reword_proposals_workspace_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."ai_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_document_revisions" ADD CONSTRAINT "application_document_revisions_workspace_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."application_documents"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_document_revisions" ADD CONSTRAINT "application_document_revisions_workspace_offer_snapshot_fk" FOREIGN KEY ("workspace_id","offer_snapshot_id") REFERENCES "public"."job_snapshots"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_workspace_application_fk" FOREIGN KEY ("workspace_id","application_id") REFERENCES "public"."applications"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_document_revisions_document_revision_uq" ON "application_document_revisions" USING btree ("workspace_id","document_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "application_documents_application_kind_language_uq" ON "application_documents" USING btree ("workspace_id","application_id","kind","language");--> statement-breakpoint
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_operation_check";--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_operation_check" CHECK ("ai_runs"."operation" in ('SEARCH_DRAFT', 'JOB_ANALYSIS', 'RESUME_DRAFT', 'ANSWER_DRAFT', 'DOCUMENT_REWORD'));