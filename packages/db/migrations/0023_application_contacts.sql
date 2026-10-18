CREATE TABLE "application_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"role" varchar(120) NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_contacts_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "workspace_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"profile_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_contacts_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "application_contacts" ADD CONSTRAINT "application_contacts_workspace_application_fk" FOREIGN KEY ("workspace_id","application_id") REFERENCES "public"."applications"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_contacts" ADD CONSTRAINT "application_contacts_workspace_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."workspace_contacts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_contacts" ADD CONSTRAINT "workspace_contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_contacts_application_contact_uq" ON "application_contacts" USING btree ("workspace_id","application_id","contact_id");--> statement-breakpoint
CREATE INDEX "application_contacts_workspace_application_idx" ON "application_contacts" USING btree ("workspace_id","application_id");--> statement-breakpoint
CREATE INDEX "workspace_contacts_workspace_name_idx" ON "workspace_contacts" USING btree ("workspace_id","name");