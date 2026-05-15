import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  GuildScheduledEventEntityType,
  GuildScheduledEventStatus,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type GuildScheduledEvent,
  type Interaction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { getBalance } from "../balance.js";
import { supabase } from "../db.js";
import { formatSats, roundSats } from "../format.js";
import { buildEventQuestEmbed, type EventQuestRow } from "../eventQuests.js";
import {
  createQuestDefinition,
  getQuestSnapshot,
  getQuestTaskDefinition,
} from "../quests/engine.js";
import { completeAndNotify } from "../quests/runtime.js";

export const data = {
  name: "quest",
  description: "Create and manage sats quests",
  options: [
    {
      name: "create",
      type: 1 as const,
      description: "Open the unified quest builder",
    },
    {
      name: "complete_task",
      type: 1 as const,
      description: "Creator override: mark a quest task complete for a user",
      options: [
        { name: "quest_id", type: 4 as const, description: "Quest ID", required: true, minValue: 1 },
        { name: "task_key", type: 3 as const, description: "Task key (event_attendance, first_link_...)", required: true, maxLength: 64 },
        { name: "user", type: 6 as const, description: "User who completed the task", required: true },
        { name: "note", type: 3 as const, description: "Optional proof note", required: false, maxLength: 300 },
      ],
    },
  ],
};

const BUILDER_PREFIX = "qcreate";
const BUILDER_TTL_MS = 15 * 60_000;
const DEFAULT_MIN_MINUTES = 10;
const DEFAULT_REFRESH_MINUTES = 60;
const QUEST_COLOR = 0x77a7ff;

type QuestBuilderEventOption = {
  id: string;
  name: string;
  channelId: string;
  channelName: string | null;
  scheduledStartTimestamp: number | null;
};

type LinkSource = "latest_tweet" | "rotating_list";

type QuestBuilderSession = {
  id: string;
  guildId: string;
  channelId: string;
  creatorId: string;
  events: QuestBuilderEventOption[];

  eventEnabled: boolean;
  eventId: string | null;
  selectedEvent: QuestBuilderEventOption | null;
  minMinutes: number;

  linkEnabled: boolean;
  linkChannelId: string | null;
  linkChannelName: string | null;
  linkSource: LinkSource | null;
  linkList: string[];
  linkRefreshMinutes: number;

  title: string | null;
  description: string | null;
  rewardSats1: number | null;
  rewardSats2: number | null;
  maxRewards: number | null;

  expiresAt: number;
};

const questBuilderSessions = new Map<string, QuestBuilderSession>();

function eventIsVoiceLike(event: GuildScheduledEvent): boolean {
  return event.entityType === GuildScheduledEventEntityType.StageInstance ||
    event.entityType === GuildScheduledEventEntityType.Voice;
}

async function getSelectableEvents(interaction: ChatInputCommandInteraction) {
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

function toBuilderEventOption(event: GuildScheduledEvent): QuestBuilderEventOption {
  return {
    id: event.id,
    name: event.name,
    channelId: event.channelId ?? "",
    channelName: event.channel?.name ?? null,
    scheduledStartTimestamp: event.scheduledStartTimestamp ?? null,
  };
}

function cleanupQuestBuilderSessions() {
  const now = Date.now();
  for (const [id, session] of questBuilderSessions) {
    if (session.expiresAt <= now) questBuilderSessions.delete(id);
  }
}

async function createBuilderSession(interaction: ChatInputCommandInteraction): Promise<QuestBuilderSession> {
  cleanupQuestBuilderSessions();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const events = await getSelectableEvents(interaction).catch(() => []);
  const session: QuestBuilderSession = {
    id,
    guildId: interaction.guild!.id,
    channelId: interaction.channelId,
    creatorId: interaction.user.id,
    events: events.slice(0, 25).map(toBuilderEventOption),

    eventEnabled: false,
    eventId: null,
    selectedEvent: null,
    minMinutes: DEFAULT_MIN_MINUTES,

    linkEnabled: false,
    linkChannelId: null,
    linkChannelName: null,
    linkSource: null,
    linkList: [],
    linkRefreshMinutes: DEFAULT_REFRESH_MINUTES,

    title: null,
    description: null,
    rewardSats1: null,
    rewardSats2: null,
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

function touchBuilderSession(session: QuestBuilderSession) {
  session.expiresAt = Date.now() + BUILDER_TTL_MS;
}

function parseLinkListInput(raw: string): { ok: true; list: string[] } | { ok: false; error: string } {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^<+/, "").replace(/[>,.;:!?)]+$/g, ""))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { ok: false, error: "Add at least one URL (one per line)." };

  const list: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      return { ok: false, error: `Not a valid URL: ${line.slice(0, 80)}` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: `Only http/https URLs are allowed: ${line.slice(0, 80)}` };
    }
    if (seen.has(url.toString())) continue;
    seen.add(url.toString());
    list.push(line);
  }
  if (list.length === 0) return { ok: false, error: "Add at least one URL (one per line)." };
  return { ok: true, list };
}

