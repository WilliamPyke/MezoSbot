import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  GuildScheduledEventEntityType,
  GuildScheduledEventStatus,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildScheduledEvent,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
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
import { completeAndNotify } from "../quests/runtime.js";

export const data = {
  name: "quest",
  description: "Create and manage sats quests",
  options: [
    {
      name: "create",
      type: 1 as const,
      description: "Open a guided event quest creator",
    },
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
      name: "complete_task",
      type: 1 as const,
      description: "Creator override: mark a quest task complete for a user",
      options: [
        { name: "quest_id", type: 4 as const, description: "Quest ID", required: true, minValue: 1 },
        { name: "task_key", type: 3 as const, description: "Task key from the quest preview", required: true, maxLength: 64 },
        { name: "user", type: 6 as const, description: "User who completed the task", required: true },
        { name: "note", type: 3 as const, description: "Optional proof note", required: false, maxLength: 300 },
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

const BUILDER_PREFIX = "qcreate";
const BUILDER_TTL_MS = 15 * 60_000;

type QuestBuilderSession = {
  id: string;
  guildId: string;
  channelId: string;
  creatorId: string;
  eventId: string | null;
  rewardSats: number | null;
  minMinutes: number | null;
  maxRewards: number | null;
  expiresAt: number;
};

const questBuilderSessions = new Map<string, QuestBuilderSession>();

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
  if (subcommand === "create") return startQuestBuilder(interaction);
  if (subcommand === "create_event") return createEventQuest(interaction);
  if (subcommand === "draft") return createDraft(interaction);
  if (subcommand === "add_event_task") return addEventTask(interaction);
  if (subcommand === "add_link_task") return addLinkTask(interaction);
  if (subcommand === "preview") return previewQuest(interaction, true);
  if (subcommand === "complete_task") return completeTaskOverride(interaction);
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

function cleanupQuestBuilderSessions() {
  const now = Date.now();
  for (const [id, session] of questBuilderSessions) {
    if (session.expiresAt <= now) questBuilderSessions.delete(id);
  }
}

function createBuilderSession(interaction: ChatInputCommandInteraction): QuestBuilderSession {
  cleanupQuestBuilderSessions();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const session: QuestBuilderSession = {
    id,
    guildId: interaction.guild!.id,
    channelId: interaction.channelId,
    creatorId: interaction.user.id,
    eventId: null,
    rewardSats: null,
    minMinutes: null,
    maxRewards: null,
    expiresAt: Date.now() + BUILDER_TTL_MS,
  };
  questBuilderSessions.set(id, session);
  return session;
}

function builderId(action: string, sessionId: string): string {
  return `${BUILDER_PREFIX}:${action}:${sessionId}`;
}

function parseBuilderId(customId: string): { action: string; sessionId: string } | null {
  const [prefix, action, sessionId] = customId.split(":");
  if (prefix !== BUILDER_PREFIX || !action || !sessionId) return null;
  return { action, sessionId };
}

function selectedLabel(value: string | number | null, fallback = "Not selected"): string {
  return value == null ? fallback : String(value);
}

async function resolveBuilderEvent(interaction: Interaction, session: QuestBuilderSession): Promise<GuildScheduledEvent | null> {
  if (!interaction.guild || !session.eventId) return null;
  return interaction.guild.scheduledEvents.fetch(session.eventId).catch(() => null);
}

async function buildQuestCreatorView(interaction: Interaction, session: QuestBuilderSession) {
  const event = await resolveBuilderEvent(interaction, session);
  const rewardLabel = session.rewardSats == null ? "Not selected" : formatSats(session.rewardSats);
  const maxLabel = session.maxRewards == null ? "No cap" : `${session.maxRewards} attendees`;
  const totalLabel = session.rewardSats == null
    ? "Set reward first"
    : session.maxRewards == null
      ? "Open-ended"
      : formatSats(roundSats(session.rewardSats * session.maxRewards));

  const embed = new EmbedBuilder()
    .setColor(0x77a7ff)
    .setTitle("Create Event Quest")
    .setDescription("Pick the event and reward settings, then confirm when the preview looks right.")
    .addFields(
      { name: "Event", value: event ? `${event.name}\n<#${event.channelId}>` : "Not selected", inline: false },
      { name: "Reward", value: rewardLabel, inline: true },
      { name: "Required time", value: `${selectedLabel(session.minMinutes)} minute${session.minMinutes === 1 ? "" : "s"}`, inline: true },
      { name: "Max rewards", value: maxLabel, inline: true },
      { name: "Total possible spend", value: totalLabel, inline: true },
    )
    .setFooter({ text: "This setup expires after 15 minutes." });

  if (event?.scheduledStartAt) {
    embed.addFields({
      name: "Scheduled start",
      value: `<t:${Math.floor(event.scheduledStartAt.getTime() / 1000)}:F>`,
      inline: false,
    });
  }

  const rows: Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> = [];

  const events = interaction.guild
    ? await getSelectableEvents(interaction as ChatInputCommandInteraction).catch(() => [])
    : [];
  if (events.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(builderId("event", session.id))
          .setPlaceholder(event ? event.name.slice(0, 100) : "Choose a scheduled event")
          .addOptions(
            events.slice(0, 25).map((candidate) => {
              const starts = candidate.scheduledStartAt
                ? candidate.scheduledStartAt.toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
                : "unscheduled";
              return {
                label: candidate.name.slice(0, 100),
                description: `${starts} in ${candidate.channel?.name ?? "event channel"}`.slice(0, 100),
                value: candidate.id,
                default: candidate.id === session.eventId,
              };
            }),
          ),
      ),
    );
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(builderId("details", session.id))
        .setLabel("Set details")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(builderId("confirm", session.id))
        .setLabel("Create")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!session.eventId || !session.rewardSats || !session.minMinutes),
      new ButtonBuilder()
        .setCustomId(builderId("cancel", session.id))
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    ),
  );

  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

