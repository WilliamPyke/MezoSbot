import { formatMusd as formatAtomicMusd } from "./musd.js";

export type KatanaImageModel = {
  modelKey: string;
  displayName: string;
  creator: string;
  description: string;
  platform: string;
  isLegacy: boolean;
  supportsUhd: boolean;
  aspectRatios: string[];
  costMusdAtomic: bigint;
  fetchedAt: string;
};

export type GenerationQuality = "standard" | "uhd";

export type GenerationJobStatus =
  | "reserved"
  | "funding"
  | "submitted"
  | "polling"
  | "delivery_pending"
  | "completed"
  | "failed_unpaid"
  | "refund_pending"
  | "refunded"
  | "policy_failed"
  | "inconclusive";

export type GenerationJob = {
  id: string;
  discord_id: string;
  guild_id: string;
  channel_id: string;
  status_message_id: string | null;
  prompt: string | null;
  prompt_hash: string;
  model_key: string;
  model_display_name: string;
  aspect_ratio: string;
  quality: GenerationQuality;
  quoted_musd: number;
  quoted_musd_atomic: string | null;
  final_musd: number | null;
  final_musd_atomic: string | null;
  status: GenerationJobStatus;
  katana_request_id: string | null;
  settlement_tx: string | null;
  output_url: string | null;
  output_expires_at: string | null;
  output_width: number | null;
  output_height: number | null;
  error_code: string | null;
  error_message: string | null;
  delivery_attempts: number;
  next_retry_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
};

export function generationCost(model: KatanaImageModel, quality: GenerationQuality): bigint {
  return model.costMusdAtomic * (quality === "uhd" ? 2n : 1n);
}

export const formatMusd = formatAtomicMusd;

export function modelsForPage(models: KatanaImageModel[], page: "current" | "legacy"): KatanaImageModel[] {
  return models.filter((model) => model.isLegacy === (page === "legacy"));
}

export function generationPriceChanged(previous: bigint, current: bigint): boolean {
  return previous !== current;
}