function inferTitle(session: QuestBuilderSession): string {
  if (session.title?.trim()) return session.title.trim();
  if (session.eventEnabled && session.selectedEvent) return session.selectedEvent.name;
  if (session.linkEnabled && session.linkSource === "latest_tweet") return "First to share the latest feed link";
  if (session.linkEnabled && session.linkSource === "rotating_list") {
    return session.linkList.length > 1 ? "First to share the active link" : "First to share the link";
  }
  return "Untitled quest";
}

function activeTaskCount(session: QuestBuilderSession): number {
  return (session.eventEnabled ? 1 : 0) + (session.linkEnabled ? 1 : 0);
}

function isSingleEventMode(session: QuestBuilderSession): boolean {
  return session.eventEnabled && !session.linkEnabled;
}

function isReadyToPublish(session: QuestBuilderSession): string | null {
  if (activeTaskCount(session) === 0) return "Add at least one task before publishing.";

  if (session.eventEnabled) {
    if (!session.eventId || !session.selectedEvent) return "Pick a scheduled event for the event task.";
    if (!session.minMinutes || session.minMinutes < 1) return "Set the required minutes for the event task.";
  }

  if (session.linkEnabled) {
    if (!session.linkChannelId) return "Pick the channel for the first-link task.";
    if (!session.linkSource) return "Pick the link source for the first-link task.";
    if (session.linkSource === "rotating_list" && session.linkList.length === 0) {
      return "Paste at least one URL into the rotating link list.";
    }
    if (!session.linkRefreshMinutes || session.linkRefreshMinutes < 1) return "Set the refresh window for the first-link task.";
  }

  if (!session.rewardSats1 || session.rewardSats1 <= 0) return "Set a reward for the first tier.";

  if (activeTaskCount(session) === 2) {
    if (!session.rewardSats2 || session.rewardSats2 <= 0) return "Set a reward for the second tier.";
    if (session.rewardSats2 < session.rewardSats1) return "Tier 2 reward must be at least the tier 1 reward.";
  }

  return null;
}

function formatLinkSource(source: LinkSource | null): string {
  if (source === "latest_tweet") return "Latest admin feed link";
  if (source === "rotating_list") return "Rotating link list";
  return "Not selected";
}