async function startQuestBuilder(interaction: ChatInputCommandInteraction) {
  const session = createBuilderSession(interaction);
  await interaction.reply({
    ...(await buildQuestCreatorView(interaction, session)),
    flags: MessageFlags.Ephemeral,
  });
}

export function isQuestBuilderInteraction(interaction: Interaction): boolean {
  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    return interaction.customId.startsWith(`${BUILDER_PREFIX}:`);
  }
  return false;
}

export async function handleQuestBuilderInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isStringSelectMenu()) return handleQuestBuilderSelect(interaction);
  if (interaction.isButton()) return handleQuestBuilderButton(interaction);
  if (interaction.isModalSubmit()) return handleQuestBuilderModal(interaction);
}

function getBuilderSession(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction) {
  const parsed = parseBuilderId(interaction.customId);
  if (!parsed) return { parsed: null, session: null };

  const session = questBuilderSessions.get(parsed.sessionId) ?? null;
  if (!session || session.expiresAt <= Date.now()) {
    if (session) questBuilderSessions.delete(parsed.sessionId);
    return { parsed, session: null };
  }
  return { parsed, session };
}

async function rejectBuilderInteraction(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, message: string) {
  if (interaction.isModalSubmit()) {
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
}

function touchBuilderSession(session: QuestBuilderSession) {
  session.expiresAt = Date.now() + BUILDER_TTL_MS;
}

async function updateBuilderMessage(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, session: QuestBuilderSession) {
  const view = await buildQuestCreatorView(interaction, session);
  if (interaction.deferred || interaction.isModalSubmit()) {
    await interaction.editReply(view);
  } else {
    await interaction.update(view);
  }
}

async function handleQuestBuilderSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const { parsed, session } = getBuilderSession(interaction);
  if (!parsed || !session) return rejectBuilderInteraction(interaction, "This quest setup expired. Run `/quest create` again.");
  if (interaction.user.id !== session.creatorId) return rejectBuilderInteraction(interaction, "Only the person who opened this setup can edit it.");

  const value = interaction.values[0];
  if (parsed.action === "event") session.eventId = value;
  touchBuilderSession(session);

  await interaction.deferUpdate();
  await updateBuilderMessage(interaction, session);
}

