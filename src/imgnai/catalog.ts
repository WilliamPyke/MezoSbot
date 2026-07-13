import { config } from "../config.js";
import { supabase } from "../db.js";
import { musdToNumber, parseMusd } from "./musd.js";
import type { KatanaImageModel } from "./types.js";

type ApiModel = {
  public_model_name?: string;
  display_name?: string;
  creator?: string;
  description?: string;
  platform?: string;
  is_legacy?: boolean;
  supports_uhd?: boolean;
  supported_aspect_ratios?: unknown;
  x402_cost_usdc_readable?: string;
};

let memoryCache: KatanaImageModel[] = [];
let cacheLoadedAt = 0;
let refreshPromise: Promise<KatanaImageModel[]> | null = null;
let lastError: string | null = null;

function normalizeApiModel(raw: ApiModel): KatanaImageModel | null {
  const modelKey = String(raw.public_model_name ?? "").trim();
  let costMusdAtomic: bigint;
  try {
    costMusdAtomic = parseMusd(String(raw.x402_cost_usdc_readable ?? ""));
  } catch {
    return null;
  }
  const aspectRatios = Array.isArray(raw.supported_aspect_ratios)
    ? raw.supported_aspect_ratios.map(String).filter(Boolean)
    : [];
  if (!modelKey || costMusdAtomic <= 0n || aspectRatios.length === 0) return null;
  return {
    modelKey,
    displayName: String(raw.display_name ?? modelKey),
    creator: String(raw.creator ?? ""),
    description: String(raw.description ?? ""),
    platform: String(raw.platform ?? ""),
    isLegacy: raw.is_legacy === true,
    supportsUhd: raw.supports_uhd === true,
    aspectRatios,
    costMusdAtomic,
    fetchedAt: new Date().toISOString(),
  };
}

function fromDb(row: Record<string, unknown>): KatanaImageModel {
  return {
    modelKey: String(row.model_key),
    displayName: String(row.display_name),
    creator: String(row.creator ?? ""),
    description: String(row.description ?? ""),
    platform: String(row.platform),
    isLegacy: row.is_legacy === true,
    supportsUhd: row.supports_uhd === true,
    aspectRatios: Array.isArray(row.supported_aspect_ratios) ? row.supported_aspect_ratios.map(String) : [],
    costMusdAtomic: BigInt(String(row.cost_musd_atomic ?? parseMusd(String(row.cost_musd ?? "0")))),
    fetchedAt: String(row.fetched_at),
  };
}

async function loadDbCache(): Promise<KatanaImageModel[]> {
  const { data, error } = await supabase.from("imgnai_models").select("*").eq("platform", "sfw");
  if (error) throw error;
  return (data ?? []).map((row) => fromDb(row as Record<string, unknown>));
}

export async function refreshKatanaModels(force = false): Promise<KatanaImageModel[]> {
  if (!force && memoryCache.length > 0 && Date.now() - cacheLoadedAt < config.imgnai.modelCacheMs) {
    return memoryCache;
  }
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${config.imgnai.baseUrl}/v1/models`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`model catalog returned HTTP ${response.status}`);
      const body = await response.json() as { images?: ApiModel[] };
      const models = (body.images ?? []).map(normalizeApiModel).filter((m): m is KatanaImageModel => !!m);
      if (models.length === 0) throw new Error("model catalog contained no usable image models");

      const rows = models.map((model) => ({
        model_key: model.modelKey,
        display_name: model.displayName,
        creator: model.creator,
        description: model.description,
        platform: model.platform,
        is_legacy: model.isLegacy,
        supports_uhd: model.supportsUhd,
        supported_aspect_ratios: model.aspectRatios,
        cost_musd: musdToNumber(model.costMusdAtomic),
        cost_musd_atomic: model.costMusdAtomic.toString(),
        raw: {},
        fetched_at: model.fetchedAt,
        updated_at: model.fetchedAt,
      }));
      const { error } = await supabase.from("imgnai_models").upsert(rows, { onConflict: "model_key" });
      if (error) console.warn("[imgnAI] Could not persist model cache:", error.message);

      memoryCache = models.filter((model) => model.platform === "sfw");
      cacheLoadedAt = Date.now();
      lastError = null;
      return memoryCache;
    } catch (error) {
      lastError = (error as Error).message;
      console.warn("[imgnAI] Model refresh failed:", lastError);
      if (memoryCache.length > 0) return memoryCache;
      const fallback = await loadDbCache();
      if (fallback.length === 0) throw error;
      memoryCache = fallback;
      cacheLoadedAt = Date.now();
      return memoryCache;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export async function getGuildModels(guildId: string, force = false): Promise<KatanaImageModel[]> {
  const models = await refreshKatanaModels(force);
  const { data, error } = await supabase
    .from("guild_imgnai_disabled_models")
    .select("model_key")
    .eq("guild_id", guildId);
  if (error) throw error;
  const disabled = new Set((data ?? []).map((row) => String(row.model_key)));
  return models.filter((model) => !disabled.has(model.modelKey));
}

export async function getDisabledModelKeys(guildId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("guild_imgnai_disabled_models")
    .select("model_key")
    .eq("guild_id", guildId);
  if (error) throw error;
  return new Set((data ?? []).map((row) => String(row.model_key)));
}

export async function setGuildModelEnabled(
  guildId: string,
  modelKey: string,
  enabled: boolean,
  adminId: string,
): Promise<void> {
  if (enabled) {
    const { error } = await supabase
      .from("guild_imgnai_disabled_models")
      .delete()
      .eq("guild_id", guildId)
      .eq("model_key", modelKey);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from("guild_imgnai_disabled_models").upsert({
    guild_id: guildId,
    model_key: modelKey,
    disabled_by: adminId,
    disabled_at: new Date().toISOString(),
  }, { onConflict: "guild_id,model_key" });
  if (error) throw error;
}

export function getCatalogHealth(): { cachedModels: number; cacheAgeMs: number | null; lastError: string | null } {
  return {
    cachedModels: memoryCache.length,
    cacheAgeMs: cacheLoadedAt > 0 ? Date.now() - cacheLoadedAt : null,
    lastError,
  };
}
