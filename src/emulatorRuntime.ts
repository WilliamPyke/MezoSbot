import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required emulator env: ${key}`);
  return value;
}

function numberEnv(key: string, fallback: number): number {
  const value = Number(process.env[key] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

export const emulatorRuntime = {
  minBid: numberEnv("GB_MIN_BID", 0.001),
  roundMs: numberEnv("GB_ROUND_MS", 500),
  snapshotIntervalMs: numberEnv("GB_SNAPSHOT_INTERVAL_MS", 300_000),
};

export const emulatorSupabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});
