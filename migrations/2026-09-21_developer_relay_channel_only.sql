-- Allow channel-only routes while preserving existing private-thread routes.
ALTER TABLE developer_relay_routes
  ALTER COLUMN private_thread_id DROP NOT NULL;
