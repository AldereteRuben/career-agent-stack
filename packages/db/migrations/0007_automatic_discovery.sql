ALTER TABLE "boards" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "last_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "last_run_status" varchar(30);--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "last_new_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "last_error" varchar(80);--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "discovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "discovery_enabled" boolean DEFAULT false NOT NULL;