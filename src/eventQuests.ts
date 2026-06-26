import {
  ChannelType,
  EmbedBuilder,
  GuildScheduledEventStatus,
  type Client,
  type Guild,
  type GuildScheduledEvent,
  type PartialGuildScheduledEvent,
  type VoiceBasedChannel,
  type VoiceState,
} from "discord.js";
import { supabase } from "./db.js";
import { formatSats } from "./format.js";
import { recordLedgerEntry } from "./ledger.js";
import { registerDepositAddress } from "./evm.js";
import { sendTransferReceivedDm } from "./notifications.js";
import { getSatsMultiplier, type SatsMultiplier } from "./multi.js";

export type EventQuestRow = {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  creator_id: string;
  scheduled_event_id: string;
  event_name: string;
  event_channel_id: string;
  reward_sats: number;
  min_minutes: number;
  max_rewards: number | null;
  rewards_count: number;
  status: string;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
};

const SWEEP_MS = 60_000;
const QUEST_COLOR = 0x77a7ff;

function nowIso(): string {
  return new Date().toISOString();
}

function channelIsVoiceLike(channel: unknown): channel is VoiceBasedChannel {
  return !!channel &&
    typeof channel === "object" &&
    "type" in channel &&
    (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice);
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

function eventWindowAllowsAttendance(
  quest: EventQuestRow,
  now = Date.now(),
  options: { ignoreStart?: boolean } = {},
): boolean {
  const startMs = quest.scheduled_start_at ? Date.parse(quest.scheduled_start_at) : null;
  const endMs = quest.scheduled_end_at ? Date.parse(quest.scheduled_end_at) : null;

  if (!options.ignoreStart && startMs != null && Number.isFinite(startMs) && now < startMs) return false;
  if (endMs != null && Number.isFinite(endMs) && now > endMs) return false;
  return true;
}

function eventWindowEndMs(quest: EventQuestRow, fallback = Date.now()): number {
  const endMs = quest.scheduled_end_at ? Date.parse(quest.scheduled_end_at) : null;
  return endMs != null && Number.isFinite(endMs) ? Math.min(fallback, endMs) : fallback;
}

function eventStatusAllowsAttendance(status: GuildScheduledEventStatus | null | undefined): boolean {
  return status === GuildScheduledEventStatus.Active;
}

async function eventIsRunning(client: Client, quest: EventQuestRow): Promise<boolean> {
  const guild = await client.guilds.fetch(quest.guild_id).catch(() => null);
  const event = guild ? await fetchScheduledEventWithUserCount(guild, quest.scheduled_event_id) : null;
  if (!event) return false;
  if (event.status === GuildScheduledEventStatus.Completed || event.status === GuildScheduledEventStatus.Canceled) {
    return false;
  }

  const syncedQuest = await syncQuestFromEvent(quest, event);
  Object.assign(quest, syncedQuest);
  return eventWindowAllowsAttendance(syncedQuest, Date.now(), { ignoreStart: true });
}

async function fetchScheduledEventWithUserCount(
  guild: Guild,
  scheduledEventId: string,
): Promise<GuildScheduledEvent | null> {
  return guild.scheduledEvents
    .fetch({ guildScheduledEvent: scheduledEventId, withUserCount: true })
    .catch(() => null);
}

async function syncQuestFromEvent(quest: EventQuestRow, event: GuildScheduledEvent): Promise<EventQuestRow> {
  const next: EventQuestRow = {
    ...quest,
    event_name: event.name,
    event_channel_id: event.channelId ?? quest.event_channel_id,
    scheduled_start_at: effectiveEventStartIso(event, quest.scheduled_start_at),
    scheduled_end_at: event.scheduledEndAt?.toISOString() ?? null,
  };

  const changed =
    next.event_name !== quest.event_name ||
    next.event_channel_id !== quest.event_channel_id ||
    next.scheduled_start_at !== quest.scheduled_start_at ||
    next.scheduled_end_at !== quest.scheduled_end_at;

  if (changed) {
    const { error } = await supabase
      .from("event_quests")
      .update({
        event_name: next.event_name,
        event_channel_id: next.event_channel_id,
        scheduled_start_at: next.scheduled_start_at,
        scheduled_end_at: next.scheduled_end_at,
      })
      .eq("id", quest.id);

    if (error) console.warn(`[Quest] Failed to sync event quest ${quest.id}:`, error.message);
  }

  return next;
}

async function getActiveQuestsForChannel(guildId: string, channelId: string): Promise<EventQuestRow[]> {
  const { data, error } = await supabase
    .from("event_quests")
    .select("*")
    .eq("status", "active")
    .eq("guild_id", guildId)
    .eq("event_channel_id", channelId);

  if (error) {
    console.warn("[Quest] Failed to load active quests:", error.message);
    return [];
  }

  return (data ?? []) as EventQuestRow[];
}

async function startAttendance(
  quest: EventQuestRow,
  userId: string,
  options: { ignoreStart?: boolean } = {},
): Promise<void> {
  if (!eventWindowAllowsAttendance(quest, Date.now(), options)) return;

  const joinedAt = nowIso();

  const { data: existing, error: readError } = await supabase
    .from("event_quest_attendance")
    .select("joined_at, rewarded_at")
    .eq("quest_id", quest.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    console.warn(`[Quest] Failed to read attendance for quest ${quest.id}:`, readError.message);
    return;
  }
  if (existing?.rewarded_at || existing?.joined_at) return;

  if (existing) {
    const { error } = await supabase
      .from("event_quest_attendance")
      .update({
        joined_at: joinedAt,
        last_seen_at: joinedAt,
      })
      .eq("quest_id", quest.id)
      .eq("user_id", userId)
      .is("rewarded_at", null);

    if (error) {
      console.warn(`[Quest] Failed to restart attendance for quest ${quest.id}:`, error.message);
    }
    return;
  }

  const { error } = await supabase
    .from("event_quest_attendance")
    .insert({
      quest_id: quest.id,
      user_id: userId,
      joined_at: joinedAt,
      last_seen_at: joinedAt,
    });

  if (error) {
    console.warn(`[Quest] Failed to start attendance for quest ${quest.id}:`, error.message);
  }
}

async function stopAttendance(
  client: Client,
  quest: EventQuestRow,
  userId: string,
  multiplier: SatsMultiplier = 1,
  accrualEndMs = eventWindowEndMs(quest),
): Promise<void> {
  const { data: row, error } = await supabase
    .from("event_quest_attendance")
    .select("joined_at, accumulated_seconds, rewarded_at")
    .eq("quest_id", quest.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !row || row.rewarded_at || !row.joined_at) return;

  const joinedMs = Date.parse(row.joined_at as string);
  const elapsedSeconds = Number.isFinite(joinedMs)
    ? Math.max(0, Math.floor((accrualEndMs - joinedMs) / 1000))
    : 0;
  const accumulated = Math.max(0, (row.accumulated_seconds as number) + elapsedSeconds);

  await supabase
    .from("event_quest_attendance")
    .update({
      joined_at: null,
      accumulated_seconds: accumulated,
      last_seen_at: nowIso(),
    })
    .eq("quest_id", quest.id)
    .eq("user_id", userId)
    .is("rewarded_at", null);

  await tryAwardQuest(client, quest, userId, multiplier);
}

async function updateConnectedAttendance(
  client: Client,
  quest: EventQuestRow,
  userId: string,
  options: { running: boolean; allowStart?: boolean; accrualEndMs?: number; multiplier?: SatsMultiplier },
): Promise<void> {
  const accrualEndMs = eventWindowEndMs(quest, options.accrualEndMs ?? Date.now());
  if (!options.running || !eventWindowAllowsAttendance(quest, accrualEndMs, { ignoreStart: options.running })) {
    await stopAttendance(client, quest, userId, options.multiplier ?? 1, accrualEndMs);
    return;
  }

  const { data: row, error } = await supabase
    .from("event_quest_attendance")
    .select("joined_at, accumulated_seconds, rewarded_at")
    .eq("quest_id", quest.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error || row?.rewarded_at) return;
  if (!row) {
    if (options.allowStart !== false) await startAttendance(quest, userId, { ignoreStart: options.running });
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
    .from("event_quest_attendance")
    .update({
      accumulated_seconds: accumulated,
      joined_at: nowIso(),
      last_seen_at: nowIso(),
    })
    .eq("quest_id", quest.id)
    .eq("user_id", userId)
    .is("rewarded_at", null);

  if (updateError) {
    console.warn(`[Quest] Failed to update attendance for quest ${quest.id}:`, updateError.message);
    return;
  }

  if (accumulated >= quest.min_minutes * 60) {
    await tryAwardQuest(client, quest, userId, options.multiplier ?? 1);
  }
}

export function buildEventQuestEmbed(quest: EventQuestRow): EmbedBuilder {
  const cleanEventUrl = `https://discord.com/events/${quest.guild_id}/${quest.scheduled_event_id}`;
  const cleanStartsRelative = quest.scheduled_start_at
    ? `<t:${Math.floor(Date.parse(quest.scheduled_start_at) / 1000)}:R>`
    : "Unknown";
  const cleanMinutes = `${quest.min_minutes} minute${quest.min_minutes === 1 ? "" : "s"}`;

  return new EmbedBuilder()
    .setColor(QUEST_COLOR)
    .setTitle(`❄️ ${quest.event_name}`)
    .setURL(cleanEventUrl)
    .setDescription(
      [
        "A live event quest is open.",
        "",
        `Join the event voice channel, stay for **${cleanMinutes}**, and the sats land automatically.`,
        "",
        `Starts ${cleanStartsRelative}.`,
      ].join("\n"),
    )
    .addFields(
      { name: "Rewards:", value: `↳ **${formatSats(quest.reward_sats)}** ⚡ Per Person`, inline: false },
      { name: "Requirements:", value: `↳ Join <#${quest.event_channel_id}> for **${cleanMinutes}**`, inline: false },
      { name: "Event", value: `[Open Discord Event](${cleanEventUrl})`, inline: true },
    )
    .setFooter({ text: "⚡ Powered by matsFi" })
    .setTimestamp();

}
async function refreshQuestMessage(client: Client, questId: number): Promise<void> {
  const { data, error } = await supabase
    .from("event_quests")
    .select("*")
    .eq("id", questId)
    .maybeSingle();

  if (error || !data?.message_id) return;

  const quest = data as EventQuestRow;
  const messageId = data.message_id as string;
  const channel = await client.channels.fetch(quest.channel_id).catch(() => null);
  if (!channel || !("messages" in channel)) return;

  const guild = await client.guilds.fetch(quest.guild_id).catch(() => null);
  const event = guild ? await fetchScheduledEventWithUserCount(guild, quest.scheduled_event_id) : null;
  const syncedQuest = event ? await syncQuestFromEvent(quest, event) : quest;
  const embed = buildEventQuestEmbed(syncedQuest);
  const thumbnail = event?.coverImageURL({ size: 256 });
  if (thumbnail) embed.setThumbnail(thumbnail);

  const message = await channel.messages.fetch(messageId).catch(() => null);
  await message?.edit({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

async function tryAwardQuest(
  client: Client,
  quest: EventQuestRow,
  userId: string,
  multiplier: SatsMultiplier = 1,
): Promise<void> {
  const { data: awarded, error } = await supabase.rpc("claim_event_quest_reward", {
    p_quest_id: quest.id,
    p_user_id: userId,
    p_reward_multiplier: multiplier,
  });

  if (error) {
    console.warn(`[Quest] Failed to claim reward for quest ${quest.id}:`, error.message);
    return;
  }
  if (awarded !== true) return;
  const rewardAmount = quest.reward_sats * multiplier;

  recordLedgerEntry(client, {
    type: "event_quest_reward",
    amountSats: rewardAmount,
    senderId: quest.creator_id,
    receiverId: userId,
    guildId: quest.guild_id,
    referenceType: "event_quests",
    referenceId: String(quest.id),
    metadata: { event_name: quest.event_name },
  });

  await registerDepositAddress(userId).catch(() => {});
  await sendTransferReceivedDm({
    client,
    recipientId: userId,
    senderId: quest.creator_id,
    amountSats: rewardAmount,
    kind: "quest",
    customMessage: `Completed event quest: ${quest.event_name}`,
  });

  await refreshQuestMessage(client, quest.id);
}

export async function handleQuestVoiceStateUpdate(
  client: Client,
  oldState: VoiceState,
  newState: VoiceState,
): Promise<void> {
  const userId = newState.id;
  if (newState.member?.user.bot || oldState.member?.user.bot) return;
  if (oldState.channelId === newState.channelId) return;

  if (oldState.guild.id && oldState.channelId) {
    const leavingQuests = await getActiveQuestsForChannel(oldState.guild.id, oldState.channelId);
    const multiplier = getSatsMultiplier(oldState.member?.roles.cache.keys());
    await Promise.all(leavingQuests.map((quest) => stopAttendance(client, quest, userId, multiplier)));
  }

  if (newState.guild.id && newState.channelId) {
    const joiningQuests = await getActiveQuestsForChannel(newState.guild.id, newState.channelId);
    await Promise.all(
      joiningQuests.map(async (quest) => {
        if (await eventIsRunning(client, quest)) await startAttendance(quest, userId, { ignoreStart: true });
      }),
    );
  }
}

export function startEventQuestSweeper(client: Client): void {
  setInterval(() => {
    sweepEventQuests(client).catch((err) =>
      console.warn("[Quest] Sweeper failed:", (err as Error)?.message ?? err)
    );
  }, SWEEP_MS);
}

async function sweepEventQuests(client: Client): Promise<void> {
  const { data, error } = await supabase
    .from("event_quests")
    .select("*")
    .eq("status", "active");

  if (error) {
    console.warn("[Quest] Failed to sweep quests:", error.message);
    return;
  }

  const quests = (data ?? []) as EventQuestRow[];

  for (const quest of quests) {
    const guild = await client.guilds.fetch(quest.guild_id).catch(() => null);
    if (!guild) continue;

    const freshEvent = await fetchScheduledEventWithUserCount(guild, quest.scheduled_event_id);
    const syncedQuest = freshEvent ? await syncQuestFromEvent(quest, freshEvent) : quest;
    const channel = await guild.channels.fetch(syncedQuest.event_channel_id).catch(() => null);
    const isVoiceChannel = channelIsVoiceLike(channel);
    const scheduledEndMs = syncedQuest.scheduled_end_at ? Date.parse(syncedQuest.scheduled_end_at) : null;
    const endedByTime = scheduledEndMs != null && Number.isFinite(scheduledEndMs) && Date.now() > scheduledEndMs;
    const endedByStatus =
      freshEvent?.status === GuildScheduledEventStatus.Completed ||
      freshEvent?.status === GuildScheduledEventStatus.Canceled;

    if (endedByTime || endedByStatus) {
      if (isVoiceChannel) {
        const accrualEndMs = eventWindowEndMs(syncedQuest);
        for (const [userId, member] of channel.members) {
          if (member.user.bot) continue;
          await updateConnectedAttendance(client, syncedQuest, userId, {
            running: true,
            allowStart: false,
            accrualEndMs,
            multiplier: getSatsMultiplier(member.roles.cache.keys()),
          });
        }
      }

      await supabase
        .from("event_quests")
        .update({ status: "completed", completed_at: nowIso() })
        .eq("id", quest.id)
        .eq("status", "active");
      await refreshQuestMessage(client, quest.id);
      continue;
    }

    if (
      !eventStatusAllowsAttendance(freshEvent?.status) ||
      !eventWindowAllowsAttendance(syncedQuest, Date.now(), { ignoreStart: freshEvent?.status === GuildScheduledEventStatus.Active })
    ) continue;
    if (!isVoiceChannel) continue;

    for (const [userId, member] of channel.members) {
      if (member.user.bot) continue;
      await updateConnectedAttendance(client, syncedQuest, userId, {
        running: true,
        multiplier: getSatsMultiplier(member.roles.cache.keys()),
      });
    }
  }
}

export async function handleEventQuestScheduledEventUpdate(
  client: Client,
  event: GuildScheduledEvent,
): Promise<void> {
  if (!event.guildId) return;

  const { data, error } = await supabase
    .from("event_quests")
    .select("*")
    .eq("status", "active")
    .eq("guild_id", event.guildId)
    .eq("scheduled_event_id", event.id);

  if (error) {
    console.warn("[Quest] Failed to load quests for event sync:", error.message);
    return;
  }

  for (const quest of (data ?? []) as EventQuestRow[]) {
    const syncedQuest = await syncQuestFromEvent(quest, event);
    const channel = event.channelId
      ? await client.channels.fetch(event.channelId).catch(() => null)
      : await client.channels.fetch(syncedQuest.event_channel_id).catch(() => null);
    if (!channelIsVoiceLike(channel)) continue;

    const running = eventStatusAllowsAttendance(event.status) &&
      eventWindowAllowsAttendance(syncedQuest, Date.now(), { ignoreStart: event.status === GuildScheduledEventStatus.Active });
    const accrualEndMs = eventWindowEndMs(syncedQuest);

    for (const [userId, member] of channel.members) {
      if (member.user.bot) continue;
      await updateConnectedAttendance(client, syncedQuest, userId, {
        running,
        allowStart: running,
        accrualEndMs,
        multiplier: getSatsMultiplier(member.roles.cache.keys()),
      });
    }
    await refreshQuestMessage(client, syncedQuest.id);
  }
}

export async function handleEventQuestScheduledEventUserChange(
  client: Client,
  event: GuildScheduledEvent | PartialGuildScheduledEvent,
): Promise<void> {
  if (!event.guildId) return;

  const { data, error } = await supabase
    .from("event_quests")
    .select("id")
    .eq("status", "active")
    .eq("guild_id", event.guildId)
    .eq("scheduled_event_id", event.id);

  if (error) {
    console.warn("[Quest] Failed to load quests for event participant sync:", error.message);
    return;
  }

  await Promise.all((data ?? []).map((quest) => refreshQuestMessage(client, quest.id as number)));
}