async function handleQuestBuilderButton(interaction: ButtonInteraction): Promise<void> {
  const { parsed, session } = getBuilderSession(interaction);
  if (!parsed || !session) return rejectBuilderInteraction(interaction, "This quest setup expired. Run `/quest create` again.");
  if (interaction.user.id !== session.creatorId) return rejectBuilderInteraction(interaction, "Only the person who opened this setup can edit it.");

  if (parsed.action === "cancel") {
    questBuilderSessions.delete(session.id);
    await interaction.update({ content: "Quest setup cancelled.", embeds: [], components: [] });
    return;
  }

  if (parsed.action === "details") return showBuilderDetailsModal(interaction, session);

  if (parsed.action !== "confirm") return;
  await interaction.deferUpdate();

  if (!session.eventId || !session.rewardSats || !session.minMinutes) {
    await interaction.editReply({
      content: "Pick an event, reward, and required time before creating the quest.",
      ...(await buildQuestCreatorView(interaction, session)),
    });
    return;
  }

  const event = await interaction.guild?.scheduledEvents.fetch(session.eventId).catch(() => null);
  if (!event) {
    await interaction.editReply({ content: "I could not find that scheduled event anymore.", embeds: [], components: [] });
    return;
  }

  const targetChannel = await interaction.client.channels.fetch(session.channelId).catch(() => null);
  if (!targetChannel || !("send" in targetChannel)) {
    await interaction.editReply({ content: "I cannot post the quest in this channel.", embeds: [], components: [] });
    return;
  }

  const result = await createEventQuestFromSelection({
    guildId: session.guildId,
    channelId: session.channelId,
    creatorId: session.creatorId,
    event,
    reward: session.rewardSats,
    minMinutes: session.minMinutes,
    maxRewards: session.maxRewards,
  });

  if (!result.ok) {
    await interaction.editReply({ content: result.error, ...(await buildQuestCreatorView(interaction, session)) });
    return;
  }

  const message = await targetChannel.send({ embeds: [result.embed], allowedMentions: { parse: [] } });
  await storeEventQuestMessageId(result.quest.id, message.id);
  questBuilderSessions.delete(session.id);

  await interaction.editReply({
    content: `Created **${event.name}** event quest in <#${session.channelId}>.`,
    embeds: [],
    components: [],
    allowedMentions: { parse: [] },
  });
}

async function showBuilderDetailsModal(interaction: ButtonInteraction, session: QuestBuilderSession) {
  const modal = new ModalBuilder()
    .setCustomId(builderId("details_modal", session.id))
    .setTitle("Event quest details")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reward")
          .setLabel("Reward per attendee in sats")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("1000")
          .setValue(session.rewardSats == null ? "" : String(session.rewardSats)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("minutes")
          .setLabel("Minutes required to attend")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("10")
          .setValue(session.minMinutes == null ? "" : String(session.minMinutes)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("cap")
          .setLabel("Max rewarded attendees")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("Blank means no cap")
          .setValue(session.maxRewards == null ? "" : String(session.maxRewards)),
      ),
    );

  await interaction.showModal(modal);
}

async function handleQuestBuilderModal(interaction: ModalSubmitInteraction): Promise<void> {
  const { parsed, session } = getBuilderSession(interaction);
  if (!parsed || !session) return rejectBuilderInteraction(interaction, "This quest setup expired. Run `/quest create` again.");
  if (interaction.user.id !== session.creatorId) return rejectBuilderInteraction(interaction, "Only the person who opened this setup can edit it.");

  if (parsed.action !== "details_modal") return;

  const rewardRaw = interaction.fields.getTextInputValue("reward").trim();
  const minutesRaw = interaction.fields.getTextInputValue("minutes").trim();
  const capRaw = interaction.fields.getTextInputValue("cap").trim();

  const reward = Number(rewardRaw);
  if (!Number.isFinite(reward) || reward <= 0) {
    await interaction.reply({ content: "Reward must be a positive number of sats.", flags: MessageFlags.Ephemeral });
    return;
  }

  const minutes = Math.floor(Number(minutesRaw));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
    await interaction.reply({ content: "Required time must be between 1 and 1440 minutes.", flags: MessageFlags.Ephemeral });
    return;
  }

  let cap: number | null = null;
  if (capRaw.length > 0) {
    cap = Math.floor(Number(capRaw));
    if (cap < 1 || cap > 10000) {
      await interaction.reply({ content: "Max rewards must be between 1 and 10000, or blank for no cap.", flags: MessageFlags.Ephemeral });
      return;
    }
  }

  session.rewardSats = roundSats(reward);
  session.minMinutes = minutes;
  session.maxRewards = cap;
  touchBuilderSession(session);
  await interaction.deferUpdate();
  await updateBuilderMessage(interaction, session);
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

