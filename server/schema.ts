export const schemaSql = `
CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY,
  email VARCHAR(254),
  display_name VARCHAR(80) NOT NULL,
  password_hash TEXT,
  role VARCHAR(16) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP INDEX IF EXISTS app_users_username_lower_idx;
ALTER TABLE app_users DROP COLUMN IF EXISTS username;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email VARCHAR(254);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_display_name_lower_idx ON app_users (LOWER(display_name));
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_idx ON app_users (LOWER(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON app_sessions(user_id);
CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx ON app_sessions(expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY,
  project_key VARCHAR(8) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  color CHAR(7) NOT NULL,
  created_by UUID NOT NULL REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS issue_counters (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  month_day CHAR(4) NOT NULL,
  value INTEGER NOT NULL CHECK (value > 0),
  PRIMARY KEY (project_id, month_day)
);

CREATE TABLE IF NOT EXISTS issues (
  id UUID PRIMARY KEY,
  issue_key VARCHAR(40) NOT NULL UNIQUE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title VARCHAR(240) NOT NULL,
  description TEXT NOT NULL DEFAULT '<p></p>',
  status VARCHAR(160) NOT NULL,
  priority VARCHAR(160) NOT NULL,
  module VARCHAR(100) NOT NULL DEFAULT '未分类',
  environment VARCHAR(160) NOT NULL DEFAULT '未注明',
  reporter_id UUID NOT NULL REFERENCES app_users(id),
  assignee_id UUID NOT NULL REFERENCES app_users(id),
  last_modified_by UUID NOT NULL REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS issues_project_idx ON issues(project_id);
CREATE INDEX IF NOT EXISTS issues_updated_idx ON issues(project_id, updated_at DESC);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS assignee_id UUID REFERENCES app_users(id);
UPDATE issues SET assignee_id = last_modified_by WHERE assignee_id IS NULL;
ALTER TABLE issues ALTER COLUMN assignee_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS issue_assignees (
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (issue_id, user_id)
);

CREATE INDEX IF NOT EXISTS issue_assignees_user_idx ON issue_assignees(user_id, issue_id);
INSERT INTO issue_assignees (issue_id, user_id, position)
SELECT id, assignee_id, 0 FROM issues
ON CONFLICT (issue_id, user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS issue_activities (
  id UUID PRIMARY KEY,
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_id UUID NOT NULL REFERENCES app_users(id),
  action VARCHAR(120) NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('created', 'changed', 'commented')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS issue_activities_issue_idx ON issue_activities(issue_id, created_at DESC);

ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_check;
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_priority_check;
ALTER TABLE issues ALTER COLUMN status TYPE VARCHAR(160);
ALTER TABLE issues ALTER COLUMN priority TYPE VARCHAR(160);

CREATE TABLE IF NOT EXISTS app_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issue_dictionary_sets (
  kind VARCHAR(16) PRIMARY KEY CHECK (kind IN ('status', 'priority', 'environment')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issue_dictionary_entries (
  kind VARCHAR(16) NOT NULL REFERENCES issue_dictionary_sets(kind),
  value VARCHAR(160) NOT NULL,
  label VARCHAR(160) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_terminal BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (kind, value),
  CHECK (NOT is_default OR active),
  CHECK (NOT is_terminal OR kind = 'status'),
  CHECK (NOT (is_default AND is_terminal))
);

CREATE UNIQUE INDEX IF NOT EXISTS issue_dictionary_default_idx
  ON issue_dictionary_entries(kind) WHERE is_default;

DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(739245108);
  IF NOT EXISTS (SELECT 1 FROM app_migrations WHERE name = 'issue-dictionaries-v1') THEN
    UPDATE issue_activities
    SET action = REPLACE(action, '指定人员', '负责人'),
        detail = REPLACE(detail, '指定人员', '负责人')
    WHERE action LIKE '%指定人员%' OR detail LIKE '%指定人员%';

    -- Legacy names are converted once. Future dictionary labels remain administrator controlled.
    UPDATE issues
    SET status = CASE status
      WHEN '待验证' THEN '待复测'
      WHEN '已关闭' THEN '不适用'
      WHEN '已解决' THEN '已修复'
      WHEN '待优化' THEN '不解决'
      ELSE status
    END
    WHERE status IN ('待验证', '已关闭', '已解决', '待优化');

    UPDATE issue_activities
    SET detail = REPLACE(REPLACE(REPLACE(REPLACE(detail, '待验证', '待复测'), '已关闭', '不适用'), '已解决', '已修复'), '待优化', '不解决')
    WHERE kind = 'changed' AND action = '更新了状态'
      AND (detail LIKE '%待验证%' OR detail LIKE '%已关闭%' OR detail LIKE '%已解决%' OR detail LIKE '%待优化%');

    INSERT INTO issue_dictionary_sets(kind) VALUES ('status'), ('priority'), ('environment');
    INSERT INTO issue_dictionary_entries(kind, value, label, active, is_default, is_terminal, position) VALUES
      ('status', '待处理', '待处理', TRUE, TRUE, FALSE, 0),
      ('status', '处理中', '处理中', TRUE, FALSE, FALSE, 1),
      ('status', '待复测', '待复测', TRUE, FALSE, FALSE, 2),
      ('status', '已修复', '已修复', TRUE, FALSE, TRUE, 3),
      ('status', '不适用', '不适用', TRUE, FALSE, TRUE, 4),
      ('status', '不解决', '不解决', TRUE, FALSE, TRUE, 5),
      ('priority', 'P0', 'P0', TRUE, FALSE, FALSE, 0),
      ('priority', 'P1', 'P1', TRUE, TRUE, FALSE, 1),
      ('priority', 'P2', 'P2', TRUE, FALSE, FALSE, 2),
      ('priority', 'P3', 'P3', TRUE, FALSE, FALSE, 3),
      ('environment', '测试环境', '测试环境', TRUE, TRUE, FALSE, 0),
      ('environment', '正式环境', '正式环境', TRUE, FALSE, FALSE, 1),
      ('environment', '其他环境', '其他环境', TRUE, FALSE, FALSE, 2);

    -- Preserve historical values for display and filtering, without offering them on new issues.
    INSERT INTO issue_dictionary_entries(kind, value, label, active, is_default, is_terminal, position)
    SELECT history.kind, history.value, history.value, FALSE, FALSE, FALSE,
           (100 + ROW_NUMBER() OVER (PARTITION BY history.kind ORDER BY history.value))::integer
    FROM (
      SELECT 'status' AS kind, status AS value FROM issues
      UNION SELECT 'priority', priority FROM issues
      UNION SELECT 'environment', environment FROM issues
    ) history
    ON CONFLICT (kind, value) DO NOTHING;

    INSERT INTO app_migrations(name) VALUES ('issue-dictionaries-v1');
  END IF;
END $$;
`
