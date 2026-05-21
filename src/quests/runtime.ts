import {
  ChannelType,
  EmbedBuilder,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
  type Client,
  type GuildScheduledEvent,
  type Message,
  type VoiceBasedChannel,
  type VoiceState,
} from "discord.js";
import { config as appConfig } from "../config.js";
import { recordLedgerEntry } from "../ledger.js";
import { supabase } from "../db.js";
import { formatSats } from "../format.js";
import { registerDepositAddress } from "../evm.js";
import { sendTransferReceivedDm } from "../notifications.js";
import {
  completeQuestTask,
  getActiveTasksByType,
  getAllActiveTasksByType,
  getQuestSnapshot,
  getQuestTaskDefinition,
  payRepeatableQuestTaskReward,
  type ActiveQuestTask,
  type QuestCompletionResult,
} from "./engine.js";

const SWEEP_MS = 60_000;
const EMBED_REFETCH_DELAY_MS = 1_500;
const initializedQuestIds = new Set<number>();

type EventAttendanceConfig = {
  scheduledEventId?: string;
  eventChannelId: string;
  minMinutes: number;
};

type FirstLinkConfig = {
  targetChannelId: string;
  source: string;
  refreshMinutes: number;
  // Rotating-list mode (current).
  linkList?: string[];
  // Quantized window-boundary timestamp (ms) when the rotation should begin
  // at index 0. Anchoring lets the quest start at link 1 of N regardless of
  // wall-clock phase. Aligned to refreshMinutes window so rotation transitions
  // line up with window-claim boundaries.
  rotationStartMs?: number;
  // Legacy single-event mode: treated as a 1-item rotation.
  expectedEventId?: string;
  expectedEventUrl?: string;
};

type FirstLinkClaimMetadata = {
  taskId?: number;
  windowStart?: string;
  userId?: string;
  linkIndex?: number;
  claimedAt?: string;
  winnerMessageId?: string;
  matchedUrl?: string;
};

type CollectedMessageUrls = {
  posterUrls: string[];
  expandedUrls: string[];
  allUrls: string[];
};

const LINK_QUEST_OPEN_COLOR = 0xed4245;
const LINK_QUEST_CLAIMED_COLOR = 0x57f287;

export function resolveLinkList(config: FirstLinkConfig | null | undefined): string[] {
  if (!config) return [];
  if (Array.isArray(config.linkList) && config.linkList.length > 0) {
    return config.linkList.filter((url): url is string => typeof url === "string" && url.length > 0);
  }
  if (typeof config.expectedEventUrl === "string" && config.expectedEventUrl.length > 0) {
    return [config.expectedEventUrl];
  }
  return [];
}

export function currentLinkIndex(
  refreshMinutes: number,
  listLength: number,
  rotationStartMs: number | null = null,
  now = Date.now(),
): number {
  if (listLength <= 1) return 0;
  const safeMins = Number.isFinite(refreshMinutes) && refreshMinutes >= 1 ? Math.floor(refreshMinutes) : 60;
  const windowMs = safeMins * 60_000;
  const reference = typeof rotationStartMs === "number" && Number.isFinite(rotationStartMs) ? rotationStartMs : 0;
  const elapsed = Math.max(0, now - reference);
  return Math.floor(elapsed / windowMs) % listLength;
}

export function quantizeRotationAnchor(refreshMinutes: number, now = Date.now()): number {
  const safeMins = Number.isFinite(refreshMinutes) && refreshMinutes >= 1 ? Math.floor(refreshMinutes) : 60;
  const windowMs = safeMins * 60_000;
  return Math.floor(now / windowMs) * windowMs;
}

export function normalizeUrlForMatch(rawUrl: string): string | null {
  if (typeof rawUrl !== "string") return null;
  const stripped = rawUrl.trim().replace(/^<+/, "").replace(/[>,.;:!?)]+$/g, "");
  let url: URL;
  try {
    url = new URL(stripped);
  } catch {
    return null;
  }
  let host = url.hostname.toLowerCase();
  if (/^(www\.|canary\.|ptb\.)?discord(app)?\.com$/.test(host)) host = "discord.com";
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol.toLowerCase()}//${host}${path}${url.search}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function channelIsVoiceLike(channel: unknown): channel is VoiceBasedChannel {
  return !!channel &&
    typeof channel === "object" &&
    "type" in channel &&
    (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice);
}

function questWindowAllowsCompletion(
  quest: Pick<ActiveQuestTask["quest"], "starts_at" | "ends_at">,
  now = Date.now(),
  options: { ignoreStart?: boolean } = {},
): boolean {
  const startMs = quest.starts_at ? Date.parse(quest.starts_at) : null;
  const endMs = quest.ends_at ? Date.parse(quest.ends_at) : null;

  if (!options.ignoreStart && startMs != null && Number.isFinite(startMs) && now < startMs) return false;
  if (endMs != null && Number.isFinite(endMs) && now > endMs) return false;
  return true;
}

function questWindowEndMs(quest: Pick<ActiveQuestTask["quest"], "ends_at">, fallback = Date.now()): number {
  const endMs = quest.ends_at ? Date.parse(quest.ends_at) : null;
  return endMs != null && Number.isFinite(endMs) ? Math.min(fallback, endMs) : fallback;
}

function eventStatusAllowsAttendance(status: GuildScheduledEventStatus | null | undefined): boolean {
  return status === GuildScheduledEventStatus.Active;
}

function effectiveEventStartIso(event: GuildScheduledEvent, existing: string | null): string | null {
  const scheduledStart = event.scheduledStartAt?.toISOString() ?? null;
  if (event.status !== GuildScheduledEventStatus.Active) return scheduledStart;

  const now = Date.now();
  const existingMs = existing ? Date.parse(existing) : null;
  if (existingMs != null && Number.isFinite(existingMs) && existingMs <= now) return existing;

  const scheduledMs = event.scheduledStartAt?.getTime();
  return scheduledMs != null && Number.isFinite(scheduledMs) && scheduledMs > now
    ? new Date(now).toISOString()
    : scheduledStart;
}

