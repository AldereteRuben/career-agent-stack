CREATE TABLE "desktop_notification_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"search_id" uuid NOT NULL,
	"run_id" uuid,
	"new_count" integer NOT NULL,
	"language" varchar(2) NOT NULL,
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "desktop_notification_events_count_check" CHECK ("desktop_notification_events"."new_count" > 0),
	CONSTRAINT "desktop_notification_events_language_check" CHECK ("desktop_notification_events"."language" in ('en','es')),
	CONSTRAINT "desktop_notification_events_status_check" CHECK ("desktop_notification_events"."status" in ('PENDING','SENDING','SENT','FAILED','DISABLED'))
);
--> statement-breakpoint
CREATE TABLE "desktop_notification_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"language" varchar(2) DEFAULT 'en' NOT NULL,
	"last_status" varchar(24) DEFAULT 'NOT_TESTED' NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_notification_settings_language_check" CHECK ("desktop_notification_settings"."language" in ('en','es')),
	CONSTRAINT "desktop_notification_settings_status_check" CHECK ("desktop_notification_settings"."last_status" in ('NOT_TESTED','ACCEPTED','UNAVAILABLE','FAILED'))
);
--> statement-breakpoint
ALTER TABLE "desktop_notification_events" ADD CONSTRAINT "desktop_notification_events_search_fk" FOREIGN KEY ("workspace_id","search_id") REFERENCES "public"."saved_job_searches"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_notification_events" ADD CONSTRAINT "desktop_notification_events_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."search_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_notification_settings" ADD CONSTRAINT "desktop_notification_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_notification_events_workspace_run_uq" ON "desktop_notification_events" USING btree ("workspace_id","run_id") WHERE "desktop_notification_events"."run_id" is not null;--> statement-breakpoint
CREATE INDEX "desktop_notification_events_queue_idx" ON "desktop_notification_events" USING btree ("status","lease_until","created_at");