function buildBuilderEmbed(session: QuestBuilderSession): EmbedBuilder {
  const lines: string[] = [];

  if (!session.eventEnabled && !session.linkEnabled) {
    lines.push("Add at least one task to get started.");
  } else if (isSingleEventMode(session)) {
    lines.push("Single-event quest. Pay out automatically when attendees stay long enough.");
  } else if (session.linkEnabled && !session.eventEnabled) {
    lines.push("First-link quest. Reward the first user to drop the configured link each window.");
  } else {
    lines.push("Multi-step quest. Users earn tier rewards as they complete tasks.");
  }

  const tasks: string[] = [];
  if (session.eventEnabled) {
    const eventLabel = session.selectedEvent
      ? `**${session.selectedEvent.name}** in <#${session.selectedEvent.channelId}>`
      : "*Event not selected*";
    tasks.push(`↳ **Event attendance** — ${eventLabel} for **${session.minMinutes}** min`);
  }
  if (session.linkEnabled) {
    const channelLabel = session.linkChannelId ? `<#${session.linkChannelId}>` : "*Channel not selected*";
    const listLabel = session.linkSource === "rotating_list"
      ? ` • ${session.linkList.length > 0 ? `${session.linkList.length} link${session.linkList.length === 1 ? "" : "s"}` : "*No links set*"}`
      : "";
    tasks.push(`↳ **First link** — ${channelLabel} • ${formatLinkSource(session.linkSource)}${listLabel} • every **${session.linkRefreshMinutes}** min`);
  }

  const rewards: string[] = [];
  if (session.rewardSats1) {
    if (activeTaskCount(session) === 2) {
      rewards.push(`↳ **1 task** → ${formatSats(session.rewardSats1)}`);
      rewards.push(`↳ **2 tasks** → ${session.rewardSats2 ? formatSats(session.rewardSats2) : "Not set"}`);
    } else if (isSingleEventMode(session)) {
      rewards.push(`↳ **${formatSats(session.rewardSats1)}** per qualifying attendee`);
      if (session.maxRewards) rewards.push(`↳ Cap: **${session.maxRewards}** attendees`);
    } else {
      rewards.push(`↳ **${formatSats(session.rewardSats1)}** per qualifying user`);
    }
  } else {
    rewards.push("Not set");
  }

  const embed = new EmbedBuilder()
    .setColor(QUEST_COLOR)
    .setTitle(`🛠️ ${inferTitle(session)}`)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "Tasks", value: tasks.length === 0 ? "No tasks yet." : tasks.join("\n"), inline: false },
      { name: "Rewards", value: rewards.join("\n"), inline: false },
    )
    .setFooter({ text: "This setup expires after 15 minutes." });

  if (session.description?.trim()) {
    embed.addFields({ name: "Description", value: session.description.trim().slice(0, 1024), inline: false });
  }

  return embed;
}

type BuilderComponentRow = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder | ChannelSelectMenuBuilder>;

function buildBuilderComponents(session: QuestBuilderSession): BuilderComponentRow[] {
  const rows: BuilderComponentRow[] = [];

  if (session.eventEnabled && session.events.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(builderId("event", session.id))
          .setPlaceholder(session.selectedEvent ? session.selectedEvent.name.slice(0, 100) : "Choose a scheduled event")
          .addOptions(
            session.events.map((candidate) => {
              const starts = candidate.scheduledStartTimestamp
                ? new Date(candidate.scheduledStartTimestamp).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
                : "unscheduled";
              return {
                label: candidate.name.slice(0, 100),
                description: `${starts} in ${candidate.channelName ?? "event channel"}`.slice(0, 100),
                value: candidate.id,
                default: candidate.id === session.eventId,
              };
            }),
          ),
      ),
    );
  }

  if (session.linkEnabled) {
    rows.push(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(builderId("link_channel", session.id))
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1)
          .setPlaceholder(session.linkChannelName ? `#${session.linkChannelName}` : "Pick the link target channel")
          .setDefaultChannels(session.linkChannelId ? [session.linkChannelId] : []),
      ),
    );

    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(builderId("link_source", session.id))
          .setPlaceholder(session.linkSource ? formatLinkSource(session.linkSource) : "Pick a link source")
          .addOptions([
            { label: "Latest admin feed link", value: "latest_tweet", default: session.linkSource === "latest_tweet" },
            { label: "Rotating link list", value: "rotating_list", default: session.linkSource === "rotating_list" },
          ]),
      ),
    );
  }

  const toggleRow = new ActionRowBuilder<ButtonBuilder>();
  toggleRow.addComponents(
    new ButtonBuilder()
      .setCustomId(builderId(session.eventEnabled ? "remove_event" : "add_event", session.id))
      .setLabel(session.eventEnabled ? "Remove event task" : "Add event task")
      .setStyle(session.eventEnabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(!session.eventEnabled && session.events.length === 0),
    new ButtonBuilder()
      .setCustomId(builderId(session.linkEnabled ? "remove_link" : "add_link", session.id))
      .setLabel(session.linkEnabled ? "Remove link task" : "Add first-link task")
      .setStyle(session.linkEnabled ? ButtonStyle.Secondary : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(builderId("details", session.id))
      .setLabel("Edit details")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(activeTaskCount(session) === 0),
  );
  if (session.linkEnabled && session.linkSource === "rotating_list") {
    toggleRow.addComponents(
      new ButtonBuilder()
        .setCustomId(builderId("link_list", session.id))
        .setLabel(session.linkList.length > 0 ? `Edit link list (${session.linkList.length})` : "Set link list")
        .setStyle(session.linkList.length > 0 ? ButtonStyle.Secondary : ButtonStyle.Primary),
    );
  }
  rows.push(toggleRow);

  const finalRow = new ActionRowBuilder<ButtonBuilder>();
  finalRow.addComponents(
    new ButtonBuilder()
      .setCustomId(builderId("publish", session.id))
      .setLabel("Publish")
      .setStyle(ButtonStyle.Success)
      .setDisabled(isReadyToPublish(session) !== null),
    new ButtonBuilder()
      .setCustomId(builderId("cancel", session.id))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger),
  );
  rows.push(finalRow);

  return rows;
}