function taskMirrorsScheduledEvent(task: ActiveQuestTask<EventAttendanceConfig>, event: GuildScheduledEvent): boolean {
  const metadata = task.quest.metadata as Record<string, unknown> | undefined;
  return metadata?.scheduledEventId === event.id || metadata?.legacyEventQuestId != null;
}

async function syncTaskQuestFromEvent(
  task: ActiveQuestTask<EventAttendanceConfig>,
  event: GuildScheduledEvent,
): Promise<ActiveQuestTask<EventAttendanceConfig>> {
  if (!taskMirrorsScheduledEvent(task, event)) return task;

  const startsAt = effectiveEventStartIso(event, task.quest.starts_at);
  const endsAt = event.scheduledEndAt?.toISOString() ?? null;
  const changed =
    task.quest.starts_at !== startsAt ||
    task.quest.ends_at !== endsAt ||
    task.quest.title !== event.name;

  if (changed) {
    const { error } = await supabase
      .from("quests")
      .update({
        title: event.name,
        starts_at: startsAt,
        ends_at: endsAt,
        updated_at: nowIso(),
      })
      .eq("id", task.quest_id);

    if (error) console.warn(`[QuestEngine] Failed to sync quest ${task.quest_id} with event:`, error.message);
  }

  return {
    ...task,
    quest: {
      ...task.quest,
      title: event.name,
      starts_at: startsAt,
      ends_at: endsAt,
    },
  };
}

async function eventTaskIsRunning(client: Client, task: ActiveQuestTask<EventAttendanceConfig>): Promise<boolean> {
  if (!task.config.scheduledEventId) return questWindowAllowsCompletion(task.quest);

  const guild = await client.guilds.fetch(task.quest.guild_id).catch(() => null);
  const event = await guild?.scheduledEvents.fetch(task.config.scheduledEventId).catch(() => null);
  if (!event) return false;
  if (event.status === GuildScheduledEventStatus.Completed || event.status === GuildScheduledEventStatus.Canceled) {
    return false;
  }

  const syncedTask = await syncTaskQuestFromEvent(task, event);
  Object.assign(task.quest, syncedTask.quest);
  return questWindowAllowsCompletion(syncedTask.quest, Date.now(), { ignoreStart: true });
}

async function getActiveEventTasksForChannel(
  guildId: string,
  channelId: string,
): Promise<Array<ActiveQuestTask<EventAttendanceConfig>>> {
  const tasks = await getActiveTasksByType<EventAttendanceConfig>(guildId, "event_attendance").catch((err) => {
    console.warn("[QuestEngine] Failed to load event tasks:", (err as Error).message);
    return [];
  });

  return tasks.filter((task) => task.config.eventChannelId === channelId);
}

async function startAttendance(
  task: ActiveQuestTask<EventAttendanceConfig>,
  userId: string,
  options: { ignoreStart?: boolean } = {},
): Promise<void> {
  if (!questWindowAllowsCompletion(task.quest, Date.now(), options)) return;
  const joinedAt = nowIso();

  const { data: existing, error: readError } = await supabase
    .from("quest_task_attendance")
    .select("joined_at")
    .eq("task_id", task.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    console.warn(`[QuestEngine] Failed to read attendance for task ${task.id}:`, readError.message);
    return;
  }
  if (existing?.joined_at) return;

  const payload = {
    quest_id: task.quest_id,
    task_id: task.id,
    user_id: userId,
    joined_at: joinedAt,
    last_seen_at: joinedAt,
  };

  const { error } = await supabase
    .from("quest_task_attendance")
    .upsert(payload, { onConflict: "task_id,user_id" });

  if (error) console.warn(`[QuestEngine] Failed to start attendance for task ${task.id}:`, error.message);
}

async function stopAttendance(
  client: Client,
  task: ActiveQuestTask<EventAttendanceConfig>,
  userId: string,
  accrualEndMs = questWindowEndMs(task.quest),
): Promise<void> {
  const { data: row, error } = await supabase
    .from("quest_task_attendance")
    .select("joined_at, accumulated_seconds")
    .eq("task_id", task.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !row || !row.joined_at) return;

  const joinedMs = Date.parse(row.joined_at as string);
  const elapsedSeconds = Number.isFinite(joinedMs)
    ? Math.max(0, Math.floor((accrualEndMs - joinedMs) / 1000))
    : 0;
  const accumulated = Math.max(0, (row.accumulated_seconds as number) + elapsedSeconds);

  await supabase
    .from("quest_task_attendance")
    .update({
      joined_at: null,
      accumulated_seconds: accumulated,
      last_seen_at: nowIso(),
    })
    .eq("task_id", task.id)
    .eq("user_id", userId);

  if (accumulated >= task.config.minMinutes * 60) {
    await completeAndNotify(client, task, userId, {
      kind: "event_attendance",
      accumulatedSeconds: accumulated,
    });
  }
}

async function updateConnectedAttendance(
  client: Client,
  task: ActiveQuestTask<EventAttendanceConfig>,
  userId: string,
  options: { running: boolean; allowStart?: boolean; accrualEndMs?: number },
): Promise<void> {
  const accrualEndMs = questWindowEndMs(task.quest, options.accrualEndMs ?? Date.now());
  if (!options.running || !questWindowAllowsCompletion(task.quest, accrualEndMs, { ignoreStart: options.running })) {
    await stopAttendance(client, task, userId, accrualEndMs);
    return;
  }

  const { data: row, error } = await supabase
    .from("quest_task_attendance")
    .select("joined_at, accumulated_seconds")
    .eq("task_id", task.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return;
  if (!row) {
    if (options.allowStart !== false) await startAttendance(task, userId, { ignoreStart: options.running });
    return;
  }
  if (!row.joined_at) return;

  const joinedMs = Date.parse(row.joined_at as string);
  if (!Number.isFinite(joinedMs)) return;

  const accumulated = Math.max(
    0,
    (row.accumulated_seconds as number) + Math.floor((accrualEndMs - joinedMs) / 1000),
  );

  const { error: updateError } = await supabase
    .from("quest_task_attendance")
    .update({
      accumulated_seconds: accumulated,
      joined_at: nowIso(),
      last_seen_at: nowIso(),
    })
    .eq("task_id", task.id)
    .eq("user_id", userId);

  if (updateError) {
    console.warn(`[QuestEngine] Failed to update attendance for task ${task.id}:`, updateError.message);
    return;
  }

  if (accumulated >= task.config.minMinutes * 60) {
    await completeAndNotify(client, task, userId, {
      kind: "event_attendance",
      accumulatedSeconds: accumulated,
    });
  }
}

function urlsFromText(text: string | null | undefined): string[] {
  if (!text) return [];

  const urls = new Set<string>();
  const markdownLinks = text.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/gi);
  for (const match of markdownLinks) urls.add(match[1]);

  const bareLinks = text.matchAll(/https?:\/\/[^\s<>()]+/gi);
  for (const match of bareLinks) urls.add(match[0]);

  return [...urls].map((url) => url.replace(/[>,.]+$/g, ""));
}