async function completeTaskOverride(interaction: ChatInputCommandInteraction) {
  const questId = interaction.options.getInteger("quest_id", true);
  const taskKey = interaction.options.getString("task_key", true).trim();
  const user = interaction.options.getUser("user", true);
  const note = interaction.options.getString("note")?.trim() || null;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const snapshot = await getQuestSnapshot(questId).catch((err) => {
    console.warn("[Quest] Manual completion failed:", (err as Error).message);
    return null;
  });
  if (!snapshot) return interaction.editReply({ content: "Quest not found." });
  if (snapshot.quest.creator_id !== interaction.user.id) {
    return interaction.editReply({ content: "Only the quest creator can complete tasks manually." });
  }
  if (snapshot.quest.status !== "active") {
    return interaction.editReply({ content: "Only active quests can receive completions." });
  }

  const task = snapshot.tasks.find((candidate) => candidate.task_key === taskKey);
  if (!task) {
    return interaction.editReply({
      content: `Task \`${taskKey}\` was not found. Use \`/quest preview\` to see task keys.`,
    });
  }

  const result = await completeAndNotify(
    interaction.client,
    {
      id: task.id,
      quest_id: snapshot.quest.id,
      title: task.title,
      quest: {
        id: snapshot.quest.id,
        guild_id: snapshot.quest.guild_id,
        channel_id: snapshot.quest.channel_id,
        message_id: snapshot.quest.message_id,
        creator_id: snapshot.quest.creator_id,
        title: snapshot.quest.title,
        description: snapshot.quest.description,
        status: snapshot.quest.status,
        max_reward_sats: snapshot.quest.max_reward_sats,
        starts_at: snapshot.quest.starts_at,
        ends_at: snapshot.quest.ends_at,
        metadata: snapshot.quest.metadata,
      },
    },
    user.id,
    {
      kind: "manual_override",
      completedBy: interaction.user.id,
      note,
    },
  ).catch((err) => {
    throw new Error(`Could not complete task: ${(err as Error).message}`);
  });

  if (!result.ok) {
    return interaction.editReply({ content: `Task was not completed: ${result.reason ?? "unknown reason"}.` });
  }

  const rewardText = (result.rewardDeltaSats ?? 0) > 0
    ? ` Paid **${formatSats(result.rewardDeltaSats ?? 0)}**.`
    : " No new tier payout was due.";
  const duplicateText = result.insertedCompletion === false ? " This user had already completed that task." : "";

  await interaction.editReply({
    content: `Marked **${task.title}** complete for ${user}.${rewardText}${duplicateText}`,
    allowedMentions: { parse: [] },
  });
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

  const result = await createEventQuestFromSelection({
    guildId: interaction.guild!.id,
    channelId: interaction.channelId,
    creatorId: interaction.user.id,
    event,
    reward,
    minMinutes,
    maxRewards,
  });

  if (!result.ok) return interaction.editReply({ content: result.error });

  const reply = await interaction.editReply({ embeds: [result.embed], allowedMentions: { parse: [] } });
  await storeEventQuestMessageId(result.quest.id, reply.id);
}

