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
      description: "Assign a developer private thread",
      options: [
        { name: "developer", type: 6 as const, description: "Developer to authorize", required: true },
        { name: "thread", type: 7 as const, description: "Developer's private thread", required: true },
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
    const thread = interaction.options.getChannel("thread", true);

    if (
      thread.type !== ChannelType.PrivateThread ||
      !("guildId" in thread) ||
      thread.guildId !== interaction.guild.id ||
      thread.parentId === null
    ) {
      await interaction.editReply("The thread must be a private thread in this server.");
      return;
    }

    const channel = thread.parent ?? await interaction.guild.channels
      .fetch(thread.parentId)
      .catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== interaction.guild.id) {
      await interaction.editReply(
        "I can't access the selected thread's parent text channel. Give me **View Channel** permission on it, then try again.",
      );
      return;
    }

    const botMember = interaction.guild.members.me;
    const channelPermissions = botMember ? channel.permissionsFor(botMember) : null;
    const threadPermissions = botMember ? thread.permissionsFor(botMember) : null;
    if (
      !channelPermissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ]) ||
      !threadPermissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.EmbedLinks,
      ])
    ) {
      await interaction.editReply(
        "I still need View Channel, Send Messages, Embed Links, and Send Messages in Threads for those destinations.",
      );
      return;
    }

    await setDeveloperRelayRoute({
      guildId: interaction.guild.id,
      discordId: developer.id,
      developerChannelId: channel.id,
      privateThreadId: thread.id,
      createdBy: interaction.user.id,
    });
    await interaction.editReply({
      content:
        `Relay enabled for <@${developer.id}>.\n` +
        `Default: <#${thread.id}>\n` +
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
        `Private thread: <#${route.private_thread_id}>`,
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