function discordMessageLinks(urls: string[]): Array<{ channelId: string; messageId: string }> {
  const links: Array<{ channelId: string; messageId: string }> = [];

  for (const rawUrl of urls) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }

    const host = url.hostname.toLowerCase();
    if (!/^(www\.|canary\.|ptb\.)?discord(app)?\.com$/.test(host)) continue;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "channels" && parts[2] && parts[3]) {
      links.push({ channelId: parts[2], messageId: parts[3] });
    }
  }

  return links;
}

function collectPosterUrls(message: Message): string[] {
  const urls = new Set<string>(urlsFromText(message.content));

  for (const embed of message.embeds) {
    for (const url of urlsFromText(embed.url)) urls.add(url);
    for (const url of urlsFromText(embed.description)) urls.add(url);
    for (const url of urlsFromText(embed.title)) urls.add(url);
    for (const field of embed.fields) {
      for (const url of urlsFromText(field.name)) urls.add(url);
      for (const url of urlsFromText(field.value)) urls.add(url);
    }
  }

  return [...urls];
}

function isDiscordChannelsUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (!/^(www\.|canary\.|ptb\.)?discord(app)?\.com$/.test(host)) return false;
    const parts = new URL(rawUrl).pathname.split("/").filter(Boolean);
    return parts[0] === "channels" && !!parts[2] && !!parts[3];
  } catch {
    return false;
  }
}

function isPosterContentOnlyDiscordMessageLinks(message: Message, posterUrls: string[]): boolean {
  const contentUrls = urlsFromText(message.content);
  if (contentUrls.length === 0) return false;
  return contentUrls.every(isDiscordChannelsUrl);
}

function scrapeUrlsFromMessageSurface(linkedMessage: Message): string[] {
  const urls = new Set<string>(urlsFromText(linkedMessage.content));
  for (const embed of linkedMessage.embeds) {
    for (const url of urlsFromText(embed.url)) urls.add(url);
    for (const url of urlsFromText(embed.description)) urls.add(url);
    for (const url of urlsFromText(embed.title)) urls.add(url);
    for (const field of embed.fields) {
      for (const url of urlsFromText(field.name)) urls.add(url);
      for (const url of urlsFromText(field.value)) urls.add(url);
    }
  }
  return [...urls];
}

async function expandDiscordMessageLinks(
  message: Message,
  posterUrls: string[],
  authoritativeByMessageId?: Map<string, string>,
): Promise<string[]> {
  const expanded = new Set<string>();

  for (const link of discordMessageLinks(posterUrls)) {
    const authoritative = authoritativeByMessageId?.get(link.messageId);
    if (authoritative) {
      expanded.add(authoritative);
      continue;
    }

    const channel = await message.client.channels.fetch(link.channelId).catch(() => null);
    if (!channel || !("messages" in channel)) continue;

    const linkedMessage = await channel.messages.fetch(link.messageId).catch(() => null);
    if (!linkedMessage) continue;

    for (const url of scrapeUrlsFromMessageSurface(linkedMessage)) expanded.add(url);
  }

  return [...expanded];
}

async function collectMessageUrls(message: Message): Promise<CollectedMessageUrls> {
  const posterUrls = collectPosterUrls(message);
  const expandedUrls = await expandDiscordMessageLinks(message, posterUrls);
  const allUrls = [...new Set([...posterUrls, ...expandedUrls])];
  return { posterUrls, expandedUrls, allUrls };
}

async function collectMessageUrlsWithDelayedEmbedFetch(message: Message): Promise<CollectedMessageUrls> {
  let collected = await collectMessageUrls(message);
  const needsEmbedHydration =
    collected.allUrls.length === 0 ||
    (extractDiscordEventIds(collected.allUrls).length === 0 && discordMessageLinks(collected.posterUrls).length > 0);
  if (!needsEmbedHydration) return collected;

  await sleep(EMBED_REFETCH_DELAY_MS);
  const freshMessage = await message.channel.messages.fetch(message.id).catch(() => null);
  if (!freshMessage) return collected;

  const fresh = await collectMessageUrls(freshMessage);
  collected = {
    posterUrls: [...new Set([...collected.posterUrls, ...fresh.posterUrls])],
    expandedUrls: [...new Set([...collected.expandedUrls, ...fresh.expandedUrls])],
    allUrls: [...new Set([...collected.allUrls, ...fresh.allUrls])],
  };
  return collected;
}

function activeRotatingLinkUrl(config: FirstLinkConfig): string | null {
  const list = resolveLinkList(config);
  if (list.length === 0) return null;
  const refreshMinutes = Number.isFinite(config.refreshMinutes) && config.refreshMinutes >= 1
    ? Math.floor(config.refreshMinutes)
    : 60;
  const index = currentLinkIndex(refreshMinutes, list.length, config.rotationStartMs ?? null);
  return list[index] ?? null;
}

function urlsForTaskMatching(
  message: Message,
  task: ActiveQuestTask<FirstLinkConfig>,
  collected: CollectedMessageUrls,
): string[] {
  const config = task.config;
  const posterDiscordLinks = discordMessageLinks(collected.posterUrls);
  const questMessageId = task.quest.message_id;
  const questChannelId = task.quest.channel_id;

  const linksToQuestAnnouncement = questMessageId && questChannelId
    && posterDiscordLinks.some((link) => link.messageId === questMessageId && link.channelId === questChannelId);

  if (
    linksToQuestAnnouncement
    && (config.source === "rotating_list" || config.source === "nearest_event")
  ) {
    const activeUrl = activeRotatingLinkUrl(config);
    if (activeUrl) return [activeUrl];
  }

  if (isPosterContentOnlyDiscordMessageLinks(message, collected.posterUrls) && collected.expandedUrls.length > 0) {
    return collected.expandedUrls;
  }

  return collected.allUrls;
}

