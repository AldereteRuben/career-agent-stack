ALTER TABLE "interview_preparation_turns" ADD COLUMN "kind" varchar(10) DEFAULT 'QUESTION' NOT NULL;--> statement-breakpoint
ALTER TABLE "interview_preparation_turns" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "interview_preparation_turns" ADD CONSTRAINT "interview_preparation_turns_kind_check" CHECK ("interview_preparation_turns"."kind" in ('QUESTION', 'PROBE'));