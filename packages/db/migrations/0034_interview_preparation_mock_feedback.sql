CREATE TABLE "interview_preparation_feedback_proposals" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"feedback_sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_preparation_feedback_proposals_pk" PRIMARY KEY("workspace_id","run_id","turn_id"),
	CONSTRAINT "interview_preparation_feedback_proposals_hash_check" CHECK ("interview_preparation_feedback_proposals"."feedback_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_operation_check";--> statement-breakpoint
ALTER TABLE "interview_preparation_turns" ADD COLUMN "assistant_feedback" jsonb;--> statement-breakpoint
ALTER TABLE "interview_preparation_feedback_proposals" ADD CONSTRAINT "interview_preparation_feedback_proposals_workspace_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."ai_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_preparation_turns" ADD CONSTRAINT "interview_preparation_turns_workspace_id_uq" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "interview_preparation_feedback_proposals" ADD CONSTRAINT "interview_preparation_feedback_proposals_workspace_turn_fk" FOREIGN KEY ("workspace_id","turn_id") REFERENCES "public"."interview_preparation_turns"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_operation_check" CHECK ("ai_runs"."operation" in ('SEARCH_DRAFT', 'JOB_ANALYSIS', 'RESUME_DRAFT', 'ANSWER_DRAFT', 'DOCUMENT_REWORD', 'RESUME_IMPORT', 'INTERVIEW_PREP', 'INTERVIEW_MOCK_FEEDBACK'));
