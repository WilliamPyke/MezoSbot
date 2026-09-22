import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  disableDeveloperRelayRoute,
  getDeveloperRelayRoute,
  setDeveloperRelayRoute,
} from "../developerRelay.js";

export const data = {
  name: "developer-relay",
  description: "Configure developer DM link forwarding",
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
  options: [
    {
      name: "set",
      type: 1 as const,
      description: "Authorize a developer channel or private thread",
      options: [
        { name: "developer", type: 6 as const, description: "Developer to authorize", required: true },
        { name: "channel", type: 7 as const, description: "Developer text channel", required: false, channel_types: [ChannelType.GuildText] },
        { name: "thread", type: 7 as const, description: "Developer's private thread", required: false, channel_types: [ChannelType.PrivateThread] },
      ],
    },
    {
      name: "show",
      type: 1 as const,
      description: "Show a developer's relay route",
      options: [
        { name: "developer", type: 6 as const, description: "Developer to inspect", required: true },
      ],
    },
    {
      name: "disable",
      type: 1 as const,
      description: "Disable a developer's relay route",
      options: [
        { name: "developer", type: 6 as const, description: "Developer to disable", required: true },
      ],
    },
  ],
};

function canManage(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(
    interaction.inGuild() &&
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild),
  );
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !canManage(interaction)) {
    await interaction.reply({
      content: "You need Manage Server permission to configure developer relays.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const subcommand = interaction.options.getSubcommand(true);
  const developer = interaction.options.getUser("developer", true);

  if (developer.bot) {
    await interaction.editReply("Developer relay routes can only be assigned to people.");
    return;
  }

  if (subcommand === "set") {
    const thread = interaction.options.getChannel("thread");
    const selectedChannel = interaction.options.getChannel("channel");
    if (!thread && !selectedChannel) {
      await interaction.editReply("Select a developer channel or a private thread.");
      return;
    }
    if (thread && (
      thread.type !== ChannelType.PrivateThread ||
      !("guildId" in thread) || thread.guildId !== interaction.guild.id ||
      thread.parentId === null
    )) {
      await interaction.editReply("The thread must be a private thread in this server.");
      return;
    }
    const channelId = selectedChannel?.id ?? (thread && "parentId" in thread ? thread.parentId : null);
    const channel = channelId ? await interaction.guild.channels.fetch(channelId).catch(() => null) : null;
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== interaction.guild.id) {
      await interaction.editReply("Select a text channel in this server that I can access.");
      return;
    }
    if (thread && (!("parentId" in thread) || thread.parentId !== channel.id)) {
      await interaction.editReply("The private thread must belong to the selected developer channel.");
      return;
    }

    const botMember = interaction.guild.members.me;
    const channelPermissions = botMember ? channel.permissionsFor(botMember) : null;
    const threadPermissions = botMember && thread && "permissionsFor" in thread ? thread.permissionsFor(botMember) : null;
    if (
      !channelPermissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ]) ||
      (thread && !threadPermissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.EmbedLinks,
      ]))
    ) {
      await interaction.editReply(
        thread
          ? "I still need View Channel, Send Messages, Embed Links, and Send Messages in Threads for those destinations."
          : "I still need View Channel, Send Messages, and Embed Links in the developer channel.",
      );
      return;
    }

    await setDeveloperRelayRoute({
      guildId: interaction.guild.id,
      discordId: developer.id,
      developerChannelId: channel.id,
      privateThreadId: thread?.id ?? null,
      createdBy: interaction.user.id,
    });
    await interaction.editReply({
      content:
        `Relay enabled for <@${developer.id}>.\n` +
        (thread ? `Default: <#${thread.id}>\n` : "No private thread. Use `channel:` when sending links.\n") +
        `Public with \`channel:\`: <#${channel.id}>`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (subcommand === "show") {
    const route = await getDeveloperRelayRoute(interaction.guild.id, developer.id);
    if (!route) {
      await interaction.editReply(`No relay route exists for <@${developer.id}>.`);
      return;
    }
    await interaction.editReply({
      content:
        `Relay for <@${developer.id}> is **${route.enabled ? "enabled" : "disabled"}**.\n` +
        `Developer channel: <#${route.developer_channel_id}>\n` +
        `Private thread: ${route.private_thread_id ? `<#${route.private_thread_id}>` : "not configured (use channel:)"}`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (subcommand === "disable") {
    const disabled = await disableDeveloperRelayRoute(interaction.guild.id, developer.id);
    await interaction.editReply({
      content: disabled
        ? `Relay disabled for <@${developer.id}>.`
        : `No active relay route exists for <@${developer.id}>.`,
      allowedMentions: { parse: [] },
    });
  }
}