function renderBuilderView(session: QuestBuilderSession) {
  return {
    embeds: [buildBuilderEmbed(session)],
    components: buildBuilderComponents(session),
    allowedMentions: { parse: [] as never[] },
  };
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "Quest creation only works in servers.", flags: MessageFlags.Ephemeral });
  }

  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand === "create") return startQuestBuilder(interaction);
  if (subcommand === "complete_task") return completeTaskOverride(interaction);

  return interaction.reply({ content: "Unknown quest command.", flags: MessageFlags.Ephemeral });
}

async function startQuestBuilder(interaction: ChatInputCommandInteraction) {
  const session = await createBuilderSession(interaction);
  await interaction.reply({
    ...renderBuilderView(session),
    flags: MessageFlags.Ephemeral,
  });
}

export function isQuestBuilderInteraction(interaction: Interaction): boolean {
  if (
    interaction.isButton() ||
    interaction.isStringSelectMenu() ||
    interaction.isChannelSelectMenu() ||
    interaction.isModalSubmit()
  ) {
    return interaction.customId.startsWith(`${BUILDER_PREFIX}:`);
  }
  return false;
}

type BuilderInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ChannelSelectMenuInteraction
  | ModalSubmitInteraction;

export async function handleQuestBuilderInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isStringSelectMenu()) return handleSelect(interaction);
  if (interaction.isChannelSelectMenu()) return handleChannelSelect(interaction);
  if (interaction.isButton()) return handleButton(interaction);
  if (interaction.isModalSubmit()) return handleModal(interaction);
}

function getBuilderSession(interaction: BuilderInteraction) {
  const parsed = parseBuilderId(interaction.customId);
  if (!parsed) return { parsed: null, session: null };
  const session = questBuilderSessions.get(parsed.sessionId) ?? null;
  if (!session || session.expiresAt <= Date.now()) {
    if (session) questBuilderSessions.delete(parsed.sessionId);
    return { parsed, session: null };
  }
  return { parsed, session };
}

