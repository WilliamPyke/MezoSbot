-- Store the quest announcement message so automatic rewards can refresh the
-- public completion count.

ALTER TABLE event_quests
  ADD COLUMN IF NOT EXISTS message_id TEXT;