function matchNormsForLog(urls: string[]): string[] {
  return urls
    .map(normalizeUrlForMatch)
    .filter((u): u is string => !!u && !isDiscordChannelsUrl(u));
}

function extractDiscordEventIds(urls: string[]): string[] {
  const ids: string[] = [];

  for (const rawUrl of urls) {
    let url: URL;
    try {
      url = new URL(rawUrl.replace(/[>,.]+$/g, ""));
    } catch {
      continue;
    }

    const host = url.hostname.toLowerCase();
    if (/^(www\.|canary\.|ptb\.)?discord(app)?\.com$/.test(host)) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "events" && parts[2]) ids.push(parts[2]);
    }

    if (host === "discord.gg" || host.endsWith(".discord.gg")) {
      const eventId = url.searchParams.get("event");
      if (eventId) ids.push(eventId);
    }
  }

  return ids;
}

function messageMatchesFirstLinkTask(
  message: Message,
  task: ActiveQuestTask<FirstLinkConfig>,
  collected: CollectedMessageUrls,
): boolean {
  const config = task.config;
  if (!config || message.channelId !== config.targetChannelId) return false;

  const urls = urlsForTaskMatching(message, task, collected);
  if (urls.length === 0) return false;

  if (config.source === "latest_tweet") {
    return urls.some((url) => /^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i.test(url));
  }

  // rotating_list (and legacy nearest_event quests reuse the rotating-list matcher
  // via resolveLinkList — a 1-item list reconstructed from expectedEventUrl).
  if (config.source === "rotating_list" || config.source === "nearest_event") {
    const list = resolveLinkList(config);
    if (list.length === 0) return false;

    const refreshMinutes = Number.isFinite(config.refreshMinutes) && config.refreshMinutes >= 1
      ? Math.floor(config.refreshMinutes)
      : 60;
    const index = currentLinkIndex(refreshMinutes, list.length, config.rotationStartMs ?? null);
    const targetNorm = normalizeUrlForMatch(list[index]);
    if (!targetNorm) return false;

    const messageNorms = new Set(urls.map(normalizeUrlForMatch).filter((u): u is string => !!u));
    if (!messageNorms.has(targetNorm)) {
      const logNorms = matchNormsForLog(urls);
      console.log(`[QuestEngine] First-link task ${task.id} rejected: expected=${targetNorm} got=${logNorms.join(",")}`);
      return false;
    }
    return true;
  }

  return urls.length > 0;
}

function linkWindowStartMs(
  refreshMinutes: number,
  rotationStartMs: number | null = null,
  now = Date.now(),
): number {
  const safeMins = Number.isFinite(refreshMinutes) && refreshMinutes >= 1 ? Math.floor(refreshMinutes) : 60;
  const windowMs = safeMins * 60_000;
  const reference = typeof rotationStartMs === "number" && Number.isFinite(rotationStartMs) ? rotationStartMs : 0;
  const elapsed = Math.max(0, now - reference);
  const windowsElapsed = Math.floor(elapsed / windowMs);
  return reference + windowsElapsed * windowMs;
}

function linkWindowStartIso(
  refreshMinutes: number,
  rotationStartMs: number | null = null,
  now = Date.now(),
): string {
  return new Date(linkWindowStartMs(refreshMinutes, rotationStartMs, now)).toISOString();
}

async function claimFirstLinkWindow(
  task: ActiveQuestTask<FirstLinkConfig>,
  userId: string,
  proof: Record<string, unknown>,
): Promise<boolean> {
  const refreshMinutes = Number.isFinite(task.config.refreshMinutes) && task.config.refreshMinutes >= 1
    ? Math.floor(task.config.refreshMinutes)
    : 60;
  const { data, error } = await supabase
    .from("quest_task_window_claims")
    .insert({
      task_id: task.id,
      window_start: linkWindowStartIso(refreshMinutes, task.config.rotationStartMs ?? null),
      user_id: userId,
      proof,
    })
    .select("task_id")
    .maybeSingle();

  if (error) {
    if (error.code !== "23505") {
      console.warn(`[QuestEngine] Failed to claim link window for task ${task.id}:`, error.message);
    }
    return false;
  }

  return !!data;
}

async function markFirstLinkWindowClaimed(
  task: ActiveQuestTask<FirstLinkConfig>,
  userId: string,
  linkIndex: number,
  winnerMessageId: string,
  matchedUrl: string | null,
): Promise<void> {
  const refreshMinutes = Number.isFinite(task.config.refreshMinutes) && task.config.refreshMinutes >= 1
    ? Math.floor(task.config.refreshMinutes)
    : 60;
  const metadata = (task.quest.metadata ?? {}) as Record<string, unknown>;
  const currentLinkClaim: FirstLinkClaimMetadata = {
    taskId: task.id,
    windowStart: linkWindowStartIso(refreshMinutes, task.config.rotationStartMs ?? null),
    userId,
    linkIndex,
    claimedAt: nowIso(),
    winnerMessageId,
    matchedUrl: matchedUrl ?? undefined,
  };

  const { error } = await supabase
    .from("quests")
    .update({
      metadata: { ...metadata, currentLinkClaim },
      updated_at: nowIso(),
    })
    .eq("id", task.quest_id);

  if (error) {
    console.warn(`[QuestEngine] Failed to mark link window claimed for quest ${task.quest_id}:`, error.message);
    return;
  }

  task.quest.metadata = { ...metadata, currentLinkClaim };
}

const QUEST_STATUS_META: Record<string, { color: number; emoji: string; label: string }> = {
  active: { color: 0x77a7ff, emoji: "❄️", label: "Active" },
  completed: { color: 0x00cc6a, emoji: "✅", label: "Completed" },
  exhausted: { color: 0xb59f4a, emoji: "💤", label: "Exhausted" },
  cancelled: { color: 0x808080, emoji: "🚫", label: "Cancelled" },
  draft: { color: 0x77a7ff, emoji: "📝", label: "Draft" },
};

