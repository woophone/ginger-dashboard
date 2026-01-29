-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  repo_path TEXT,
  staging_url TEXT,
  production_url TEXT,
  status TEXT DEFAULT 'unknown',  -- unknown, active, archived
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Features table
CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'not-started',  -- not-started, in-progress, ready, blocked
  blocker TEXT,
  category TEXT,
  subcategory TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Test logs table (synced from .test-log.jsonl)
CREATE TABLE IF NOT EXISTS test_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  feature_id TEXT REFERENCES features(id),
  feature_name TEXT NOT NULL,
  test_type TEXT NOT NULL,  -- browser, curl, unit, e2e, health
  target TEXT NOT NULL,     -- local, staging, production
  result TEXT NOT NULL,     -- pass, fail
  verified TEXT,            -- JSON array of what was verified
  note TEXT,
  tested_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- File modifications (synced from git)
CREATE TABLE IF NOT EXISTS file_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  feature_id TEXT REFERENCES features(id),
  file_path TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  commit_hash TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Considerations table
CREATE TABLE IF NOT EXISTS considerations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  feature_id TEXT,
  category TEXT,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_considerations_project ON considerations(project_id);
CREATE INDEX IF NOT EXISTS idx_considerations_feature ON considerations(feature_id);

-- Computed status view
CREATE VIEW IF NOT EXISTS feature_status AS
SELECT
  f.id,
  f.project_id,
  f.name,
  f.status,
  f.blocker,
  f.category,
  f.subcategory,
  (SELECT MAX(changed_at) FROM file_changes WHERE feature_id = f.id) as last_modified,
  (SELECT MAX(tested_at) FROM test_logs WHERE feature_id = f.id AND result = 'pass') as last_tested,
  (SELECT test_type FROM test_logs WHERE feature_id = f.id AND result = 'pass' ORDER BY tested_at DESC LIMIT 1) as last_test_type,
  (SELECT target FROM test_logs WHERE feature_id = f.id AND result = 'pass' ORDER BY tested_at DESC LIMIT 1) as last_test_target,
  CASE
    WHEN (SELECT MAX(changed_at) FROM file_changes WHERE feature_id = f.id) >
         (SELECT MAX(tested_at) FROM test_logs WHERE feature_id = f.id AND result = 'pass')
    THEN 1 ELSE 0
  END as is_stale
FROM features f;

-- Leads table (for tracking business leads)
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,              -- facebook-group, wudog-form, referral, etc
  business_type TEXT NOT NULL,       -- dog-training, bounce-house, web-design
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  facebook_url TEXT,                 -- FB profile URL
  status TEXT DEFAULT 'new',         -- new, contacted, responded, won, lost
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id);
CREATE INDEX IF NOT EXISTS idx_test_logs_feature ON test_logs(feature_id);
CREATE INDEX IF NOT EXISTS idx_test_logs_project ON test_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_file_changes_feature ON file_changes(feature_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_business_type ON leads(business_type);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);

-- Add missing fields to leads table for Facebook monitoring
ALTER TABLE leads ADD COLUMN post_url TEXT;
ALTER TABLE leads ADD COLUMN posted_at TEXT;  -- When the FB post was made (for post age)
ALTER TABLE leads ADD COLUMN competitors TEXT; -- JSON array of businesses that responded in comments
