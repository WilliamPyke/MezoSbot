-- Runtime state for generic multistep quest tasks.

CREATE TABLE IF NOT EXISTS quest_task_attendance (
  quest_id BIGINT NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL REFERENCES quest_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ,
  accumulated_seconds INTEGER NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id, user_id)
);

CREATE TABLE IF NOT EXISTS quest_task_window_claims (
  task_id BIGINT NOT NULL REFERENCES quest_tasks(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  user_id TEXT NOT NULL,
  proof JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_quest_task_attendance_joined
  ON quest_task_attendance(task_id, joined_at)
  WHERE joined_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_quest_task_window_claims_user
  ON quest_task_window_claims(user_id, task_id);