export function buildQuestRuntimeEmbed(snapshot: Awaited<ReturnType<typeof getQuestSnapshot>>): EmbedBuilder | null {
  if (!snapshot) return null;
  const status = QUEST_STATUS_META[snapshot.quest.status] ?? QUEST_STATUS_META.active;

  const tierLines = snapshot.tiers.length === 0
    ? "No reward tiers set."
    : snapshot.tiers.map((tier) =>
      `↳ **${tier.completed_task_count} task${tier.completed_task_count === 1 ? "" : "s"}** → **${formatSats(tier.reward_sats)}**`,
    ).join("\n");

  const embed = new EmbedBuilder()
    .setColor(status.color)
    .setTitle(`${status.emoji} ${snapshot.quest.title}`)
    .setDescription(snapshot.quest.description?.trim() || "A multi-step sats quest. Complete tasks to earn rewards.")
    .setFooter({ text: `Quest #${snapshot.quest.id} • ⚡ Powered by matsFi` })
    .setTimestamp();

  // Surface the rotating-link target front-and-center for link-quest tasks.
  for (const task of snapshot.tasks) {
    if (task.type !== "first_link_in_channel") continue;
    const config = task.config as FirstLinkConfig | null | undefined;
    if (!config) continue;
    if (config.source !== "rotating_list" && config.source !== "nearest_event") continue;

    const list = resolveLinkList(config);
    if (list.length === 0) continue;

    const refreshMinutes = Number.isFinite(config.refreshMinutes) && config.refreshMinutes >= 1
      ? Math.floor(config.refreshMinutes)
      : 60;

    const anchor = typeof config.rotationStartMs === "number" && Number.isFinite(config.rotationStartMs)
      ? config.rotationStartMs
      : null;
    const index = currentLinkIndex(refreshMinutes, list.length, anchor);
    const current = list[index];
    const windowStart = linkWindowStartIso(refreshMinutes, anchor);
    const claim = (snapshot.quest.metadata as Record<string, unknown> | null | undefined)?.currentLinkClaim as FirstLinkClaimMetadata | undefined;
    const isClaimed = claim?.taskId === task.id && claim.windowStart === windowStart;

    const windowMs = refreshMinutes * 60_000;
    const reference = anchor ?? linkWindowStartMs(refreshMinutes);
    const elapsed = Math.max(0, Date.now() - reference);
    const windowsElapsed = Math.floor(elapsed / windowMs);
    const nextRotationMs = reference + (windowsElapsed + 1) * windowMs;
    const nextTs = Math.floor(nextRotationMs / 1000);

    const channelRef = `<#${config.targetChannelId}>`;
    const claimLine = isClaimed && claim?.userId
      ? "🟢 **Claimed** by " + `<@${claim.userId}>`
      : "🔴 **Open** — post the current link";
    const positionLine = list.length > 1
      ? `**Link ${index + 1} of ${list.length}** • Rotates every **${refreshMinutes}** min • Next rotation <t:${nextTs}:R>`
      : `Refresh every **${refreshMinutes}** min • Next reset <t:${nextTs}:R>`;

    embed.setColor(isClaimed ? LINK_QUEST_CLAIMED_COLOR : LINK_QUEST_OPEN_COLOR);

    embed.addFields(
      { name: "🎯 Current target", value: `${positionLine}\n${claimLine}\n${current}`, inline: false },
      { name: "📨 Post in", value: channelRef, inline: true },
    );
    break;
  }

  embed.addFields({ name: "✨ Rewards", value: tierLines, inline: false });

  const taskLines = snapshot.tasks.length === 0
    ? "No tasks yet."
    : snapshot.tasks.map((task, index) => {
      const definition = getQuestTaskDefinition(task.type);
      const requirement = definition?.renderRequirement(task.config) ?? task.description ?? task.title;
      return `**${index + 1}. ${task.title}**\n${requirement}`;
    }).join("\n\n");

  embed.addFields({ name: "📋 Requirements", value: taskLines.slice(0, 1024), inline: false });

  embed.addFields(
    { name: "Status", value: status.label, inline: true },
    { name: "Max payout", value: `**${formatSats(snapshot.quest.max_reward_sats)}**`, inline: true },
  );

  return embed;
}

