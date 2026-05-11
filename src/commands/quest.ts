import {
  ChannelType,
  EmbedBuilder,
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
import {
  addQuestTask,
  createQuestDefinition,
  createQuestDraft,
  getQuestSnapshot,
  getQuestTaskDefinition,
  listQuestTaskDefinitions,
  publishQuest,
  type QuestSnapshot,
} from "../quests/engine.js";

export const data = {
  name: "quest",
  description: "Create and manage sats quests",
  options: [
    {
      name: "create_event",
      type: 1 as const,
      description: "Quick create: reward users for attending a Discord event",
      options: [
        { name: "event", type: 3 as const, description: "Discord scheduled event", required: true, autocomplete: true },
        { name: "reward", type: 10 as const, description: "Sats each qualifying attendee receives", required: true, minValue: 0.000001 },
        { name: "min_minutes", type: 4 as const, description: "Minutes the user must stay connected", required: true, minValue: 1, maxValue: 1440 },
        { name: "max_rewards", type: 4 as const, description: "Optional cap on total rewarded users", required: false, minValue: 1, maxValue: 10000 },
      ],
    },
    {
      name: "draft",
      type: 1 as const,
      description: "Start a multistep quest draft with tiered sats rewards",
      options: [
        { name: "title", type: 3 as const, description: "Quest title", required: true, maxLength: 100 },
        { name: "reward_1", type: 10 as const, description: "Total sats after 1 task", required: true, minValue: 0.000001 },
        { name: "description", type: 3 as const, description: "Short quest description", required: false, maxLength: 500 },
        { name: "reward_2", type: 10 as const, description: "Total sats after 2 tasks", required: false, minValue: 0.000001 },
        { name: "reward_3", type: 10 as const, description: "Total sats after 3 tasks", required: false, minValue: 0.000001 },
        { name: "reward_4", type: 10 as const, description: "Total sats after 4 tasks", required: false, minValue: 0.000001 },
      ],
    },
    {
      name: "add_event_task",
      type: 1 as const,
      description: "Add an event attendance task to a draft",
      options: [
        { name: "quest_id", type: 4 as const, description: "Draft quest ID", required: true, minValue: 1 },
        { name: "event", type: 3 as const, description: "Discord scheduled event", required: true, autocomplete: true },
        { name: "min_minutes", type: 4 as const, description: "Minutes required in the event channel", required: true, minValue: 1, maxValue: 1440 },
      ],
    },
    {
      name: "add_link_task",
      type: 1 as const,
      description: "Add a first-link recurring task to a draft",
      options: [
        { name: "quest_id", type: 4 as const, description: "Draft quest ID", required: true, minValue: 1 },
        { name: "target_channel", type: 7 as const, description: "Channel where users must post the link", required: true, channelTypes: [ChannelType.GuildText] },
        {
          name: "source",
          type: 3 as const,
          description: "Which link source to use",
          required: true,
          choices: [
            { name: "Latest admin Twitter feed link", value: "latest_tweet" },
            { name: "Nearest Discord event link", value: "nearest_event" },
          ],
        },
        { name: "refresh_minutes", type: 4 as const, description: "Winner window refresh duration", required: true, minValue: 1, maxValue: 1440 },
      ],
    },
    {
      name: "preview",
      type: 1 as const,
      description: "Preview a multistep quest draft or published quest",
      options: [
        { name: "quest_id", type: 4 as const, description: "Quest ID", required: true, minValue: 1 },
      ],
    },
    {
      name: "publish",
      type: 1 as const,
      description: "Publish a draft quest to this channel",
      options: [
        { name: "quest_id", type: 4 as const, description: "Draft quest ID", required: true, minValue: 1 },
      ],
    },
    {
      name: "presets",
      type: 1 as const,
      description: "List available task presets",
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
  if (subcommand === "create_event") return createEventQuest(interaction);
  if (subcommand === "draft") return createDraft(interaction);
  if (subcommand === "add_event_task") return addEventTask(interaction);
  if (subcommand === "add_link_task") return addLinkTask(interaction);
  if (subcommand === "preview") return previewQuest(interaction, true);
  if (subcommand === "publish") return publishDraft(interaction);
  if (subcommand === "presets") return listPresets(interaction);

  return interaction.reply({ content: "Unknown quest command.", flags: MessageFlags.Ephemeral });
}

function buildTierInputs(interaction: ChatInputCommandInteraction) {
  const tiers = [1, 2, 3, 4]
    .map((count) => {
      const reward = interaction.options.getNumber(`reward_${count}`);
      return reward == null ? null : { completedTaskCount: count, rewardSats: roundSats(reward) };
    })
    .filter((tier): tier is { completedTaskCount: number; rewardSats: number } => tier !== null);

  return tiers;
}

function buildQuestBuilderEmbed(snapshot: QuestSnapshot): EmbedBuilder {
  const taskLines = snapshot.tasks.length === 0
    ? ["No tasks yet."]
    : snapshot.tasks.map((task, index) => {
      const definition = getQuestTaskDefinition(task.type);
      const requirement = definition?.renderRequirement(task.config) ?? task.description ?? task.title;
      return `↳ **${index + 1}. ${task.title}**\n${requirement}`;
    });

  const tierLines = snapshot.tiers.map((tier) =>
    `↳ **${tier.completed_task_count} task${tier.completed_task_count === 1 ? "" : "s"}** → ${formatSats(tier.reward_sats)}`
  );

  const isDraft = snapshot.quest.status === "draft";
  const statusLine = isDraft
    ? "Draft mode. Add tasks, preview, then publish."
    : "Quest is live. Rewards are paid automatically as users complete tiers.";
  const embed = new EmbedBuilder()
    .setColor(isDraft ? 0xf0b232 : 0x77a7ff)
    .setTitle(`${isDraft ? "🛠️" : "❄️"} ${snapshot.quest.title}`)
    .setDescription(
      [
        snapshot.quest.description ?? "A multistep sats quest.",
        "",
        statusLine,
      ].join("\n"),
    )
    .addFields(
      { name: "Rewards:", value: tierLines.join("\n") || "No reward tiers set.", inline: false },
      { name: "Requirements:", value: taskLines.join("\n\n").slice(0, 1024), inline: false },
      { name: "Quest ID", value: `\`${snapshot.quest.id}\``, inline: true },
      { name: "Max Reward", value: `**${formatSats(snapshot.quest.max_reward_sats)}**`, inline: true },
      { name: "💎 Payout", value: "Automatic tier upgrade rewards", inline: true },
    )
    .setFooter({ text: "⚡ Powered by matsFi" })
    .setTimestamp();

  return embed;
}

async function createDraft(interaction: ChatInputCommandInteraction) {
  const title = interaction.options.getString("title", true).trim();
  const description = interaction.options.getString("description")?.trim() || null;
  const tiers = buildTierInputs(interaction);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const snapshot = await createQuestDraft({
      guildId: interaction.guild!.id,
      channelId: interaction.channelId,
      creatorId: interaction.user.id,
      title,
      description,
      rewardTiers: tiers,
    });

    await interaction.editReply({
      embeds: [buildQuestBuilderEmbed(snapshot)],
    });
  } catch (err) {
    await interaction.editReply({ content: `Could not create quest draft: ${(err as Error).message}` });
  }
}

async function addEventTask(interaction: ChatInputCommandInteraction) {
  const questId = interaction.options.getInteger("quest_id", true);
  const eventId = interaction.options.getString("event", true);
  const minMinutes = interaction.options.getInteger("min_minutes", true);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const event = await interaction.guild!.scheduledEvents.fetch(eventId).catch(() => null);
  if (!event?.channelId || !eventIsVoiceLike(event)) {
    return interaction.editReply({ content: "That event is not attached to a voice or stage channel." });
  }

  try {
    const snapshot = await addQuestTask({
      questId,
      creatorId: interaction.user.id,
      taskKey: `event_${event.id}`,
      type: "event_attendance",
      title: `Attend ${event.name}`,
      description: `Stay connected to <#${event.channelId}> for ${minMinutes} minute${minMinutes === 1 ? "" : "s"}.`,
      config: {
        scheduledEventId: event.id,
        eventChannelId: event.channelId,
        minMinutes,
      },
    });

    await interaction.editReply({ embeds: [buildQuestBuilderEmbed(snapshot)] });
  } catch (err) {
    await interaction.editReply({ content: `Could not add event task: ${(err as Error).message}` });
  }
}

async function addLinkTask(interaction: ChatInputCommandInteraction) {
  const questId = interaction.options.getInteger("quest_id", true);
  const channel = interaction.options.getChannel("target_channel", true);
  const source = interaction.options.getString("source", true);
  const refreshMinutes = interaction.options.getInteger("refresh_minutes", true);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const snapshot = await addQuestTask({
      questId,
      creatorId: interaction.user.id,
      taskKey: `first_link_${source}_${channel.id}`,
      type: "first_link_in_channel",
      title: source === "latest_tweet" ? "Share latest feed link" : "Share nearest event link",
      description: `Be first every ${refreshMinutes} minutes to post the configured link in <#${channel.id}>.`,
      config: {
        targetChannelId: channel.id,
        source,
        refreshMinutes,
      },
    });

    await interaction.editReply({ embeds: [buildQuestBuilderEmbed(snapshot)] });
  } catch (err) {
    await interaction.editReply({ content: `Could not add link task: ${(err as Error).message}` });
  }
}

async function previewQuest(interaction: ChatInputCommandInteraction, ephemeral: boolean) {
  const questId = interaction.options.getInteger("quest_id", true);
  await interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });

  const snapshot = await getQuestSnapshot(questId).catch((err) => {
    console.warn("[Quest] Preview failed:", (err as Error).message);
    return null;
  });
  if (!snapshot) return interaction.editReply({ content: "Quest not found." });

  await interaction.editReply({ embeds: [buildQuestBuilderEmbed(snapshot)] });
}

