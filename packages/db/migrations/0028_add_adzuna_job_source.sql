ALTER TABLE "job_search_sources" DROP CONSTRAINT "job_search_sources_provider_check";
--> statement-breakpoint
ALTER TABLE "job_search_sources" ADD CONSTRAINT "job_search_sources_provider_check" CHECK ("job_search_sources"."provider" in ('remotive','arbeitnow','himalayas','adzuna'));
