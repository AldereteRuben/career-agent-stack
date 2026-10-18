CREATE TABLE "job_match_feedback" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"rating" varchar(20) NOT NULL,
	"reason" varchar(24),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_match_feedback_pkey" PRIMARY KEY("workspace_id","job_id"),
	CONSTRAINT "job_match_feedback_rating_check" CHECK ("job_match_feedback"."rating" in ('INTERESTED','NOT_FOR_ME')),
	CONSTRAINT "job_match_feedback_reason_check" CHECK ("job_match_feedback"."reason" is null or "job_match_feedback"."reason" in ('LOCATION','SENIORITY','WORK_MODE','ROLE_TYPE','REQUIREMENT','OTHER'))
);
--> statement-breakpoint
ALTER TABLE "job_match_feedback" ADD CONSTRAINT "job_match_feedback_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_match_feedback_workspace_created_idx" ON "job_match_feedback" USING btree ("workspace_id","created_at");