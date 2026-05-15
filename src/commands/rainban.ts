import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  addRainBannedTerm,
  getRainBannedTerms,
  normalizeRainBannedTerm,
  removeRainBannedTerm,
  type RainBannedTermRow,
} from "../rainBans.js";

const CUSTOM_ID_PREFIX = "rainban";
const RAINBAN_COLOR = 0x3498db;

export const data = {
  name: "rainban",
  description: "Manage words and phrases that exclude users from rain",
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
};

function customId(action: string): string {
  return `${CUSTOM_ID_PREFIX}:${action}`;
}

function buildEmbed(rows: RainBannedTermRow[], status?: string): EmbedBuilder {
  const terms = rows.map((row) => `\`${row.term.replace(/`/g, "'")}\``);
  const list = terms.length > 0 ? terms.join("\n") : "No banned words or phrases configured.";

  const embed = new EmbedBuilder()
    .setColor(RAINBAN_COLOR)
    .setTitle("Rain Banned Words")
    .setDescription("Users who recently say one of these terms are skipped when `/rain` searches for recipients.")
    .addFields({ name: "Current List", value: list.slice(0, 1024) })
    .setFooter({ text: "Matches are case-insensitive and can be a word, letter, or phrase." })
    .setTimestamp();

  if (status) {
    embed.addFields({ name: "Status", value: status.slice(0, 1024) });
  }

  return embed;
}

function buildComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(customId("add"))
        .setLabel("Add")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(customId("remove"))
        .setLabel("Remove")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function renderPanel(guildId: string, status?: string) {
  const rows = await getRainBannedTerms(guildId);
  return {
    embeds: [buildEmbed(rows, status)],
    components: buildComponents(),
    allowedMentions: { parse: [] as never[] },
  };
}

function canManage(interaction: ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction): boolean {
  if (!interaction.inGuild()) return false;
  const permissions = interaction.memberPermissions;
  return Boolean(permissions?.has(PermissionFlagsBits.ManageGuild));
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "Rain banned words only work in servers.", flags: MessageFlags.Ephemeral });
  }
  if (!canManage(interaction)) {
    return interaction.reply({ content: "You need Manage Server permission to edit rain banned words.", flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({
    ...(await renderPanel(interaction.guild.id)),
    flags: MessageFlags.Ephemeral,
  });
}

export function isRainBanInteraction(interaction: Interaction): boolean {
  if (interaction.isButton() || interaction.isModalSubmit()) {
    return interaction.customId.startsWith(`${CUSTOM_ID_PREFIX}:`);
  }
  return false;
}

export async function handleRainBanInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isButton()) return handleButton(interaction);
  if (interaction.isModalSubmit()) return handleModal(interaction);
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "Rain banned words only work in servers.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!canManage(interaction)) {
    await interaction.reply({ content: "You need Manage Server permission to edit rain banned words.", flags: MessageFlags.Ephemeral });
    return;
  }

  const [, action] = interaction.customId.split(":");
  if (action !== "add" && action !== "remove") return;

  const input = new TextInputBuilder()
    .setCustomId("term")
    .setLabel(action === "add" ? "Word, letter, or phrase to ban" : "Word, letter, or phrase to remove")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  const modal = new ModalBuilder()
    .setCustomId(customId(action === "add" ? "add_submit" : "remove_submit"))
    .setTitle(action === "add" ? "Add Rain Ban" : "Remove Rain Ban")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

  await interaction.showModal(modal);
}

async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "Rain banned words only work in servers.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!canManage(interaction)) {
    await interaction.reply({ content: "You need Manage Server permission to edit rain banned words.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [, action] = interaction.customId.split(":");
  const rawTerm = interaction.fields.getTextInputValue("term");
  const term = normalizeRainBannedTerm(rawTerm);

  let status: string;
  if (action === "add_submit") {
    const result = await addRainBannedTerm(interaction.guild.id, term, interaction.user.id);
    status = result.ok ? `Added \`${term.replace(/`/g, "'")}\`.` : result.error;
  } else if (action === "remove_submit") {
    const result = await removeRainBannedTerm(interaction.guild.id, term);
    status = result.ok
      ? result.removed > 0
        ? `Removed \`${term.replace(/`/g, "'")}\`.`
        : `\`${term.replace(/`/g, "'")}\` was not on the list.`
      : result.error;
  } else {
    status = "Unknown rain ban action.";
  }

  await interaction.editReply(await renderPanel(interaction.guild.id, status));
}
