CREATE TABLE "interview_preparation_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"source_id" uuid NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_preparation_evidence_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "interview_preparation_evidence_kind_check" CHECK ("interview_preparation_evidence"."kind" in ('JOB_SNAPSHOT', 'RESUME_VERSION', 'APPROVED_FACT')),
	CONSTRAINT "interview_preparation_evidence_hash_check" CHECK ("interview_preparation_evidence"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "interview_preparation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"origin" varchar(20) NOT NULL,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"evidence_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_preparation_items_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "interview_preparation_items_kind_check" CHECK ("interview_preparation_items"."kind" in ('REQUIREMENT', 'EXERCISE', 'STUDY', 'QUESTION', 'NOTE')),
	CONSTRAINT "interview_preparation_items_origin_check" CHECK ("interview_preparation_items"."origin" in ('JOB_SNAPSHOT', 'APPROVED_FACT', 'USER_NOTE', 'USER_RESEARCH', 'FIXED_TEMPLATE', 'ASSISTANT')),
	CONSTRAINT "interview_preparation_items_position_check" CHECK ("interview_preparation_items"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "interview_preparation_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"language" varchar(2) NOT NULL,
	"stage" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_preparation_plans_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "interview_preparation_plans_language_check" CHECK ("interview_preparation_plans"."language" in ('es', 'en'))
);
--> statement-breakpoint
CREATE TABLE "interview_preparation_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'IN_PROGRESS' NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_preparation_sessions_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "interview_preparation_sessions_status_check" CHECK ("interview_preparation_sessions"."status" in ('IN_PROGRESS', 'COMPLETED')),
	CONSTRAINT "interview_preparation_sessions_ended_check" CHECK (("interview_preparation_sessions"."status" = 'COMPLETED') = ("interview_preparation_sessions"."ended_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "interview_preparation_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"feedback" jsonb,
	"learning_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_preparation_turns_position_check" CHECK ("interview_preparation_turns"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "interview_preparation_evidence" ADD CONSTRAINT "interview_preparation_evidence_workspace_plan_fk" FOREIGN KEY ("workspace_id","plan_id") REFERENCES "public"."interview_preparation_plans"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_preparation_items" ADD CONSTRAINT "interview_preparation_items_workspace_plan_fk" FOREIGN KEY ("workspace_id","plan_id") REFERENCES "public"."interview_preparation_plans"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_preparation_items" ADD CONSTRAINT "interview_preparation_items_workspace_evidence_fk" FOREIGN KEY ("workspace_id","evidence_id") REFERENCES "public"."interview_preparation_evidence"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_preparation_plans" ADD CONSTRAINT "interview_preparation_plans_workspace_application_fk" FOREIGN KEY ("workspace_id","application_id") REFERENCES "public"."applications"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_preparation_sessions" ADD CONSTRAINT "interview_preparation_sessions_workspace_plan_fk" FOREIGN KEY ("workspace_id","plan_id") REFERENCES "public"."interview_preparation_plans"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_preparation_turns" ADD CONSTRAINT "interview_preparation_turns_workspace_session_fk" FOREIGN KEY ("workspace_id","session_id") REFERENCES "public"."interview_preparation_sessions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interview_preparation_evidence_plan_source_uq" ON "interview_preparation_evidence" USING btree ("workspace_id","plan_id","kind","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_preparation_items_plan_position_uq" ON "interview_preparation_items" USING btree ("workspace_id","plan_id","position");--> statement-breakpoint
CREATE INDEX "interview_preparation_plans_application_idx" ON "interview_preparation_plans" USING btree ("workspace_id","application_id","created_at");--> statement-breakpoint
CREATE INDEX "interview_preparation_sessions_plan_idx" ON "interview_preparation_sessions" USING btree ("workspace_id","plan_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_preparation_turns_session_position_uq" ON "interview_preparation_turns" USING btree ("workspace_id","session_id","position");