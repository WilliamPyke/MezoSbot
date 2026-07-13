import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type Message,
} from "discord.js";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { recordLedgerEntry } from "../ledger.js";
import { getTreasuryAddress } from "../evm.js";
import { ensureKatanaBalance, getKatanaWalletBalance, katanaWalletFetch, createSignInWithXHeader } from "./payments.js";
import { musdToNumber, parseMusd } from "./musd.js";
import { formatMusd, type GenerationJob, type GenerationQuality, type KatanaImageModel } from "./types.js";

const ACTIVE_STATUSES = ["reserved", "funding", "submitted", "polling", "delivery_pending", "refund_pending", "inconclusive"];
const processing = new Set<string>();
let workerTimer: NodeJS.Timeout | null = null;

type GenerationAsset = {
  original_data_url?: string;
  url?: string;
  width?: number;
  height?: number;
  expires_at?: string;
};

type GenerationEnvelope = {
  request_id?: string;
  status?: string;
  poll_after_seconds?: number;
  expires_at?: string;
  responses?: Array<{
    status?: string;
    output_assets?: GenerationAsset[];
    error?: { code?: string; message?: string; retryable?: boolean; details?: unknown };
  }>;
  error?: { code?: string; message?: string } | string;
};

export type ReserveGenerationParams = {
  discordId: string;
  guildId: string;
  channelId: string;
  prompt: string;
  model: KatanaImageModel;
  aspectRatio: string;
  quality: GenerationQuality;
  amountMusdAtomic: bigint;
};

function quotedAtomic(job: GenerationJob): bigint {
  return job.quoted_musd_atomic != null
    ? BigInt(job.quoted_musd_atomic)
    : parseMusd(String(job.quoted_musd));
}

function jobFrom(data: unknown): GenerationJob {
  return data as GenerationJob;
}

async function patchJob(jobId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from("imgnai_generation_jobs").update({
    ...patch,
    updated_at: new Date().toISOString(),
  }).eq("id", jobId);
  if (error) throw error;
}

export async function reserveGeneration(params: ReserveGenerationParams): Promise<string | null> {
  const jobId = randomUUID();
  const promptHash = createHash("sha256").update(params.prompt).digest("hex");
  const { data, error } = await supabase.rpc("reserve_imgnai_generation", {
    p_job_id: jobId,
    p_discord_id: params.discordId,
    p_guild_id: params.guildId,
    p_channel_id: params.channelId,
    p_prompt: params.prompt,
    p_prompt_hash: promptHash,
    p_model_key: params.model.modelKey,
    p_model_display_name: params.model.displayName,
    p_aspect_ratio: params.aspectRatio,
    p_quality: params.quality,
    p_amount_atomic: params.amountMusdAtomic.toString(),
  });
  if (error) throw error;
  return data === true ? jobId : null;
}

export async function setGenerationStatusMessage(jobId: string, messageId: string): Promise<void> {
  await patchJob(jobId, { status_message_id: messageId });
}

export async function releaseReservedGeneration(jobId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc("refund_imgnai_generation", { p_job_id: jobId, p_reason: reason });
  if (error) throw error;
}

async function getJob(jobId: string): Promise<GenerationJob | null> {
  const { data, error } = await supabase.from("imgnai_generation_jobs").select("*").eq("id", jobId).maybeSingle();
  if (error) throw error;
  return data ? jobFrom(data) : null;
}

async function refundUnpaidJob(client: Client, job: GenerationJob, reason: string): Promise<void> {
  await patchJob(job.id, { status: "failed_unpaid", error_message: reason });
  const { data, error } = await supabase.rpc("refund_imgnai_generation", { p_job_id: job.id, p_reason: reason });
  if (error) throw error;
  if (data === true) {
    recordLedgerEntry(client, {
      type: "image_generation_refund",
      amountSats: musdToNumber(quotedAtomic(job)),
      token: "MUSD",
      senderId: "platform",
      receiverId: job.discord_id,
      guildId: job.guild_id,
      referenceType: "imgnai_generation_jobs",
      referenceId: job.id,
      metadata: { reason, prompt_hash: job.prompt_hash, amount_musd_atomic: quotedAtomic(job).toString() },
    });
  }
  await editFailureMessage(client, job, reason, true);
}

function parseSettlementTx(response: Response): string | null {
  const encoded = response.headers.get("PAYMENT-RESPONSE");
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
    return String(parsed.transaction ?? parsed.transactionHash ?? parsed.txHash ?? "") || null;
  } catch {
    return null;
  }
}