export async function refreshQuestMessage(client: Client, questId: number): Promise<boolean> {
  const snapshot = await getQuestSnapshot(questId).catch((err) => {
    console.warn(`[QuestEngine] refreshQuestMessage: Failed to get quest snapshot for ${questId}:`, err);
    return null;
  });
  if (!snapshot) return false;

  const embed = buildQuestRuntimeEmbed(snapshot);
  if (!snapshot.quest.message_id) {
    console.warn(`[QuestEngine] refreshQuestMessage: Quest ${questId} has no message_id in database.`);
    return false;
  }
  if (!embed) {
    console.warn(`[QuestEngine] refreshQuestMessage: Failed to build quest embed for quest ${questId}.`);
    return false;
  }

  const channel = await client.channels.fetch(snapshot.quest.channel_id).catch((err) => {
    if (err.code === 50001 || err.message?.includes("Missing Access")) {
      console.warn(`[QuestEngine] refreshQuestMessage: Missing Access (50001) when fetching channel ${snapshot.quest.channel_id} for quest ${questId}. Please ensure the bot has 'View Channel' permissions in this channel.`);
    } else {
      console.warn(`[QuestEngine] refreshQuestMessage: Failed to fetch channel ${snapshot.quest.channel_id} for quest ${questId}:`, err.message);
    }
    return null;
  });
  if (!channel) {
    console.warn(`[QuestEngine] refreshQuestMessage: Channel ${snapshot.quest.channel_id} for quest ${questId} not found.`);
    return false;
  }
  if (!("messages" in channel)) {
    console.warn(`[QuestEngine] refreshQuestMessage: Channel ${snapshot.quest.channel_id} for quest ${questId} is not text-based.`);
    return false;
  }

  const message = await channel.messages.fetch(snapshot.quest.message_id).catch((err) => {
    if (err.code === 50001 || err.message?.includes("Missing Access")) {
      console.warn(`[QuestEngine] refreshQuestMessage: Missing Access (50001) when fetching message ${snapshot.quest.message_id} in channel ${snapshot.quest.channel_id}. Please ensure the bot has both 'View Channel' and 'Read Message History' permissions in this channel.`);
    } else {
      console.warn(`[QuestEngine] refreshQuestMessage: Message ${snapshot.quest.message_id} in channel ${snapshot.quest.channel_id} not found:`, err.message);
    }
    return null;
  });
  if (!message) return false;

  try {
    await message.edit({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    console.warn(`[QuestEngine] Failed to edit quest message ${snapshot.quest.message_id}:`, (err as Error).message);
    return false;
  }
}

export async function completeAndNotify(
  client: Client,
  task: Pick<ActiveQuestTask, "id" | "quest_id" | "title" | "quest">,
  userId: string,
  proof?: Record<string, unknown>,
): Promise<QuestCompletionResult> {
  const result = await completeQuestTask({
    questId: task.quest_id,
    taskId: task.id,
    userId,
    proof,
  });

  if (!result.ok) return result;

  if ((result.rewardDeltaSats ?? 0) > 0) {
    recordLedgerEntry(client, {
      type: "quest_reward",
      amountSats: result.rewardDeltaSats ?? 0,
      senderId: task.quest.creator_id,
      receiverId: userId,
      guildId: task.quest.guild_id,
      referenceType: "quest_reward_events",
      referenceId: String(task.quest_id),
      metadata: { task_id: task.id, task_title: task.title },
    });

    await registerDepositAddress(userId).catch(() => {});
    await sendTransferReceivedDm({
      client,
      recipientId: userId,
      senderId: task.quest.creator_id,
      amountSats: result.rewardDeltaSats ?? 0,
      kind: "quest",
      customMessage: `Completed quest task: ${task.title}`,
    });
  }

  const refreshed = await refreshQuestMessage(client, task.quest_id);
  if (refreshed) {
    initializedQuestIds.add(task.quest_id);
  }
  return result;
}

async function notifyQuestReward(
  client: Client,
  task: Pick<ActiveQuestTask, "id" | "quest_id" | "title" | "quest">,
  userId: string,
  rewardSats: number,
): Promise<void> {
  recordLedgerEntry(client, {
    type: "quest_reward",
    amountSats: rewardSats,
    senderId: task.quest.creator_id,
    receiverId: userId,
    guildId: task.quest.guild_id,
    referenceType: "quest_reward_events",
    referenceId: String(task.quest_id),
    metadata: { task_id: task.id, task_title: task.title },
  });

  await registerDepositAddress(userId).catch(() => {});
  await sendTransferReceivedDm({
    client,
    recipientId: userId,
    senderId: task.quest.creator_id,
    amountSats: rewardSats,
    kind: "quest",
    customMessage: `Completed quest task: ${task.title}`,
  });
}

async function completeRepeatableLinkWindowAndNotify(
  client: Client,
  task: ActiveQuestTask<FirstLinkConfig>,
  userId: string,
  proof: Record<string, unknown>,
): Promise<QuestCompletionResult> {
  const result = await completeQuestTask({
    questId: task.quest_id,
    taskId: task.id,
    userId,
    proof,
  });

  if (!result.ok) return result;

  if ((result.rewardDeltaSats ?? 0) > 0) {
    await notifyQuestReward(client, task, userId, result.rewardDeltaSats ?? 0);
  } else if (result.insertedCompletion === false) {
    const repeatResult = await payRepeatableQuestTaskReward({
      questId: task.quest_id,
      taskId: task.id,
      userId,
      proof,
    });

    if (repeatResult.ok && (repeatResult.rewardDeltaSats ?? 0) > 0) {
      await notifyQuestReward(client, task, userId, repeatResult.rewardDeltaSats ?? 0);
    }
  }

  const refreshed = await refreshQuestMessage(client, task.quest_id);
  if (refreshed) {
    initializedQuestIds.add(task.quest_id);
  }
  return result;
}

async function maybeDeleteDuplicateLinkPost(
  client: Client,
  message: Message,
  tasks: Array<ActiveQuestTask<FirstLinkConfig>>,
  collected: CollectedMessageUrls,
): Promise<void> {
  const deleteMinutes = appConfig.quests.linkDuplicateDeleteMinutes;
  if (deleteMinutes <= 0 || message.author.bot) return;

  const channel = message.channel;
  if (!channel.isTextBased() || channel.isDMBased()) return;

  const me = message.guild?.members.me ?? client.user;
  if (!me) return;

  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ManageMessages)) return;

  for (const task of tasks) {
    if (task.config.targetChannelId !== message.channelId) continue;

    const claim = (task.quest.metadata as Record<string, unknown> | null | undefined)?.currentLinkClaim as FirstLinkClaimMetadata | undefined;
    if (!claim?.claimedAt || !claim.windowStart) continue;
    if (claim.winnerMessageId === message.id) continue;

    const refreshMinutes = Number.isFinite(task.config.refreshMinutes) && task.config.refreshMinutes >= 1
      ? Math.floor(task.config.refreshMinutes)
      : 60;
    const windowStart = linkWindowStartIso(refreshMinutes, task.config.rotationStartMs ?? null);
    if (claim.windowStart !== windowStart) continue;

    const claimAgeMs = Date.now() - Date.parse(claim.claimedAt);
    if (!Number.isFinite(claimAgeMs) || claimAgeMs > deleteMinutes * 60_000) continue;

    const list = resolveLinkList(task.config);
    if (list.length === 0) continue;

    const linkIndex = typeof claim.linkIndex === "number" ? claim.linkIndex : currentLinkIndex(
      refreshMinutes,
      list.length,
      task.config.rotationStartMs ?? null,
    );
    const targetNorm = normalizeUrlForMatch(list[linkIndex]);
    if (!targetNorm) continue;

    const matchUrls = urlsForTaskMatching(message, task, collected);
    const messageNorms = new Set(matchUrls.map(normalizeUrlForMatch).filter((u): u is string => !!u));
    if (!messageNorms.has(targetNorm)) continue;

    await message.delete().catch((err) => {
      console.warn(`[QuestEngine] Failed to delete duplicate link message ${message.id}:`, (err as Error).message);
    });
    return;
  }
}

