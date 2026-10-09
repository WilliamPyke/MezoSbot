import { supabase } from "../db.js";

/**
 * Durable custody bookkeeping: log-scanner and watchdog cursors
 * (custody_cursors) and the custody freeze flag (bot_settings).
 */

export const CUSTODY_FROZEN_SETTING = "custody_frozen";

export async function readCursor(name: string): Promise<string | null> {
  const { data, error } = await supabase.from("custody_cursors").select("value").eq("name", name).maybeSingle();
  if (error) throw new Error(`custody cursor ${name}: ${error.message}`);
  return (data?.value as string | undefined) ?? null;
}

export async function writeCursor(name: string, value: string | number): Promise<void> {
  const { error } = await supabase
    .from("custody_cursors")
    .upsert({ name, value: String(value), updated_at: new Date().toISOString() }, { onConflict: "name" });
  if (error) throw new Error(`custody cursor ${name}: ${error.message}`);
}

export async function readNumberCursor(name: string): Promise<number | null> {
  const raw = await readCursor(name);
  if (raw == null) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < -1) throw new Error(`custody cursor ${name} holds ${raw}`);
  return value;
}

/** `keys` name the anomalies seen while frozen; /custody unfreeze acknowledges them. */
export type PersistedFreeze = { reason: string; at: string; keys?: string[] };

/** undefined = no flag; throws when the flag cannot be read. */
export async function readFreezeFlag(): Promise<PersistedFreeze | undefined> {
  const { data, error } = await supabase.from("bot_settings").select("value").eq("key", CUSTODY_FROZEN_SETTING).maybeSingle();
  if (error) throw new Error(`custody freeze flag: ${error.message}`);
  if (!data?.value) return undefined;
  try {
    const parsed = JSON.parse(String(data.value)) as Partial<PersistedFreeze>;
    const keys = Array.isArray(parsed.keys) ? parsed.keys.map(String) : [];
    return { reason: String(parsed.reason ?? "unknown"), at: String(parsed.at ?? ""), keys };
  } catch {
    return { reason: String(data.value), at: "" };
  }
}

export async function writeFreezeFlag(flag: PersistedFreeze): Promise<void> {
  const { error } = await supabase
    .from("bot_settings")
    .upsert({ key: CUSTODY_FROZEN_SETTING, value: JSON.stringify(flag), updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(`custody freeze flag: ${error.message}`);
}

export async function deleteFreezeFlag(): Promise<void> {
  const { error } = await supabase.from("bot_settings").delete().eq("key", CUSTODY_FROZEN_SETTING);
  if (error) throw new Error(`custody freeze flag: ${error.message}`);
}