async function createEventQuestFromSelection(input: {
  guildId: string;
  channelId: string;
  creatorId: string;
  event: GuildScheduledEvent;
  reward: number;
  minMinutes: number;
  maxRewards: number | null;
}): Promise<{ ok: true; quest: EventQuestRow; embed: EmbedBuilder } | { ok: false; error: string }> {
  if (!input.event.channelId || !eventIsVoiceLike(input.event)) {
    return { ok: false, error: "That event is not attached to a voice or stage channel." };
  }
  if (input.event.status !== GuildScheduledEventStatus.Scheduled && input.event.status !== GuildScheduledEventStatus.Active) {
    return { ok: false, error: "That event is not scheduled or active anymore." };
  }

  const balance = await getBalance(input.creatorId);
  if (balance < input.reward) return { ok: false, error: "Insufficient balance to fund even one quest reward." };

  if (input.maxRewards !== null && balance < roundSats(input.reward * input.maxRewards)) {
    return {
      ok: false,
      error: `Insufficient balance for ${input.maxRewards} rewards (${formatSats(roundSats(input.reward * input.maxRewards))}).`,
    };
  }

  const { data: inserted, error } = await supabase
    .from("event_quests")
    .insert({
      guild_id: input.guildId,
      channel_id: input.channelId,
      creator_id: input.creatorId,
      scheduled_event_id: input.event.id,
      event_name: input.event.name,
      event_channel_id: input.event.channelId,
      reward_sats: input.reward,
      min_minutes: input.minMinutes,
      max_rewards: input.maxRewards,
      scheduled_start_at: input.event.scheduledStartAt?.toISOString() ?? null,
      scheduled_end_at: input.event.scheduledEndAt?.toISOString() ?? null,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    if (error) console.warn("[Quest] Failed to insert event quest:", error.message);
    return { ok: false, error: "Failed to create the quest." };
  }

  createQuestDefinition({
    guildId: input.guildId,
    channelId: input.channelId,
    creatorId: input.creatorId,
    title: input.event.name,
    description: `Attend ${input.event.name} for ${input.minMinutes} minute${input.minMinutes === 1 ? "" : "s"}.`,
    startsAt: input.event.scheduledStartAt?.toISOString() ?? null,
    endsAt: input.event.scheduledEndAt?.toISOString() ?? null,
    metadata: { legacyEventQuestId: inserted.id, scheduledEventId: input.event.id },
    tasks: [
      {
        taskKey: "event_attendance",
        type: "event_attendance",
        title: "Attend event",
        description: `Stay connected to <#${input.event.channelId}> for ${input.minMinutes} minute${input.minMinutes === 1 ? "" : "s"}.`,
        config: { scheduledEventId: input.event.id, eventChannelId: input.event.channelId, minMinutes: input.minMinutes },
      },
    ],
    rewardTiers: [{ completedTaskCount: 1, rewardSats: input.reward }],
  }).catch((err) => {
    console.warn("[QuestEngine] Failed to mirror event quest:", (err as Error)?.message ?? err);
  });

  const quest: EventQuestRow = {
    id: inserted.id,
    guild_id: input.guildId,
    channel_id: input.channelId,
    message_id: null,
    creator_id: input.creatorId,
    scheduled_event_id: input.event.id,
    event_name: input.event.name,
    event_channel_id: input.event.channelId,
    reward_sats: input.reward,
    min_minutes: input.minMinutes,
    max_rewards: input.maxRewards,
    rewards_count: 0,
    status: "active",
    scheduled_start_at: input.event.scheduledStartAt?.toISOString() ?? null,
    scheduled_end_at: input.event.scheduledEndAt?.toISOString() ?? null,
  };

  const thumbnail = input.event.coverImageURL({ size: 256 });
  const embed = buildEventQuestEmbed(quest);
  if (thumbnail) embed.setThumbnail(thumbnail);

  return { ok: true, quest, embed };
}

async function storeEventQuestMessageId(questId: number, messageId: string) {
  const { error } = await supabase
    .from("event_quests")
    .update({ message_id: messageId })
    .eq("id", questId);

  if (error) console.warn("[Quest] Failed to store quest message id:", error.message);
}
