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
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS dingtalk_corp_id VARCHAR(128);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS dingtalk_user_id VARCHAR(128);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS dingtalk_union_id VARCHAR(128);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS dingtalk_bound_at TIMESTAMPTZ;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS dingtalk_binding_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS dingtalk_sync_status VARCHAR(24) NOT NULL DEFAULT 'unmatched';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS dingtalk_binding_source VARCHAR(24);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS dingtalk_last_synced_at TIMESTAMPTZ;
UPDATE app_users SET dingtalk_binding_source = 'manual'
WHERE dingtalk_user_id IS NOT NULL AND dingtalk_binding_source IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_display_name_lower_idx ON app_users (LOWER(display_name));
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_idx ON app_users (LOWER(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_dingtalk_identity_idx
  ON app_users (dingtalk_corp_id, dingtalk_user_id)
  WHERE dingtalk_corp_id IS NOT NULL AND dingtalk_user_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_users_dingtalk_identity_pair_check') THEN
    ALTER TABLE app_users ADD CONSTRAINT app_users_dingtalk_identity_pair_check
      CHECK ((dingtalk_corp_id IS NULL) = (dingtalk_user_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_users_dingtalk_sync_status_check') THEN
    ALTER TABLE app_users ADD CONSTRAINT app_users_dingtalk_sync_status_check
      CHECK (dingtalk_sync_status IN ('matched', 'unmatched', 'conflict', 'disabled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_users_dingtalk_binding_source_check') THEN
    ALTER TABLE app_users ADD CONSTRAINT app_users_dingtalk_binding_source_check
      CHECK (dingtalk_binding_source IS NULL OR dingtalk_binding_source IN ('manual', 'email_sync', 'self_service'));
  END IF;
END $$;

-- Login identities require proof of both accounts and are independent of email notification matching.
CREATE TABLE IF NOT EXISTS dingtalk_login_identities (
  id UUID PRIMARY KEY,
  app_user_id UUID NOT NULL UNIQUE REFERENCES app_users(id) ON DELETE CASCADE,
  corp_id VARCHAR(128) NOT NULL,
  dingtalk_user_id VARCHAR(128) NOT NULL,
  union_id VARCHAR(128) NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (corp_id, dingtalk_user_id),
  UNIQUE (corp_id, union_id)
);

CREATE TABLE IF NOT EXISTS dingtalk_login_flows (
  id UUID PRIMARY KEY,
  state_hash CHAR(64) NOT NULL UNIQUE,
  browser_hash CHAR(64) NOT NULL UNIQUE,
  return_to TEXT NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'exchanging', 'ready')),
  identity JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dingtalk_login_flows_expiry_idx ON dingtalk_login_flows (expires_at);

CREATE TABLE IF NOT EXISTS app_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON app_sessions(user_id);
CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx ON app_sessions(expires_at);

CREATE TABLE IF NOT EXISTS dingtalk_binding_audit (
  id UUID PRIMARY KEY,
  app_user_id UUID NOT NULL REFERENCES app_users(id),
  actor_user_id UUID NOT NULL REFERENCES app_users(id),
  action VARCHAR(16) NOT NULL CHECK (action IN ('bound', 'unbound')),
  dingtalk_corp_id VARCHAR(128),
  dingtalk_user_id VARCHAR(128),
  source VARCHAR(24) NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE dingtalk_binding_audit ADD COLUMN IF NOT EXISTS source VARCHAR(24) NOT NULL DEFAULT 'manual';

CREATE INDEX IF NOT EXISTS dingtalk_binding_audit_user_idx
  ON dingtalk_binding_audit (app_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dingtalk_sync_runs (
  id UUID PRIMARY KEY,
  initiated_by UUID NOT NULL REFERENCES app_users(id),
  status VARCHAR(16) NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  departments_scanned INTEGER NOT NULL DEFAULT 0,
  directory_users INTEGER NOT NULL DEFAULT 0,
  directory_users_with_email INTEGER NOT NULL DEFAULT 0,
  app_users INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unmatched INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  manual_kept INTEGER NOT NULL DEFAULT 0,
  error_code VARCHAR(80),
  error_message VARCHAR(500),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dingtalk_sync_runs_started_idx
  ON dingtalk_sync_runs (started_at DESC);

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

CREATE TABLE IF NOT EXISTS notification_rule_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  rules JSONB NOT NULL CHECK (jsonb_typeof(rules) = 'array'),
  updated_by UUID REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO notification_rule_settings (id, rules) VALUES (1,
  '[{"id":"00000000-0000-4000-8000-000000000001","name":"新建缺陷通知负责人","enabled":true,"trigger":"created","targetStatus":null,"recipients":["assignee"]}]'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS notification_outbox (
  id UUID PRIMARY KEY,
  event_type VARCHAR(40) NOT NULL,
  event_key TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  issue_key VARCHAR(40) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'provider_succeeded', 'partial', 'attention_required', 'skipped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_aggregate_id_fkey;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS event_key TEXT;
UPDATE notification_outbox SET event_key = CASE
  WHEN event_type = 'issue.created' THEN event_type || ':' || aggregate_id::text
  ELSE event_type || ':' || id::text END WHERE event_key IS NULL;
ALTER TABLE notification_outbox ALTER COLUMN event_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_event_key_idx ON notification_outbox(event_key);
ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_event_type_aggregate_id_key;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id UUID PRIMARY KEY,
  outbox_id UUID NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  app_user_id UUID NOT NULL REFERENCES app_users(id),
  recipient_roles TEXT[] NOT NULL DEFAULT ARRAY['assignee']::text[],
  dingtalk_corp_id VARCHAR(128),
  dingtalk_user_id VARCHAR(128),
  dingtalk_binding_version INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'provider_accepted', 'provider_succeeded', 'retryable', 'unknown', 'failed_permanent', 'dead_letter', 'skipped_unmapped', 'skipped_stale')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner VARCHAR(128),
  lease_until TIMESTAMPTZ,
  last_error_code VARCHAR(80),
  last_error_message VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (outbox_id, app_user_id)
);
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS recipient_roles TEXT[] NOT NULL DEFAULT ARRAY['assignee']::text[];
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_recipient_roles_check') THEN
    ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_recipient_roles_check
      CHECK (cardinality(recipient_roles) > 0 AND recipient_roles <@ ARRAY['assignee', 'reporter']::text[]);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS notification_deliveries_work_idx
  ON notification_deliveries (status, next_attempt_at, lease_until);

CREATE TABLE IF NOT EXISTS notification_attempts (
  id UUID PRIMARY KEY,
  outbox_id UUID NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  delivery_ids UUID[] NOT NULL,
  recipient_user_ids TEXT[] NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  provider_task_id VARCHAR(128),
  state VARCHAR(32) NOT NULL
    CHECK (state IN ('prepared', 'in_flight', 'provider_accepted', 'completed', 'unknown')),
  outcome VARCHAR(48),
  http_status INTEGER,
  provider_error_code VARCHAR(80),
  response_summary JSONB,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ,
  check_count INTEGER NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notification_attempts_work_idx
  ON notification_attempts (state, next_check_at, lease_until);

UPDATE issue_activities
SET action = REPLACE(action, '指定人员', '负责人'),
    detail = REPLACE(detail, '指定人员', '负责人')
WHERE action LIKE '%指定人员%' OR detail LIKE '%指定人员%';

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

-- Dictionary weights and personal visibility are initialized once from the configured order.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(739245108);
  IF NOT EXISTS (SELECT 1 FROM app_migrations WHERE name = 'issue-dictionary-weights-v1') THEN
    ALTER TABLE issue_dictionary_entries ADD COLUMN IF NOT EXISTS weight INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE issue_dictionary_entries ADD COLUMN IF NOT EXISTS show_in_personal BOOLEAN NOT NULL DEFAULT FALSE;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'issue_dictionary_entries'::regclass AND conname = 'issue_dictionary_weight_check') THEN
      ALTER TABLE issue_dictionary_entries ADD CONSTRAINT issue_dictionary_weight_check CHECK (weight BETWEEN 0 AND 999999);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'issue_dictionary_entries'::regclass AND conname = 'issue_dictionary_personal_status_check') THEN
      ALTER TABLE issue_dictionary_entries ADD CONSTRAINT issue_dictionary_personal_status_check CHECK (NOT show_in_personal OR kind = 'status');
    END IF;

    WITH ordered AS (
      SELECT kind, value,
             COUNT(*) OVER (PARTITION BY kind) - ROW_NUMBER() OVER (PARTITION BY kind ORDER BY position, value) AS reverse_rank
      FROM issue_dictionary_entries
    )
    UPDATE issue_dictionary_entries e
    SET weight = LEAST(999999, ordered.reverse_rank * 10)::integer,
        show_in_personal = e.kind = 'status' AND NOT e.is_terminal
    FROM ordered
    WHERE e.kind = ordered.kind AND e.value = ordered.value;

    -- Advance optimistic versions so forms opened before migration cannot silently save stale data.
    UPDATE issue_dictionary_sets SET version = version + 1, updated_at = NOW();
    INSERT INTO app_migrations(name) VALUES ('issue-dictionary-weights-v1');
  END IF;
END $$;
`
