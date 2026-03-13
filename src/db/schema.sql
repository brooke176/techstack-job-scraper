-- TechStack DB schema
-- Run with: psql $DATABASE_URL -f src/db/schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Companies table: one row per company
CREATE TABLE IF NOT EXISTS companies (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain        TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Tech profiles: one row per company, updated on each scrape
CREATE TABLE IF NOT EXISTS company_tech_profiles (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain        TEXT NOT NULL REFERENCES companies(domain) ON DELETE CASCADE,
  source        TEXT NOT NULL,             -- greenhouse | lever | indeed | html_headers
  job_count     INTEGER DEFAULT 0,
  tech_count    INTEGER DEFAULT 0,
  tech_profile  JSONB NOT NULL DEFAULT '[]',
  -- tech_profile shape:
  -- [{
  --   canonical: "React",
  --   category: "frontend",
  --   confidence: 0.70,
  --   sources: ["job_listing"],
  --   jobMentionCount: 12,
  --   jobMentionFrequency: 0.85
  -- }]
  scraped_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(domain, source)
);

-- Tech changes log: append-only history of stack changes
CREATE TABLE IF NOT EXISTS tech_change_events (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain        TEXT NOT NULL,
  event_type    TEXT NOT NULL CHECK (event_type IN ('added', 'removed', 'confidence_change')),
  canonical     TEXT NOT NULL,    -- tech name e.g. "React"
  category      TEXT NOT NULL,
  old_confidence FLOAT,
  new_confidence FLOAT,
  detected_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Scrape run log
CREATE TABLE IF NOT EXISTS scrape_runs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_type      TEXT NOT NULL,    -- greenhouse | lever | indeed | full
  companies_attempted INTEGER,
  companies_succeeded INTEGER,
  companies_failed    INTEGER,
  started_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  error_log     JSONB DEFAULT '[]'
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_tech_profile_domain ON company_tech_profiles(domain);
CREATE INDEX IF NOT EXISTS idx_tech_profile_scraped_at ON company_tech_profiles(scraped_at DESC);
-- GIN index for JSONB queries: find all companies using React
CREATE INDEX IF NOT EXISTS idx_tech_profile_jsonb ON company_tech_profiles USING GIN(tech_profile);
CREATE INDEX IF NOT EXISTS idx_tech_changes_domain ON tech_change_events(domain);
CREATE INDEX IF NOT EXISTS idx_tech_changes_canonical ON tech_change_events(canonical);
CREATE INDEX IF NOT EXISTS idx_tech_changes_detected ON tech_change_events(detected_at DESC);

-- Example queries after data is loaded:
--
-- Find all companies using React with high confidence:
--   SELECT domain FROM company_tech_profiles
--   WHERE tech_profile @> '[{"canonical": "React"}]'
--   AND (tech_profile->0->>'confidence')::float > 0.7;
--
-- Find companies that recently added Kubernetes:
--   SELECT domain, detected_at FROM tech_change_events
--   WHERE canonical = 'Kubernetes' AND event_type = 'added'
--   ORDER BY detected_at DESC LIMIT 100;
--
-- Get full stack for a company:
--   SELECT tech_profile FROM company_tech_profiles
--   WHERE domain = 'stripe.com' ORDER BY scraped_at DESC LIMIT 1;