async function publishDraft(interaction: ChatInputCommandInteraction) {
  const questId = interaction.options.getInteger("quest_id", true);
  await interaction.deferReply();

  const initial = await getQuestSnapshot(questId).catch(() => null);
  if (!initial) return interaction.editReply({ content: "Quest not found." });
  if (initial.quest.creator_id !== interaction.user.id) {
    return interaction.editReply({ content: "Only the quest creator can publish this quest." });
  }

  const publishedEmbed = buildQuestBuilderEmbed({
    ...initial,
    quest: { ...initial.quest, status: "active" },
  });
  const message = await interaction.editReply({ embeds: [publishedEmbed], allowedMentions: { parse: [] } });

  try {
    const snapshot = await publishQuest({
      questId,
      creatorId: interaction.user.id,
      messageId: message.id,
    });

    await interaction.editReply({ embeds: [buildQuestBuilderEmbed(snapshot)], allowedMentions: { parse: [] } });
  } catch (err) {
    await interaction.editReply({ content: `Could not publish quest: ${(err as Error).message}` });
  }
}

async function listPresets(interaction: ChatInputCommandInteraction) {
  const lines = listQuestTaskDefinitions().map((definition) => `**${definition.label}**\n\`${definition.type}\``);
  const embed = new EmbedBuilder()
    .setColor(0x77a7ff)
    .setTitle("Quest Task Presets")
    .setDescription(lines.join("\n\n"))
    .setFooter({ text: "Use /quest draft, then add preset tasks." })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function createEventQuest(interaction: ChatInputCommandInteraction) {
  const eventId = interaction.options.getString("event", true);
  const reward = roundSats(interaction.options.getNumber("reward", true));
  const minMinutes = interaction.options.getInteger("min_minutes", true);
  const maxRewards = interaction.options.getInteger("max_rewards");

  if (reward <= 0) {
    return interaction.reply({ content: "Reward must be greater than zero.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();

  const event = await interaction.guild!.scheduledEvents.fetch(eventId).catch(() => null);
  if (!event) return interaction.editReply({ content: "I could not find that scheduled event." });
  if (!event.channelId || !eventIsVoiceLike(event)) {
    return interaction.editReply({ content: "That event is not attached to a voice or stage channel." });
  }
  if (event.status !== GuildScheduledEventStatus.Scheduled && event.status !== GuildScheduledEventStatus.Active) {
    return interaction.editReply({ content: "That event is not scheduled or active anymore." });
  }

  const balance = await getBalance(interaction.user.id);
  if (balance < reward) return interaction.editReply({ content: "Insufficient balance to fund even one quest reward." });

  if (maxRewards !== null && balance < roundSats(reward * maxRewards)) {
    return interaction.editReply({
      content: `Insufficient balance for ${maxRewards} rewards (${formatSats(roundSats(reward * maxRewards))}).`,
    });
  }

  const { data: inserted, error } = await supabase
    .from("event_quests")
    .insert({
      guild_id: interaction.guild!.id,
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
    guildId: interaction.guild!.id,
    channelId: interaction.channelId,
    creatorId: interaction.user.id,
    title: event.name,
    description: `Attend ${event.name} for ${minMinutes} minute${minMinutes === 1 ? "" : "s"}.`,
    startsAt: event.scheduledStartAt?.toISOString() ?? null,
    endsAt: event.scheduledEndAt?.toISOString() ?? null,
    metadata: { legacyEventQuestId: inserted.id, scheduledEventId: event.id },
    tasks: [
      {
        taskKey: "event_attendance",
        type: "event_attendance",
        title: "Attend event",
        description: `Stay connected to <#${event.channelId}> for ${minMinutes} minute${minMinutes === 1 ? "" : "s"}.`,
        config: { scheduledEventId: event.id, eventChannelId: event.channelId, minMinutes },
      },
    ],
    rewardTiers: [{ completedTaskCount: 1, rewardSats: reward }],
  }).catch((err) => {
    console.warn("[QuestEngine] Failed to mirror event quest:", (err as Error)?.message ?? err);
  });

  const quest: EventQuestRow = {
    id: inserted.id,
    guild_id: interaction.guild!.id,
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

  if (messageUpdateError) console.warn("[Quest] Failed to store quest message id:", messageUpdateError.message);
}
