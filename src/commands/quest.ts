import {
  GuildScheduledEventEntityType,
  GuildScheduledEventStatus,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildScheduledEvent,
} from "discord.js";
import { getBalance } from "../balance.js";
import { supabase } from "../db.js";
import { formatSats, roundSats } from "../format.js";
import { buildEventQuestEmbed, type EventQuestRow } from "../eventQuests.js";
import { createQuestDefinition } from "../quests/engine.js";

export const data = {
  name: "quest",
  description: "Create event attendance quests that reward sats",
  options: [
    {
      name: "create",
      type: 1 as const,
      description: "Reward users for attending a Discord event",
      options: [
        { name: "event", type: 3 as const, description: "Discord scheduled event", required: true, autocomplete: true },
        { name: "reward", type: 10 as const, description: "Sats each qualifying attendee receives", required: true, minValue: 0.000001 },
        { name: "min_minutes", type: 4 as const, description: "Minutes the user must stay connected", required: true, minValue: 1, maxValue: 1440 },
        { name: "max_rewards", type: 4 as const, description: "Optional cap on total rewarded users", required: false, minValue: 1, maxValue: 10000 },
      ],
    },
  ],
};

function eventIsVoiceLike(event: GuildScheduledEvent): boolean {
  return event.entityType === GuildScheduledEventEntityType.StageInstance ||
    event.entityType === GuildScheduledEventEntityType.Voice;
}

async function getSelectableEvents(interaction: AutocompleteInteraction | ChatInputCommandInteraction) {
  if (!interaction.guild) return [];

  const events = await interaction.guild.scheduledEvents.fetch().catch(() => null);
  if (!events) return [];

  return [...events.values()]
    .filter((event) =>
      event.channelId &&
      eventIsVoiceLike(event) &&
      (event.status === GuildScheduledEventStatus.Scheduled || event.status === GuildScheduledEventStatus.Active)
    )
    .sort((a, b) => (a.scheduledStartTimestamp ?? 0) - (b.scheduledStartTimestamp ?? 0));
}

export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const events = await getSelectableEvents(interaction);

  const choices = events
    .filter((event) => event.name.toLowerCase().includes(focused) || event.id.includes(focused))
    .slice(0, 25)
    .map((event) => {
      const starts = event.scheduledStartAt
        ? event.scheduledStartAt.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
        : "unscheduled";
      return {
        name: `${event.name} - ${starts}`.slice(0, 100),
        value: event.id,
      };
    });

  await interaction.respond(choices);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "Quest creation only works in servers.", flags: MessageFlags.Ephemeral });
  }

  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand !== "create") {
    return interaction.reply({ content: "Unknown quest command.", flags: MessageFlags.Ephemeral });
  }

  const eventId = interaction.options.getString("event", true);
  const reward = roundSats(interaction.options.getNumber("reward", true));
  const minMinutes = interaction.options.getInteger("min_minutes", true);
  const maxRewards = interaction.options.getInteger("max_rewards");

  if (reward <= 0) {
    return interaction.reply({ content: "Reward must be greater than zero.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();

  const event = await interaction.guild.scheduledEvents.fetch(eventId).catch(() => null);
  if (!event) {
    return interaction.editReply({ content: "I could not find that scheduled event." });
  }
  if (!event.channelId || !eventIsVoiceLike(event)) {
    return interaction.editReply({ content: "That event is not attached to a voice or stage channel." });
  }
  if (event.status !== GuildScheduledEventStatus.Scheduled && event.status !== GuildScheduledEventStatus.Active) {
    return interaction.editReply({ content: "That event is not scheduled or active anymore." });
  }

  const balance = await getBalance(interaction.user.id);
  if (balance < reward) {
    return interaction.editReply({ content: "Insufficient balance to fund even one quest reward." });
  }

  if (maxRewards !== null && balance < roundSats(reward * maxRewards)) {
    return interaction.editReply({
      content: `Insufficient balance for ${maxRewards} rewards (${formatSats(roundSats(reward * maxRewards))}).`,
    });
  }

  const { data: inserted, error } = await supabase
    .from("event_quests")
    .insert({
      guild_id: interaction.guild.id,
      channel_id: interaction.channelId,
      creator_id: interaction.user.id,
      scheduled_event_id: event.id,
      event_name: event.name,
      event_channel_id: event.channelId,
      reward_sats: reward,
      min_minutes: minMinutes,
      max_rewards: maxRewards,
      scheduled_start_at: event.scheduledStartAt?.toISOString() ?? null,
      scheduled_end_at: event.scheduledEndAt?.toISOString() ?? null,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    if (error) console.warn("[Quest] Failed to insert event quest:", error.message);
    return interaction.editReply({ content: "Failed to create the quest." });
  }

  createQuestDefinition({
    guildId: interaction.guild.id,
    channelId: interaction.channelId,
    creatorId: interaction.user.id,
    title: event.name,
    description: `Attend ${event.name} for ${minMinutes} minute${minMinutes === 1 ? "" : "s"}.`,
    startsAt: event.scheduledStartAt?.toISOString() ?? null,
    endsAt: event.scheduledEndAt?.toISOString() ?? null,
    metadata: {
      legacyEventQuestId: inserted.id,
      scheduledEventId: event.id,
    },
    tasks: [
      {
        taskKey: "event_attendance",
        type: "event_attendance",
        title: "Attend event",
        description: `Stay connected to <#${event.channelId}> for ${minMinutes} minute${minMinutes === 1 ? "" : "s"}.`,
        config: {
          scheduledEventId: event.id,
          eventChannelId: event.channelId,
          minMinutes,
        },
      },
    ],
    rewardTiers: [
      {
        completedTaskCount: 1,
        rewardSats: reward,
      },
    ],
  }).catch((err) => {
    console.warn("[QuestEngine] Failed to mirror event quest:", (err as Error)?.message ?? err);
  });

  const quest: EventQuestRow = {
    id: inserted.id,
    guild_id: interaction.guild.id,
    channel_id: interaction.channelId,
    message_id: null,
    creator_id: interaction.user.id,
    scheduled_event_id: event.id,
    event_name: event.name,
    event_channel_id: event.channelId,
    reward_sats: reward,
    min_minutes: minMinutes,
    max_rewards: maxRewards,
    rewards_count: 0,
    status: "active",
    scheduled_start_at: event.scheduledStartAt?.toISOString() ?? null,
    scheduled_end_at: event.scheduledEndAt?.toISOString() ?? null,
  };

  const thumbnail = event.coverImageURL({ size: 256 });
  const embed = buildEventQuestEmbed(quest);
  if (thumbnail) embed.setThumbnail(thumbnail);

  const reply = await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });

  const { error: messageUpdateError } = await supabase
    .from("event_quests")
    .update({ message_id: reply.id })
    .eq("id", quest.id);

  if (messageUpdateError) {
    console.warn("[Quest] Failed to store quest message id:", messageUpdateError.message);
  }
}