export async function resetFirstLinkWindow(
  client: Client,
  questId: number,
): Promise<{ ok: boolean; reason?: string; taskId?: number; windowStart?: string }> {
  const snapshot = await getQuestSnapshot(questId).catch(() => null);
  if (!snapshot) return { ok: false, reason: "quest_not_found" };
  if (snapshot.quest.status !== "active") return { ok: false, reason: "quest_not_active" };

  const linkTask = snapshot.tasks.find((task) => {
    if (task.type !== "first_link_in_channel") return false;
    const cfg = task.config as FirstLinkConfig | null | undefined;
    return cfg && (cfg.source === "rotating_list" || cfg.source === "nearest_event");
  });
  if (!linkTask) return { ok: false, reason: "no_link_task" };

  const config = linkTask.config as FirstLinkConfig;
  const refreshMinutes = Number.isFinite(config.refreshMinutes) && config.refreshMinutes >= 1
    ? Math.floor(config.refreshMinutes)
    : 60;
  const windowStart = linkWindowStartIso(refreshMinutes, config.rotationStartMs ?? null);

  const { error: claimError } = await supabase
    .from("quest_task_window_claims")
    .delete()
    .eq("task_id", linkTask.id)
    .eq("window_start", windowStart);

  if (claimError) {
    console.warn(`[QuestEngine] resetFirstLinkWindow claim delete failed for quest ${questId}:`, claimError.message);
    return { ok: false, reason: claimError.message };
  }

  const metadata = { ...(snapshot.quest.metadata as Record<string, unknown> | null ?? {}) };
  delete metadata.currentLinkClaim;

  const { error: metaError } = await supabase
    .from("quests")
    .update({ metadata, updated_at: nowIso() })
    .eq("id", questId);

  if (metaError) {
    console.warn(`[QuestEngine] resetFirstLinkWindow metadata update failed for quest ${questId}:`, metaError.message);
    return { ok: false, reason: metaError.message };
  }

  await refreshQuestMessage(client, questId);

  return { ok: true, taskId: linkTask.id, windowStart };
}

export async function handleMultiStepQuestMessage(client: Client, message: Message): Promise<void> {
  if (!message.guild || message.author.bot) return;

  const tasks = await getActiveTasksByType<FirstLinkConfig>(message.guild.id, "first_link_in_channel").catch((err) => {
    console.warn("[QuestEngine] Failed to load link tasks:", (err as Error).message);
    return [];
  });
  const channelHasTask = tasks.some((task) => task.config.targetChannelId === message.channelId);
  if (channelHasTask) {
    console.log(`[QuestEngine] Message ${message.id} in link-quest channel ${message.channelId} by ${message.author.id}: contentLen=${message.content.length} embeds=${message.embeds.length}`);
  }

  const collected = await collectMessageUrlsWithDelayedEmbedFetch(message);
  if (channelHasTask) {
    console.log(`[QuestEngine] Message ${message.id} extracted urls=${JSON.stringify(collected.allUrls)}`);
  }

  await maybeDeleteDuplicateLinkPost(client, message, tasks, collected);

  if (collected.allUrls.length === 0) return;

  for (const task of tasks) {
    if (!questWindowAllowsCompletion(task.quest)) continue;
    if (!messageMatchesFirstLinkTask(message, task, collected)) continue;

    const matchUrls = urlsForTaskMatching(message, task, collected);
    const list = resolveLinkList(task.config);
    const refreshMinutes = Number.isFinite(task.config.refreshMinutes) && task.config.refreshMinutes >= 1
      ? Math.floor(task.config.refreshMinutes)
      : 60;
    const linkIndex = currentLinkIndex(refreshMinutes, list.length, task.config.rotationStartMs ?? null);
    const matchedUrl = list[linkIndex] ?? matchUrls[0] ?? null;

    const proof = {
      kind: "first_link_in_channel",
      messageId: message.id,
      channelId: message.channelId,
      source: task.config.source,
      url: matchUrls[0] ?? null,
      matchedUrl,
    };
    const wonWindow = await claimFirstLinkWindow(task, message.author.id, proof);
    if (!wonWindow) continue;

    await markFirstLinkWindowClaimed(task, message.author.id, linkIndex, message.id, matchedUrl);
    await completeRepeatableLinkWindowAndNotify(client, task, message.author.id, proof);
  }
}

export async function handleMultiStepQuestVoiceStateUpdate(
  client: Client,
  oldState: VoiceState,
  newState: VoiceState,
): Promise<void> {
  const userId = newState.id;
  if (newState.member?.user.bot || oldState.member?.user.bot) return;
  if (oldState.channelId === newState.channelId) return;

  if (oldState.guild.id && oldState.channelId) {
    const leavingTasks = await getActiveEventTasksForChannel(oldState.guild.id, oldState.channelId);
    await Promise.all(leavingTasks.map((task) => stopAttendance(client, task, userId)));
  }

  if (newState.guild.id && newState.channelId) {
    const joiningTasks = await getActiveEventTasksForChannel(newState.guild.id, newState.channelId);
    await Promise.all(
      joiningTasks.map(async (task) => {
        if (await eventTaskIsRunning(client, task)) await startAttendance(task, userId, { ignoreStart: true });
      }),
    );
  }
}

export function startMultiStepQuestSweeper(client: Client): void {
  setInterval(() => {
    sweepMultiStepQuests(client).catch((err) =>
      console.warn("[QuestEngine] Sweeper failed:", (err as Error)?.message ?? err)
    );
  }, SWEEP_MS);
}

