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
  status VARCHAR(16) NOT NULL CHECK (status IN ('待处理', '处理中', '待复测', '已修复', '不适用', '不解决')),
  priority CHAR(2) NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
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

UPDATE issue_activities
SET action = REPLACE(action, '指定人员', '负责人'),
    detail = REPLACE(detail, '指定人员', '负责人')
WHERE action LIKE '%指定人员%' OR detail LIKE '%指定人员%';

ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_check;
UPDATE issues
SET status = CASE status
  WHEN '待验证' THEN '待复测'
  WHEN '已关闭' THEN '不适用'
  WHEN '已解决' THEN '已修复'
  WHEN '待优化' THEN '不解决'
  ELSE status
END
WHERE status IN ('待验证', '已关闭', '已解决', '待优化');
ALTER TABLE issues ADD CONSTRAINT issues_status_check
  CHECK (status IN ('待处理', '处理中', '待复测', '已修复', '不适用', '不解决'));

UPDATE issue_activities
SET detail = REPLACE(REPLACE(REPLACE(REPLACE(detail, '待验证', '待复测'), '已关闭', '不适用'), '已解决', '已修复'), '待优化', '不解决')
WHERE kind = 'changed' AND action = '更新了状态'
  AND (detail LIKE '%待验证%' OR detail LIKE '%已关闭%' OR detail LIKE '%已解决%' OR detail LIKE '%待优化%');
`