async function submitJob(client: Client, job: GenerationJob): Promise<void> {
  if (!job.prompt) return refundUnpaidJob(client, job, "Prompt was unavailable before submission.");
  await patchJob(job.id, { status: "funding", error_code: null, error_message: null });
  let balanceBeforeSubmission: bigint | null = null;
  try {
    balanceBeforeSubmission = await ensureKatanaBalance(quotedAtomic(job));
    const body = {
      requests: [{
        type: "image",
        model: job.model_key,
        prompt: job.prompt,
        aspect_ratio: job.aspect_ratio,
        output_format: "png",
        ...(job.quality === "uhd" ? { is_uhd: true } : {}),
      }],
    };
    const response = await katanaWalletFetch(`${config.imgnai.baseUrl}/v1/generation-requests?wait=false`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const envelope = await response.json().catch(() => ({})) as GenerationEnvelope;
    if (!response.ok || !envelope.request_id) {
      const detail = typeof envelope.error === "string"
        ? envelope.error
        : envelope.error?.message ?? `Katana submission returned HTTP ${response.status}`;
      if (response.status === 402 || (response.status >= 400 && response.status < 500)) {
        return refundUnpaidJob(client, job, detail);
      }
      await patchJob(job.id, {
        status: "inconclusive",
        error_code: "submission_inconclusive",
        error_message: detail,
        next_retry_at: new Date(Date.now() + 60_000).toISOString(),
      });
      await editFailureMessage(client, job, "Submission could not be confirmed. Funds remain reserved while the payment is reconciled.", false);
      return;
    }
    const now = new Date().toISOString();
    await patchJob(job.id, {
      status: "polling",
      katana_request_id: envelope.request_id,
      settlement_tx: parseSettlementTx(response),
      paid_at: now,
      next_retry_at: new Date(Date.now() + Math.max(1, envelope.poll_after_seconds ?? 3) * 1000).toISOString(),
    });
    recordLedgerEntry(client, {
      type: "image_generation",
      amountSats: musdToNumber(quotedAtomic(job)),
      token: "MUSD",
      senderId: job.discord_id,
      receiverId: "platform",
      guildId: job.guild_id,
      referenceType: "imgnai_generation_jobs",
      referenceId: job.id,
      metadata: { model: job.model_key, prompt_hash: job.prompt_hash, amount_musd_atomic: quotedAtomic(job).toString() },
    });
  } catch (error) {
    if (balanceBeforeSubmission != null) {
      const currentBalance = await getKatanaWalletBalance().catch(() => null);
      if (currentBalance != null && currentBalance >= balanceBeforeSubmission) {
        await refundUnpaidJob(client, job, (error as Error).message);
        return;
      }
    }
    await patchJob(job.id, {
      status: "inconclusive",
      error_code: "submission_inconclusive",
      error_message: (error as Error).message,
      next_retry_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    await editFailureMessage(client, job, "Submission could not be confirmed. Funds remain reserved while the payment is reconciled.", false);
  }
}

function responseError(envelope: GenerationEnvelope): { code: string; message: string; policy: boolean } {
  const item = envelope.responses?.find((response) => response.error)?.error;
  const top = typeof envelope.error === "object" ? envelope.error : null;
  const code = String(item?.code ?? top?.code ?? "generation_failed");
  const message = String(item?.message ?? top?.message ?? envelope.error ?? "Generation failed.");
  const normalized = `${code} ${message}`.toLowerCase();
  return { code, message, policy: /policy|terms|moderation|prohibited|copyright/.test(normalized) };
}

async function pollJob(client: Client, job: GenerationJob): Promise<void> {
  if (!job.katana_request_id) return refundUnpaidJob(client, job, "Katana request ID was missing.");
  const elapsed = Date.now() - new Date(job.paid_at ?? job.updated_at).getTime();
  try {
    const response = await fetch(`${config.imgnai.baseUrl}/v1/generation-requests/${job.katana_request_id}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const envelope = await response.json().catch(() => ({})) as GenerationEnvelope;
    if (!response.ok) throw new Error(`Katana polling returned HTTP ${response.status}`);
    const status = String(envelope.status ?? "");
    if (status === "completed" || status === "partial_failure") {
      const asset = envelope.responses?.flatMap((item) => item.output_assets ?? [])[0];
      const outputUrl = asset?.original_data_url || asset?.url;
      if (outputUrl) {
        await patchJob(job.id, {
          status: "delivery_pending",
          output_url: outputUrl,
          output_expires_at: asset?.expires_at ?? envelope.expires_at ?? null,
          output_width: asset?.width ?? null,
          output_height: asset?.height ?? null,
          next_retry_at: new Date().toISOString(),
        });
        return;
      }
    }
    if (["failed", "rejected", "partial_failure"].includes(status)) {
      const failure = responseError(envelope);
      await patchJob(job.id, {
        status: failure.policy ? "policy_failed" : "refund_pending",
        error_code: failure.code,
        error_message: failure.message,
        next_retry_at: failure.policy ? null : new Date(Date.now() + 30_000).toISOString(),
      });
      await editFailureMessage(client, job, failure.message, false);
      return;
    }
    if (elapsed >= config.imgnai.imageTimeoutMs) {
      await patchJob(job.id, {
        status: "inconclusive",
        error_code: "local_timeout",
        error_message: "Generation is taking longer than expected; recovery will continue in the background.",
        next_retry_at: new Date(Date.now() + 60_000).toISOString(),
      });
      return;
    }
    await patchJob(job.id, {
      status: "polling",
      next_retry_at: new Date(Date.now() + Math.max(1, envelope.poll_after_seconds ?? 3) * 1000).toISOString(),
    });
  } catch (error) {
    await patchJob(job.id, {
      status: elapsed >= config.imgnai.imageTimeoutMs ? "inconclusive" : "polling",
      error_message: (error as Error).message,
      next_retry_at: new Date(Date.now() + 30_000).toISOString(),
    });
  }
}

async function findStatusMessage(client: Client, job: GenerationJob): Promise<Message | null> {
  const channel = await client.channels.fetch(job.channel_id).catch(() => null);
  if (!channel?.isTextBased() || !job.status_message_id || !("messages" in channel)) return null;
  return channel.messages.fetch(job.status_message_id).catch(() => null);
}

function resultEmbed(job: GenerationJob, remoteImage: boolean): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xf271b6)
    .setTitle("Image generated")
    .setDescription((job.prompt ?? "Prompt no longer retained.").slice(0, 4096))
    .addFields(
      { name: "Model", value: job.model_display_name, inline: true },
      { name: "Aspect ratio", value: job.aspect_ratio, inline: true },
      { name: "Quality", value: job.quality === "uhd" ? "UHD" : "Standard", inline: true },
      { name: "Charged", value: formatMusd(quotedAtomic(job)), inline: true },
      { name: "Generated by", value: `<@${job.discord_id}>`, inline: true },
    )
    .setFooter({ text: "Powered by imgnAI", iconURL: "attachment://imgnai-logo.png" })
    .setTimestamp();
  if (job.output_width && job.output_height) {
    embed.addFields({ name: "Dimensions", value: `${job.output_width} × ${job.output_height}`, inline: true });
  }
  embed.setImage(remoteImage ? job.output_url! : "attachment://generated.png");
  return embed;
}

async function deliverJob(client: Client, job: GenerationJob): Promise<void> {
  if (!job.output_url) throw new Error("Generation output URL is missing");
  let message = await findStatusMessage(client, job);
  if (!message) {
    const channel = await client.channels.fetch(job.channel_id).catch(() => null);
    if (!channel?.isSendable()) throw new Error("Generation channel is unavailable");
    const sent = await channel.send({ content: `Generation result for <@${job.discord_id}>` });
    message = sent;
    await patchJob(job.id, { status_message_id: sent.id });
  }
  if (!message) throw new Error("Generation status message is unavailable");

  const logo = new AttachmentBuilder(path.join(process.cwd(), "src", "assets", "imgnai-logo.png"), { name: "imgnai-logo.png" });
  let imageBuffer: Buffer | null = null;
  try {
    const response = await fetch(job.output_url, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`asset download returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length <= 24 * 1024 * 1024) imageBuffer = bytes;
  } catch (error) {
    console.warn(`[imgnAI] Could not download output for ${job.id}:`, (error as Error).message);
  }

  const remoteImage = imageBuffer === null;
  const embed = resultEmbed(job, remoteImage);
  const files = imageBuffer
    ? [new AttachmentBuilder(imageBuffer, { name: "generated.png" }), logo]
    : [logo];
  const edited = await message.edit({ content: "", embeds: [embed], components: [], attachments: [], files });
  const uploaded = edited.attachments.find((attachment) => attachment.name === "generated.png");
  const downloadUrl = uploaded?.url ?? job.output_url;
  const download = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Download").setURL(downloadUrl),
  );
  await edited.edit({ components: [download] });
  const { error } = await supabase.rpc("complete_imgnai_generation", {
    p_job_id: job.id,
    p_final_musd_atomic: quotedAtomic(job).toString(),
  });
  if (error) throw error;
}

async function editFailureMessage(client: Client, job: GenerationJob, reason: string, refunded: boolean): Promise<void> {
  const message = await findStatusMessage(client, job);
  if (!message) return;
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("Image generation failed")
    .setDescription(reason.slice(0, 4096))
    .addFields({
      name: "Payment",
      value: refunded
        ? `${formatMusd(quotedAtomic(job))} was returned to your balance.`
        : "The payment is being reconciled with imgnAI. Refundable failures are returned automatically.",
    })
    .setFooter({ text: "Powered by imgnAI", iconURL: "attachment://imgnai-logo.png" });
  const logo = new AttachmentBuilder(path.join(process.cwd(), "src", "assets", "imgnai-logo.png"), { name: "imgnai-logo.png" });
  await message.edit({
    content: `<@${job.discord_id}>`,
    embeds: [embed],
    components: [],
    attachments: [],
    files: [logo],
    allowedMentions: { users: [job.discord_id] },
  }).catch(() => {});
}

async function reconcileRefund(client: Client, job: GenerationJob): Promise<void> {
  if (!job.katana_request_id) return refundUnpaidJob(client, job, job.error_message ?? "Generation failed.");
  try {
    const proof = await createSignInWithXHeader();
    const response = await fetch(`${config.imgnai.baseUrl}/v1/x402/transactions/${getTreasuryAddress()}`, {
      headers: { "X-Sign-In-With-X": proof, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`refund history returned HTTP ${response.status}`);
    const body = await response.json();
    if (!containsRefundForRequest(body, job.katana_request_id)) {
      await patchJob(job.id, { next_retry_at: new Date(Date.now() + 60_000).toISOString() });
      return;
    }
    const { data, error } = await supabase.rpc("refund_imgnai_generation", {
      p_job_id: job.id,
      p_reason: job.error_message ?? "Katana confirmed the generation refund.",
    });
    if (error) throw error;
    if (data === true) {
      recordLedgerEntry(client, {
        type: "image_generation_refund",
        amountSats: musdToNumber(quotedAtomic(job)),
        token: "MUSD",
        senderId: "platform",
        receiverId: job.discord_id,
        guildId: job.guild_id,
        referenceType: "imgnai_generation_jobs",
        referenceId: job.id,
        metadata: { prompt_hash: job.prompt_hash, amount_musd_atomic: quotedAtomic(job).toString() },
      });
      await editFailureMessage(client, job, job.error_message ?? "Generation failed.", true);
    }
  } catch (error) {
    await patchJob(job.id, {
      error_message: job.error_message ?? (error as Error).message,
      next_retry_at: new Date(Date.now() + 60_000).toISOString(),
    });
  }
}

function containsRefundForRequest(value: unknown, requestId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsRefundForRequest(item, requestId));
  if (!value || typeof value !== "object") return false;
  const serialized = JSON.stringify(value).toLowerCase();
  if (serialized.includes(requestId.toLowerCase()) && /refund|credited|reversed/.test(serialized)) return true;
  return Object.values(value as Record<string, unknown>).some((item) => containsRefundForRequest(item, requestId));
}

async function processJob(client: Client, jobId: string): Promise<void> {
  if (processing.has(jobId)) return;
  processing.add(jobId);
  try {
    const job = await getJob(jobId);
    if (!job) return;
    if (job.status === "reserved" || job.status === "funding") await submitJob(client, job);
    else if (["submitted", "polling"].includes(job.status) || (job.status === "inconclusive" && job.katana_request_id)) await pollJob(client, job);
    else if (job.status === "inconclusive") {
      await patchJob(job.id, { next_retry_at: new Date(Date.now() + 60 * 60_000).toISOString() });
    }
    else if (job.status === "delivery_pending") {
      try {
        await deliverJob(client, job);
      } catch (error) {
        await patchJob(job.id, {
          delivery_attempts: job.delivery_attempts + 1,
          error_message: (error as Error).message,
          next_retry_at: new Date(Date.now() + 30_000).toISOString(),
        });
      }
    } else if (job.status === "refund_pending") await reconcileRefund(client, job);
  } finally {
    processing.delete(jobId);
  }
}

async function workerTick(client: Client): Promise<void> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("imgnai_generation_jobs")
    .select("id")
    .in("status", ACTIVE_STATUSES)
    .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) {
    console.warn("[imgnAI] Worker query failed:", error.message);
    return;
  }
  await Promise.all((data ?? []).map((row) => processJob(client, String(row.id))));

  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  await supabase.from("imgnai_generation_jobs")
    .update({ prompt: null, updated_at: now })
    .in("status", ["completed", "refunded", "policy_failed"])
    .lt("updated_at", cutoff)
    .not("prompt", "is", null);
}

export function startImgnaiWorker(client: Client): void {
  if (workerTimer) return;
  void workerTick(client);
  workerTimer = setInterval(() => void workerTick(client), 5_000);
}

export function queueGeneration(client: Client, jobId: string): void {
  void processJob(client, jobId);
}
