import {
  ChannelType,
  EmbedBuilder,
  GuildScheduledEventStatus,
  type Client,
  type GuildBasedChannel,
  type VoiceBasedChannel,
  type VoiceState,
} from "discord.js";
import { supabase } from "./db.js";
import { formatSats } from "./format.js";
import { registerDepositAddress } from "./evm.js";
import { sendTransferReceivedDm } from "./notifications.js";

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
const QUEST_COLOR = 0x8ab4ff;

function nowIso(): string {
  return new Date().toISOString();
}

function channelIsVoiceLike(channel: GuildBasedChannel | null): channel is VoiceBasedChannel {
  return channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice;
}

function eventWindowAllowsAttendance(quest: EventQuestRow, now = Date.now()): boolean {
  const startMs = quest.scheduled_start_at ? Date.parse(quest.scheduled_start_at) : null;
  const endMs = quest.scheduled_end_at ? Date.parse(quest.scheduled_end_at) : null;

  if (startMs != null && Number.isFinite(startMs) && now < startMs) return false;
  if (endMs != null && Number.isFinite(endMs) && now > endMs) return false;
  return true;
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

async function startAttendance(quest: EventQuestRow, userId: string): Promise<void> {
  if (!eventWindowAllowsAttendance(quest)) return;

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

async function stopAttendance(client: Client, quest: EventQuestRow, userId: string): Promise<void> {
  const { data: row, error } = await supabase
    .from("event_quest_attendance")
    .select("joined_at, accumulated_seconds, rewarded_at")
    .eq("quest_id", quest.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !row || row.rewarded_at || !row.joined_at) return;

  const joinedMs = Date.parse(row.joined_at as string);
  const elapsedSeconds = Number.isFinite(joinedMs)
    ? Math.max(0, Math.floor((Date.now() - joinedMs) / 1000))
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

  await tryAwardQuest(client, quest, userId);
}

async function updateConnectedAttendance(client: Client, quest: EventQuestRow, userId: string): Promise<void> {
  if (!eventWindowAllowsAttendance(quest)) {
    await stopAttendance(client, quest, userId);
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
    await startAttendance(quest, userId);
    return;
  }
  if (!row.joined_at) return;

  const joinedMs = Date.parse(row.joined_at as string);
  if (!Number.isFinite(joinedMs)) return;

  const accumulated = Math.max(
    0,
    (row.accumulated_seconds as number) + Math.floor((Date.now() - joinedMs) / 1000),
  );

  if (accumulated < quest.min_minutes * 60) {
    await supabase
      .from("event_quest_attendance")
      .update({ last_seen_at: nowIso() })
      .eq("quest_id", quest.id)
      .eq("user_id", userId)
      .is("rewarded_at", null);
    return;
  }

  await supabase
    .from("event_quest_attendance")
    .update({
      accumulated_seconds: accumulated,
      joined_at: nowIso(),
      last_seen_at: nowIso(),
    })
    .eq("quest_id", quest.id)
    .eq("user_id", userId)
    .is("rewarded_at", null);

  await tryAwardQuest(client, quest, userId);
}

export function buildEventQuestEmbed(quest: EventQuestRow): EmbedBuilder {
  const starts = quest.scheduled_start_at
    ? `<t:${Math.floor(Date.parse(quest.scheduled_start_at) / 1000)}:f>`
    : "Unknown";
  const capLine = quest.max_rewards === null
    ? "No cap while creator balance is funded"
    : `${quest.rewards_count}/${quest.max_rewards} rewards used`;
  const completedLine = `Quest completed ${quest.rewards_count} time${quest.rewards_count === 1 ? "" : "s"}.`;

  return new EmbedBuilder()
    .setColor(QUEST_COLOR)
    .setTitle(`❄️ ${quest.event_name}`)
    .setDescription(
      [
        `Stay connected to <#${quest.event_channel_id}> for **${quest.min_minutes} minute${quest.min_minutes === 1 ? "" : "s"}**.`,
        "",
        "Rewards:",
        `↳ **${formatSats(quest.reward_sats)}** ⚡ Per Person`,
        "",
        "Requirements:",
        `↳ Join the event voice/stage channel for the full duration`,
        "",
        completedLine,
        "",
        "💎 Automatic Reward",
      ].join("\n"),
    )
    .addFields(
      { name: "Event", value: `[Open Event](https://discord.com/events/${quest.guild_id}/${quest.scheduled_event_id})`, inline: true },
      { name: "Starts", value: starts, inline: true },
      { name: "Reward Cap", value: capLine, inline: true },
    )
    .setFooter({ text: "⚡ Powered by MezoSbot" })
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

  const embed = buildEventQuestEmbed(quest);
  const guild = await client.guilds.fetch(quest.guild_id).catch(() => null);
  const event = await guild?.scheduledEvents.fetch(quest.scheduled_event_id).catch(() => null);
  const thumbnail = event?.coverImageURL({ size: 256 });
  if (thumbnail) embed.setThumbnail(thumbnail);

  const message = await channel.messages.fetch(messageId).catch(() => null);
  await message?.edit({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

async function tryAwardQuest(client: Client, quest: EventQuestRow, userId: string): Promise<void> {
  const { data: awarded, error } = await supabase.rpc("claim_event_quest_reward", {
    p_quest_id: quest.id,
    p_user_id: userId,
  });

  if (error) {
    console.warn(`[Quest] Failed to claim reward for quest ${quest.id}:`, error.message);
    return;
  }
  if (awarded !== true) return;

  await registerDepositAddress(userId).catch(() => {});
  await sendTransferReceivedDm({
    client,
    recipientId: userId,
    senderId: quest.creator_id,
    amountSats: quest.reward_sats,
    kind: "quest",
    customMessage: `Completed event quest: ${quest.event_name}`,
  });

  const channel = await client.channels.fetch(quest.channel_id).catch(() => null);
  if (channel && "send" in channel) {
    const embed = new EmbedBuilder()
      .setColor(0x00cc6a)
      .setTitle("Quest Reward Earned")
      .setDescription(`<@${userId}> earned **${formatSats(quest.reward_sats)}** for attending **${quest.event_name}**.`)
      .setTimestamp();

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
  }

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
    await Promise.all(leavingQuests.map((quest) => stopAttendance(client, quest, userId)));
  }

  if (newState.guild.id && newState.channelId) {
    const joiningQuests = await getActiveQuestsForChannel(newState.guild.id, newState.channelId);
    await Promise.all(joiningQuests.map((quest) => startAttendance(quest, userId)));
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
    if (quest.scheduled_end_at && Date.now() > Date.parse(quest.scheduled_end_at)) {
      await supabase
        .from("event_quests")
        .update({ status: "completed", completed_at: nowIso() })
        .eq("id", quest.id)
        .eq("status", "active");
      continue;
    }

    const guild = await client.guilds.fetch(quest.guild_id).catch(() => null);
    if (!guild) continue;

    const freshEvent = await guild.scheduledEvents.fetch(quest.scheduled_event_id).catch(() => null);
    if (freshEvent?.status === GuildScheduledEventStatus.Completed || freshEvent?.status === GuildScheduledEventStatus.Canceled) {
      await supabase
        .from("event_quests")
        .update({ status: "completed", completed_at: nowIso() })
        .eq("id", quest.id)
        .eq("status", "active");
      continue;
    }

    const channel = await guild.channels.fetch(quest.event_channel_id).catch(() => null);
    if (!channelIsVoiceLike(channel)) continue;

    for (const [userId, member] of channel.members) {
      if (member.user.bot) continue;
      await updateConnectedAttendance(client, quest, userId);
    }
  }
}
