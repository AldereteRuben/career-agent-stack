CREATE TABLE "application_follow_up_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"language" varchar(2) NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_follow_up_drafts_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "application_follow_up_drafts_language_check" CHECK ("application_follow_up_drafts"."language" in ('es', 'en'))
);
--> statement-breakpoint
ALTER TABLE "application_follow_up_drafts" ADD CONSTRAINT "application_follow_up_drafts_workspace_application_fk" FOREIGN KEY ("workspace_id","application_id") REFERENCES "public"."applications"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_follow_up_drafts_application_uq" ON "application_follow_up_drafts" USING btree ("workspace_id","application_id");