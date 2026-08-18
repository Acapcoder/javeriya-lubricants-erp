-- 002 — attachments, activity log, notifications
-- IMPLEMENTATION.md §4.10

CREATE TABLE attachments (
  id            bigserial PRIMARY KEY,
  original_name varchar(255) NOT NULL,
  stored_path   varchar(400) NOT NULL,
  mime_type     varchar(120),
  size_bytes    bigint,
  sha256        char(64),
  uploaded_by   bigint NOT NULL REFERENCES users(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activity_logs (
  id           bigserial PRIMARY KEY,
  user_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  -- denormalised so the trail survives user deletion
  user_name    varchar(120) NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  module       varchar(60) NOT NULL,
  action       varchar(30) NOT NULL,   -- CREATE|UPDATE|DELETE|LOGIN|LOGIN_FAILED|LOGOUT|
                                        -- EXPORT|LOCK|UNLOCK|RESTORE|RECOST|2FA_ENROLLED
  record_type  varchar(60),
  record_id    bigint,
  record_label varchar(160),
  old_values   jsonb,
  new_values   jsonb,
  ip_address   inet,
  user_agent   text
);
CREATE INDEX al_time_idx   ON activity_logs(occurred_at DESC);
CREATE INDEX al_record_idx ON activity_logs(record_type, record_id);
CREATE INDEX al_user_idx   ON activity_logs(user_id, occurred_at DESC);
CREATE INDEX al_module_idx ON activity_logs(module, occurred_at DESC);

CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  type       varchar(60) NOT NULL,
  severity   varchar(10) NOT NULL DEFAULT 'INFO',   -- INFO|WARN|SEVERE
  title      varchar(160) NOT NULL,
  body       text,
  link_url   varchar(255),
  dedupe_key varchar(160) UNIQUE,
  is_read    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notif_unread_idx ON notifications(is_read, created_at DESC);