async function sweepMultiStepQuests(client: Client): Promise<void> {
  let guildTasks: Array<ActiveQuestTask<EventAttendanceConfig>> = [];
  try {
    guildTasks = await getAllActiveTasksByType<EventAttendanceConfig>("event_attendance").catch((err) => {
      console.warn(`[QuestEngine] Failed to fetch active voice event tasks:`, (err as Error).message);
      return [];
    });
  } catch (err) {
    console.error("[QuestEngine] Error during voice attendance tasks query:", err);
  }

  // Group by guildId
  const byGuild = new Map<string, Array<ActiveQuestTask<EventAttendanceConfig>>>();
  for (const task of guildTasks) {
    const list = byGuild.get(task.quest.guild_id) ?? [];
    list.push(task);
    byGuild.set(task.quest.guild_id, list);
  }

  try {
    for (const [guildId, tasks] of byGuild) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) continue;

      for (const task of tasks) {
        try {
          const channel = await guild.channels.fetch(task.config.eventChannelId).catch(() => null);
          if (!channelIsVoiceLike(channel)) continue;

          const event = task.config.scheduledEventId
            ? await guild.scheduledEvents.fetch(task.config.scheduledEventId).catch(() => null)
            : null;
          const syncedTask = event ? await syncTaskQuestFromEvent(task, event) : task;
          const endedByStatus =
            event?.status === GuildScheduledEventStatus.Completed ||
            event?.status === GuildScheduledEventStatus.Canceled;
          const running = !endedByStatus && await eventTaskIsRunning(client, syncedTask);
          const accrualEndMs = questWindowEndMs(syncedTask.quest);

          for (const [userId, member] of channel.members) {
            if (member.user.bot) continue;
            await updateConnectedAttendance(client, syncedTask, userId, {
              running,
              allowStart: false,
              accrualEndMs,
            }).catch((err) => {
              console.warn(`[QuestEngine] Failed to update attendance for user ${userId}:`, err.message);
            });
          }
        } catch (taskErr) {
          console.error(`[QuestEngine] Error sweeping task ${task.id}:`, taskErr);
        }
      }
    }
  } catch (err) {
    console.error("[QuestEngine] Error during voice attendance sweep:", err);
  }

  try {
    await sweepRotatingLinkQuests(client);
  } catch (err) {
    console.error("[QuestEngine] Error during rotating link sweep:", err);
  }
}

async function sweepRotatingLinkQuests(client: Client): Promise<void> {
  const tasks = await getAllActiveTasksByType<FirstLinkConfig>("first_link_in_channel").catch(() => []);
  const seenQuests = new Set<number>();

  for (const task of tasks) {
    const config = task.config as FirstLinkConfig | null | undefined;
    if (!config) continue;
    if (config.source !== "rotating_list" && config.source !== "nearest_event") continue;
    if (seenQuests.has(task.quest_id)) continue;
    seenQuests.add(task.quest_id);

    const guild = await client.guilds.fetch(task.quest.guild_id).catch(() => null);
    if (!guild) continue;

    const list = resolveLinkList(config);
    if (list.length === 0) continue;

    const refreshMinutes = Number.isFinite(config.refreshMinutes) && config.refreshMinutes >= 1
      ? Math.floor(config.refreshMinutes)
      : 60;

    // Back-fill rotationStartMs and refreshMinutes for quests created before anchored rotation existed.
    let rotationStartMs = config.rotationStartMs ?? null;
    const needsBackfill = typeof rotationStartMs !== "number" || !Number.isFinite(rotationStartMs) || config.refreshMinutes !== refreshMinutes;
    if (needsBackfill) {
      if (typeof rotationStartMs !== "number" || !Number.isFinite(rotationStartMs)) {
        rotationStartMs = quantizeRotationAnchor(refreshMinutes);
      }
      const newConfig = { ...config, rotationStartMs, refreshMinutes };
      const { error: configError } = await supabase
        .from("quest_tasks")
        .update({ config: newConfig })
        .eq("id", task.id);
      if (configError) {
        console.warn(`[QuestEngine] Failed to back-fill config for task ${task.id}:`, configError.message);
        continue;
      }
      task.config = newConfig;
    }

    const index = currentLinkIndex(refreshMinutes, list.length, rotationStartMs);
    const windowStart = linkWindowStartIso(refreshMinutes, rotationStartMs);
    const metadata = (task.quest.metadata ?? {}) as Record<string, unknown>;
    const lastRendered = metadata.lastRenderedLinkIndex;
    const lastRenderedWindow = metadata.lastRenderedLinkWindowStart;

    const isFirstCheckInProcess = !initializedQuestIds.has(task.quest_id);
    if (!isFirstCheckInProcess && lastRendered === index && lastRenderedWindow === windowStart) continue;

    // Refresh Discord message first
    const refreshed = await refreshQuestMessage(client, task.quest_id);
    if (!refreshed) continue;

    initializedQuestIds.add(task.quest_id);

    // Persist only after successful Discord edit
    const { error } = await supabase
      .from("quests")
      .update({
        metadata: { ...metadata, lastRenderedLinkIndex: index, lastRenderedLinkWindowStart: windowStart },
        updated_at: nowIso(),
      })
      .eq("id", task.quest_id);
    if (error) {
      console.warn(`[QuestEngine] Failed to persist rotation index for quest ${task.quest_id}:`, error.message);
    }
  }
}

export async function handleMultiStepScheduledEventUpdate(
  client: Client,
  event: GuildScheduledEvent,
): Promise<void> {
  if (!event.guildId) return;

  const tasks = await getActiveTasksByType<EventAttendanceConfig>(event.guildId, "event_attendance").catch((err) => {
    console.warn("[QuestEngine] Failed to load event tasks for event sync:", (err as Error).message);
    return [];
  });
  const matchingTasks = tasks.filter((task) => task.config.scheduledEventId === event.id);

  for (const task of matchingTasks) {
    const syncedTask = await syncTaskQuestFromEvent(task, event);
    const channel = event.channelId
      ? await client.channels.fetch(event.channelId).catch(() => null)
      : await client.channels.fetch(syncedTask.config.eventChannelId).catch(() => null);
    if (!channelIsVoiceLike(channel)) continue;

    const running = eventStatusAllowsAttendance(event.status) &&
      questWindowAllowsCompletion(syncedTask.quest, Date.now(), { ignoreStart: event.status === GuildScheduledEventStatus.Active });
    const accrualEndMs = questWindowEndMs(syncedTask.quest);

    for (const [userId, member] of channel.members) {
      if (member.user.bot) continue;
      await updateConnectedAttendance(client, syncedTask, userId, {
        running,
        allowStart: running,
        accrualEndMs,
      });
    }
  }
}
