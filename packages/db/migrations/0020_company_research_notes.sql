ALTER TABLE "jobs" ADD COLUMN "company_research" jsonb DEFAULT '{"whatItDoes":"","howItMakesMoney":"","recentNews":"","culture":"","questionsToAsk":""}'::jsonb NOT NULL;
ALTER TABLE "jobs" ADD COLUMN "company_research_revision" integer DEFAULT 1 NOT NULL;
