CREATE TABLE "assisted_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"status" varchar(40) DEFAULT 'PREPARED' NOT NULL,
	"plan" jsonb NOT NULL,
	"digest" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consented_at" timestamp with time zone,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assisted_attempts_status_check" CHECK ("assisted_attempts"."status" in ('PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN', 'CONFIRMED', 'NOT_SUBMITTED', 'CANCELLED', 'INVALIDATED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "assisted_attempts" ADD CONSTRAINT "assisted_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assisted_attempts" ADD CONSTRAINT "assisted_attempts_workspace_application_fk" FOREIGN KEY ("workspace_id","application_id") REFERENCES "public"."applications"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assisted_attempts_one_active_uq" ON "assisted_attempts" USING btree ("workspace_id","application_id") WHERE "assisted_attempts"."status" in ('PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN');