import { supabase } from "./db.js";

export type RainBannedTermRow = {
  id: number;
  guild_id: string;
  term: string;
  created_by: string | null;
  created_at: string;
};

export function normalizeRainBannedTerm(term: string): string {
  return term.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function getRainBannedTerms(guildId: string): Promise<RainBannedTermRow[]> {
  const { data, error } = await supabase
    .from("rain_banned_terms")
    .select("*")
    .eq("guild_id", guildId)
    .order("term", { ascending: true });

  if (error) throw error;
  return (data ?? []) as RainBannedTermRow[];
}

export async function addRainBannedTerm(guildId: string, term: string, createdBy: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const normalized = normalizeRainBannedTerm(term);
  if (!normalized) return { ok: false, error: "Enter a word, letter, or phrase to ban." };
  if (normalized.length > 100) return { ok: false, error: "Banned terms must be 100 characters or fewer." };

  const { error } = await supabase
    .from("rain_banned_terms")
    .upsert(
      { guild_id: guildId, term: normalized, created_by: createdBy },
      { onConflict: "guild_id,term", ignoreDuplicates: true },
    );

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function removeRainBannedTerm(guildId: string, term: string): Promise<{ ok: true; removed: number } | { ok: false; error: string }> {
  const normalized = normalizeRainBannedTerm(term);
  if (!normalized) return { ok: false, error: "Enter a word, letter, or phrase to remove." };

  const { data, error } = await supabase
    .from("rain_banned_terms")
    .delete()
    .eq("guild_id", guildId)
    .eq("term", normalized)
    .select("id");

  if (error) return { ok: false, error: error.message };
  return { ok: true, removed: data?.length ?? 0 };
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[\p{L}\p{N}_'’\u2010-\u2015-]/u.test(char);
}

export function messageMatchesRainTerm(content: string, term: string): boolean {
  const normalizedContent = normalizeRainBannedTerm(content);
  const normalizedTerm = normalizeRainBannedTerm(term);
  if (!normalizedContent || !normalizedTerm) return false;

  let fromIndex = 0;
  while (fromIndex <= normalizedContent.length) {
    const index = normalizedContent.indexOf(normalizedTerm, fromIndex);
    if (index === -1) return false;

    const before = normalizedContent[index - 1];
    const after = normalizedContent[index + normalizedTerm.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;

    fromIndex = index + Math.max(1, normalizedTerm.length);
  }
  return false;
}

export function messageMatchesAnyRainTerm(content: string, terms: string[]): boolean {
  return terms.some((term) => messageMatchesRainTerm(content, term));
}

export function messageMatchesRainBan(content: string, terms: RainBannedTermRow[]): boolean {
  if (!content || terms.length === 0) return false;
  return terms.some((row) => messageMatchesRainTerm(content, row.term));
}