async function rejectExpired(interaction: BuilderInteraction) {
  await interaction.reply({
    content: "This quest setup expired. Run `/quest create` again.",
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
}

async function rejectNotOwner(interaction: BuilderInteraction) {
  await interaction.reply({
    content: "Only the person who opened this setup can edit it.",
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
}

async function updateBuilderMessage(interaction: BuilderInteraction, session: QuestBuilderSession) {
  const view = renderBuilderView(session);
  if (interaction.isModalSubmit() || interaction.deferred) {
    await interaction.editReply(view);
  } else {
    await interaction.update(view);
  }
}

async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const { parsed, session } = getBuilderSession(interaction);
  if (!parsed || !session) return rejectExpired(interaction);
  if (interaction.user.id !== session.creatorId) return rejectNotOwner(interaction);

  const value = interaction.values[0];
  if (parsed.action === "event") {
    session.eventId = value;
    session.selectedEvent = session.events.find((event) => event.id === value) ?? null;
  } else if (parsed.action === "link_source") {
    if (value === "latest_tweet" || value === "rotating_list") {
      session.linkSource = value;
      if (value === "latest_tweet") {
        session.linkList = [];
      }
    }
  } else {
    return;
  }

  touchBuilderSession(session);
  await interaction.deferUpdate();
  await updateBuilderMessage(interaction, session);
}

async function handleChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<void> {
  const { parsed, session } = getBuilderSession(interaction);
  if (!parsed || !session) return rejectExpired(interaction);
  if (interaction.user.id !== session.creatorId) return rejectNotOwner(interaction);

  if (parsed.action === "link_channel") {
    const channel = interaction.channels.first();
    if (channel) {
      session.linkChannelId = channel.id;
      session.linkChannelName = "name" in channel ? (channel as { name: string | null }).name : null;
    }
  }

  touchBuilderSession(session);
  await interaction.deferUpdate();
  await updateBuilderMessage(interaction, session);
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const { parsed, session } = getBuilderSession(interaction);
  if (!parsed || !session) return rejectExpired(interaction);
  if (interaction.user.id !== session.creatorId) return rejectNotOwner(interaction);

  if (parsed.action === "cancel") {
    questBuilderSessions.delete(session.id);
    await interaction.update({ content: "Quest setup cancelled.", embeds: [], components: [] });
    return;
  }

  if (parsed.action === "add_event") {
    if (session.events.length === 0) {
      await interaction.reply({
        content: "No upcoming voice or stage events to attach.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    session.eventEnabled = true;
    touchBuilderSession(session);
    await interaction.update(renderBuilderView(session));
    return;
  }

  if (parsed.action === "remove_event") {
    session.eventEnabled = false;
    session.eventId = null;
    session.selectedEvent = null;
    touchBuilderSession(session);
    await interaction.update(renderBuilderView(session));
    return;
  }

  if (parsed.action === "add_link") {
    session.linkEnabled = true;
    touchBuilderSession(session);
    await interaction.update(renderBuilderView(session));
    return;
  }

  if (parsed.action === "remove_link") {
    session.linkEnabled = false;
    session.linkChannelId = null;
    session.linkChannelName = null;
    session.linkSource = null;
    session.linkList = [];
    touchBuilderSession(session);
    await interaction.update(renderBuilderView(session));
    return;
  }

  if (parsed.action === "link_list") return showLinkListModal(interaction, session);

  if (parsed.action === "details") return showDetailsModal(interaction, session);

  if (parsed.action === "publish") return publishSession(interaction, session);
}

async function showDetailsModal(interaction: ButtonInteraction, session: QuestBuilderSession): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(builderId("details_modal", session.id))
    .setTitle("Quest details");

  const titleInput = new TextInputBuilder()
    .setCustomId("title")
    .setLabel("Title (blank = auto)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100)
    .setPlaceholder(inferTitle(session))
    .setValue(session.title ?? "");

  const reward1Input = new TextInputBuilder()
    .setCustomId("reward1")
    .setLabel(
      activeTaskCount(session) === 2 ? "Reward after 1 task (sats)" : "Reward (sats)",
    )
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("500")
    .setValue(session.rewardSats1 == null ? "" : String(session.rewardSats1));

  const rows: ActionRowBuilder<TextInputBuilder>[] = [
    new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(reward1Input),
  ];

  if (activeTaskCount(session) === 2) {
    rows.push(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reward2")
          .setLabel("Reward after both tasks (sats)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("1500")
          .setValue(session.rewardSats2 == null ? "" : String(session.rewardSats2)),
      ),
    );
  }

  if (session.eventEnabled) {
    rows.push(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("min_minutes")
          .setLabel("Minutes required in event")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder(String(DEFAULT_MIN_MINUTES))
          .setValue(String(session.minMinutes)),
      ),
    );
  }

  if (session.linkEnabled && rows.length < 5) {
    rows.push(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("refresh_minutes")
          .setLabel("First-link refresh window (minutes)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder(String(DEFAULT_REFRESH_MINUTES))
          .setValue(String(session.linkRefreshMinutes)),
      ),
    );
  }

  if (isSingleEventMode(session) && rows.length < 5) {
    rows.push(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("cap")
          .setLabel("Max rewarded attendees (blank = none)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder("Blank for no cap")
          .setValue(session.maxRewards == null ? "" : String(session.maxRewards)),
      ),
    );
  }

  modal.addComponents(...rows);
  await interaction.showModal(modal);
}

async function showLinkListModal(interaction: ButtonInteraction, session: QuestBuilderSession): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(builderId("link_list_modal", session.id))
    .setTitle("Rotating link list");

  const linkListInput = new TextInputBuilder()
    .setCustomId("link_list")
    .setLabel("One URL per line — rotates each window")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setPlaceholder("https://example.com/one\nhttps://example.com/two\nhttps://example.com/three")
    .setValue(session.linkList.join("\n"));

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(linkListInput));
  await interaction.showModal(modal);
}

async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const { parsed, session } = getBuilderSession(interaction);
  if (!parsed || !session) return rejectExpired(interaction);
  if (interaction.user.id !== session.creatorId) return rejectNotOwner(interaction);

  if (parsed.action === "link_list_modal") {
    const raw = interaction.fields.getTextInputValue("link_list");
    const result = parseLinkListInput(raw);
    if (!result.ok) {
      await interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      return;
    }

    session.linkList = result.list;
    touchBuilderSession(session);
    await interaction.deferUpdate();
    await updateBuilderMessage(interaction, session);
    return;
  }

  if (parsed.action !== "details_modal") return;

  const titleRaw = interaction.fields.getTextInputValue("title").trim();
  const reward1Raw = interaction.fields.getTextInputValue("reward1").trim();

  const reward1 = Number(reward1Raw);
  if (!Number.isFinite(reward1) || reward1 <= 0) {
    await interaction.reply({ content: "Reward must be a positive number of sats.", flags: MessageFlags.Ephemeral });
    return;
  }
  session.rewardSats1 = roundSats(reward1);

  if (activeTaskCount(session) === 2) {
    const reward2Raw = interaction.fields.getTextInputValue("reward2").trim();
    const reward2 = Number(reward2Raw);
    if (!Number.isFinite(reward2) || reward2 <= 0) {
      await interaction.reply({ content: "Tier 2 reward must be a positive number of sats.", flags: MessageFlags.Ephemeral });
      return;
    }
    session.rewardSats2 = roundSats(reward2);
  } else {
    session.rewardSats2 = null;
  }

  if (session.eventEnabled) {
    const minutesRaw = interaction.fields.getTextInputValue("min_minutes").trim();
    const minutes = Math.floor(Number(minutesRaw));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      await interaction.reply({ content: "Event minutes must be between 1 and 1440.", flags: MessageFlags.Ephemeral });
      return;
    }
    session.minMinutes = minutes;
  }

  if (session.linkEnabled && hasField(interaction, "refresh_minutes")) {
    const refreshRaw = interaction.fields.getTextInputValue("refresh_minutes").trim();
    const refresh = Math.floor(Number(refreshRaw));
    if (!Number.isFinite(refresh) || refresh < 1 || refresh > 1440) {
      await interaction.reply({ content: "Refresh window must be between 1 and 1440 minutes.", flags: MessageFlags.Ephemeral });
      return;
    }
    session.linkRefreshMinutes = refresh;
  }

  if (isSingleEventMode(session) && hasField(interaction, "cap")) {
    const capRaw = interaction.fields.getTextInputValue("cap").trim();
    if (capRaw.length === 0) {
      session.maxRewards = null;
    } else {
      const cap = Math.floor(Number(capRaw));
      if (!Number.isFinite(cap) || cap < 1 || cap > 10000) {
        await interaction.reply({ content: "Max rewards must be between 1 and 10000.", flags: MessageFlags.Ephemeral });
        return;
      }
      session.maxRewards = cap;
    }
  } else {
    session.maxRewards = null;
  }

  session.title = titleRaw.length > 0 ? titleRaw : null;
  touchBuilderSession(session);
  await interaction.deferUpdate();
  await updateBuilderMessage(interaction, session);
}

function hasField(interaction: ModalSubmitInteraction, customId: string): boolean {
  try {
    interaction.fields.getTextInputValue(customId);
    return true;
  } catch {
    return false;
  }
}

async function publishSession(interaction: ButtonInteraction, session: QuestBuilderSession): Promise<void> {
  const validation = isReadyToPublish(session);
  if (validation) {
    await interaction.reply({ content: validation, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  if (isSingleEventMode(session)) {
    const event = await interaction.guild?.scheduledEvents
      .fetch({ guildScheduledEvent: session.eventId!, withUserCount: true })
      .catch(() => null);
    if (!event) {
      await interaction.editReply({ content: "I could not find that scheduled event anymore.", embeds: [], components: [] });
      return;
    }

    const result = await createEventQuestFromSelection({
      guildId: session.guildId,
      channelId: session.channelId,
      creatorId: session.creatorId,
      event,
      reward: session.rewardSats1!,
      minMinutes: session.minMinutes,
      maxRewards: session.maxRewards,
    });

    if (!result.ok) {
      await interaction.editReply({ content: result.error, ...renderBuilderView(session) });
      return;
    }

    const message = await interaction.followUp({ embeds: [result.embed], allowedMentions: { parse: [] } });
    await storeEventQuestMessageId(result.quest.id, message.id);
    questBuilderSessions.delete(session.id);

    await interaction.editReply({
      content: `Created **${event.name}** event quest in <#${session.channelId}>.`,
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const result = await createMultiStepQuestFromSession(interaction, session);
  if (!result.ok) {
    await interaction.editReply({ content: result.error, ...renderBuilderView(session) });
    return;
  }

  const message = await interaction.followUp({ embeds: [result.embed], allowedMentions: { parse: [] } });
  await storeQuestMessageId(result.questId, message.id);
  questBuilderSessions.delete(session.id);

  await interaction.editReply({
    content: `Created **${inferTitle(session)}** in <#${session.channelId}>.`,
    embeds: [],
    components: [],
    allowedMentions: { parse: [] },
  });
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

async function createMultiStepQuestFromSession(
  interaction: ButtonInteraction,
  session: QuestBuilderSession,
): Promise<{ ok: true; questId: number; embed: EmbedBuilder } | { ok: false; error: string }> {
  const tasks: Parameters<typeof createQuestDefinition>[0]["tasks"] = [];
  const rewardTiers: Array<{ completedTaskCount: number; rewardSats: number }> = [];

  let taskIndex = 0;
  if (session.eventEnabled && session.selectedEvent) {
    const event = await interaction.guild?.scheduledEvents
      .fetch({ guildScheduledEvent: session.selectedEvent.id, withUserCount: false })
      .catch(() => null);
    if (!event || !event.channelId || !eventIsVoiceLike(event)) {
      return { ok: false, error: "That event is not attached to a voice or stage channel anymore." };
    }

    tasks.push({
      taskKey: "event_attendance",
      type: "event_attendance",
      title: `Attend ${event.name}`,
      description: `Stay connected to <#${event.channelId}> for ${session.minMinutes} minute${session.minMinutes === 1 ? "" : "s"}.`,
      config: {
        scheduledEventId: event.id,
        eventChannelId: event.channelId,
        minMinutes: session.minMinutes,
      },
    });
    taskIndex += 1;
  }

  if (session.linkEnabled && session.linkChannelId && session.linkSource) {
    tasks.push({
      taskKey: `first_link_${session.linkSource}_${session.linkChannelId}`,
      type: "first_link_in_channel",
      title: session.linkSource === "latest_tweet" ? "Share latest feed link" : "Share the active link",
      description: `Be first every ${session.linkRefreshMinutes} minutes to post the active link in <#${session.linkChannelId}>.`,
      config: {
        targetChannelId: session.linkChannelId,
        source: session.linkSource,
        ...(session.linkSource === "rotating_list" ? { linkList: session.linkList } : {}),
        refreshMinutes: session.linkRefreshMinutes,
      },
    });
    taskIndex += 1;
  }

  if (tasks.length === 0) return { ok: false, error: "Add at least one task before publishing." };

  rewardTiers.push({ completedTaskCount: 1, rewardSats: session.rewardSats1! });
  if (tasks.length === 2) {
    rewardTiers.push({ completedTaskCount: 2, rewardSats: session.rewardSats2! });
  }

  const maxReward = Math.max(...rewardTiers.map((tier) => tier.rewardSats));
  const balance = await getBalance(session.creatorId);
  if (balance < maxReward) {
    return { ok: false, error: "Insufficient balance to cover at least one full payout." };
  }

  const title = inferTitle(session);
  const description = session.description ?? null;
  const startsAt = session.eventEnabled && session.selectedEvent?.scheduledStartTimestamp
    ? new Date(session.selectedEvent.scheduledStartTimestamp).toISOString()
    : null;

  try {
    const snapshot = await createQuestDefinition({
      guildId: session.guildId,
      channelId: session.channelId,
      creatorId: session.creatorId,
      title,
      description,
      startsAt,
      endsAt: null,
      tasks,
      rewardTiers,
    });

    return { ok: true, questId: snapshot.quest.id, embed: buildPublishedQuestEmbed(snapshot) };
  } catch (err) {
    return { ok: false, error: `Could not publish quest: ${(err as Error).message}` };
  }
}

function buildPublishedQuestEmbed(snapshot: Awaited<ReturnType<typeof getQuestSnapshot>> & {}): EmbedBuilder {
  const tierLines = snapshot.tiers.map((tier) =>
    `↳ **${tier.completed_task_count} task${tier.completed_task_count === 1 ? "" : "s"}** → ${formatSats(tier.reward_sats)}`
  );
  const taskLines = snapshot.tasks.map((task, index) => {
    const def = getQuestTaskDefinition(task.type);
    const requirement = def?.renderRequirement(task.config) ?? task.description ?? task.title;
    return `↳ **${index + 1}. ${task.title}**\n${requirement}`;
  });

  return new EmbedBuilder()
    .setColor(QUEST_COLOR)
    .setTitle(`❄️ ${snapshot.quest.title}`)
    .setDescription(snapshot.quest.description ?? "A multi-step sats quest.")
    .addFields(
      { name: "Rewards:", value: tierLines.join("\n") || "No reward tiers.", inline: false },
      { name: "Requirements:", value: taskLines.join("\n\n").slice(0, 1024), inline: false },
    )
    .setFooter({ text: "⚡ Powered by matsFi" })
    .setTimestamp();
}

async function storeEventQuestMessageId(questId: number, messageId: string) {
  const { error } = await supabase
    .from("event_quests")
    .update({ message_id: messageId })
    .eq("id", questId);
  if (error) console.warn("[Quest] Failed to store quest message id:", error.message);
}

async function storeQuestMessageId(questId: number, messageId: string) {
  const { error } = await supabase
    .from("quests")
    .update({ message_id: messageId })
    .eq("id", questId);
  if (error) console.warn("[Quest] Failed to store quest message id:", error.message);
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
    return interaction.editReply({ content: `Task \`${taskKey}\` was not found on this quest.` });
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
