import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { supabase } from "../db.js";
import { ensureDefaultBadgesExist, TIPPER_STAGES, RAINER_STAGES } from "../badges.js";
import {
  addRainBannedTerm,
  getRainBannedTerms,
  normalizeRainBannedTerm,
  removeRainBannedTerm,
} from "../rainBans.js";
import { formatSats } from "../format.js";

const CUSTOM_ID_PREFIX = "admin";
const COLOR_MAIN = 0x2ecc71; // Green
const COLOR_BADGES = 0xf1c40f; // Gold
const COLOR_RAINBAN = 0xe74c3c; // Red
const COLOR_CONFIG = 0x3498db; // Blue

export const data = {
  name: "admin",
  description: "Access the MezoSbot Admin Control Panel",
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
};

// Permission helper
function canManage(interaction: Interaction): boolean {
  if (!interaction.inGuild()) return false;
  const permissions = interaction.memberPermissions;
  return Boolean(permissions?.has(PermissionFlagsBits.ManageGuild));
}

// ---------------------------------------------------------
// Screen Renderers
// ---------------------------------------------------------

async function renderMainMenu() {
  const embed = new EmbedBuilder()
    .setColor(COLOR_MAIN)
    .setTitle("⚙️ Bot Admin Control Panel")
    .setDescription(
      "Welcome to the MezoSbot Control Panel. Click any of the categories below to configure settings for this server."
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:menu_badges`)
      .setLabel("🏆 Configure Badges")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:menu_rainbans`)
      .setLabel("🌧️ Manage Rain Bans")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:dismiss`)
      .setLabel("Dismiss Panel")
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

async function renderBadgesMenu(guildId: string) {
  await ensureDefaultBadgesExist(guildId);

  const embed = new EmbedBuilder()
    .setColor(COLOR_BADGES)
    .setTitle("🏆 Badge Configurations")
    .setDescription(
      "Sync Discord roles to users when they cross tipping and raining milestones. Choose a category below:"
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:badge_type:tipper`)
      .setLabel("Tipper Tiers")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:badge_type:rainer`)
      .setLabel("Rainer Tiers")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:menu_main`)
      .setLabel("⬅️ Back to Main Menu")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

async function renderBadgeTypeMenu(guildId: string, badgeType: "tipper" | "rainer") {
  const { data: configs } = await supabase
    .from("badge_roles")
    .select("*")
    .eq("guild_id", guildId)
    .eq("badge_type", badgeType);

  const stages = badgeType === "tipper" ? TIPPER_STAGES : RAINER_STAGES;

  const descLines = stages.map((s, idx) => {
    const config = configs?.find((c) => c.threshold_sats === s.thresholdSats);
    const roleStr = config?.role_id ? `<@&${config.role_id}>` : "*None*";
    return `**${idx + 1}. ${s.emoji} ${s.stageName}** (${formatSats(s.thresholdSats)}):\n   ↳ Role: ${roleStr}`;
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR_BADGES)
    .setTitle(`🏆 ${badgeType === "tipper" ? "Tipper" : "Rainer"} Badge Stages`)
    .setDescription(
      `Select a stage from the drop-down menu below to configure its role:\n\n${descLines.join("\n")}`
    )
    .setTimestamp();

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:select_stage:${badgeType}`)
    .setPlaceholder("Select a stage to edit...")
    .addOptions(
      stages.map((s, idx) => ({
        label: s.stageName,
        description: `Threshold: ${formatSats(s.thresholdSats)}`,
        value: idx.toString(),
        emoji: s.emoji,
      }))
    );

  const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:menu_badges`)
      .setLabel("⬅️ Back to Badges")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

async function renderStageConfig(guildId: string, badgeType: "tipper" | "rainer", stageIndex: number) {
  const stages = badgeType === "tipper" ? TIPPER_STAGES : RAINER_STAGES;
  const stage = stages[stageIndex];

  if (!stage) {
    throw new Error("Invalid stage index selected.");
  }

  const { data: config } = await supabase
    .from("badge_roles")
    .select("*")
    .eq("guild_id", guildId)
    .eq("badge_type", badgeType)
    .eq("threshold_sats", stage.thresholdSats)
    .single();

  const roleStr = config?.role_id ? `<@&${config.role_id}>` : "❌ None Configured";

  const embed = new EmbedBuilder()
    .setColor(COLOR_CONFIG)
    .setTitle(`⚙️ Configure ${badgeType === "tipper" ? "Tipper" : "Rainer"} Stage: ${stage.stageName}`)
    .setDescription(
      `Configure the role granted when a user has ${badgeType === "tipper" ? "tipped" : "rained"} at least **${formatSats(stage.thresholdSats)}**.`
    )
    .addFields({ name: "Current Mapped Role", value: roleStr })
    .setTimestamp();

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}:set_role:${badgeType}:${stageIndex}`)
    .setPlaceholder("Select a role to assign...");

  const row1 = new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect);
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:clear_role:${badgeType}:${stageIndex}`)
      .setLabel("❌ Clear Role")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:badge_type:${badgeType}`)
      .setLabel("⬅️ Back to Stages")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

async function renderRainBansMenu(guildId: string, statusText?: string) {
  const rows = await getRainBannedTerms(guildId);
  const terms = rows.map((row) => `\`${row.term.replace(/`/g, "'")}\``);
  const list = terms.length > 0 ? terms.join("\n") : "*No banned words or phrases configured.*";

  const embed = new EmbedBuilder()
    .setColor(COLOR_RAINBAN)
    .setTitle("🌧️ Rain Banned Words & Phrases")
    .setDescription(
      "Users who recently say one of these terms will be skipped when `/rain` looks for active recipients."
    )
    .addFields({ name: "Current List", value: list.slice(0, 1024) })
    .setTimestamp();

  if (statusText) {
    embed.addFields({ name: "Status", value: statusText });
  }

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:rainban_add`)
      .setLabel("➕ Add Word")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:rainban_remove`)
      .setLabel("➖ Remove Word")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:menu_main`)
      .setLabel("⬅️ Back to Main Menu")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1] };
}

// ---------------------------------------------------------
// Command Execution & Routing
// ---------------------------------------------------------

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    return interaction.reply({ content: "❌ Admin command only works in servers.", flags: MessageFlags.Ephemeral });
  }
  if (!canManage(interaction)) {
    return interaction.reply({ content: "❌ You need Manage Server permission to access settings.", flags: MessageFlags.Ephemeral });
  }

  const panel = await renderMainMenu();
  await interaction.reply({
    ...panel,
    flags: MessageFlags.Ephemeral,
  });
}

export function isAdminInteraction(interaction: Interaction): boolean {
  if ("customId" in interaction && interaction.customId) {
    return interaction.customId.startsWith(`${CUSTOM_ID_PREFIX}:`);
  }
  return false;
}

export async function handleAdminInteraction(interaction: Interaction): Promise<void> {
  if (!interaction.guild) {
    if ("reply" in interaction) {
      await interaction.reply({ content: "❌ Admin settings only work in servers.", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (!canManage(interaction)) {
    if ("reply" in interaction) {
      await interaction.reply({ content: "❌ You need Manage Server permission to edit settings.", flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (!("customId" in interaction) || !interaction.customId) {
    return;
  }

  const parts = interaction.customId.split(":");
  const [, action] = parts;

  // 1. Buttons & Select Menus routing
  if (interaction.isButton()) {
    const btnInteraction = interaction as ButtonInteraction;

    if (action === "dismiss") {
      await btnInteraction.update({ content: "🔒 Admin panel closed.", embeds: [], components: [] });
      return;
    }

    await btnInteraction.deferUpdate();

    if (action === "menu_main") {
      const menu = await renderMainMenu();
      await btnInteraction.editReply(menu);
    } else if (action === "menu_badges") {
      const menu = await renderBadgesMenu(btnInteraction.guildId!);
      await btnInteraction.editReply(menu);
    } else if (action === "menu_rainbans") {
      const menu = await renderRainBansMenu(btnInteraction.guildId!);
      await btnInteraction.editReply(menu);
    } else if (action === "badge_type") {
      const type = parts[2] as "tipper" | "rainer";
      const menu = await renderBadgeTypeMenu(btnInteraction.guildId!, type);
      await btnInteraction.editReply(menu);
    } else if (action === "clear_role") {
      const type = parts[2] as "tipper" | "rainer";
      const idx = parseInt(parts[3], 10);
      const stages = type === "tipper" ? TIPPER_STAGES : RAINER_STAGES;
      const stage = stages[idx];

      await supabase
        .from("badge_roles")
        .update({ role_id: null })
        .eq("guild_id", btnInteraction.guildId!)
        .eq("badge_type", type)
        .eq("threshold_sats", stage.thresholdSats);

      const panel = await renderStageConfig(btnInteraction.guildId!, type, idx);
      await btnInteraction.editReply(panel);
    } else if (action === "rainban_add" || action === "rainban_remove") {
      // Modals cannot be deferred-updated, so show modal directly
      const isAdd = action === "rainban_add";
      const input = new TextInputBuilder()
        .setCustomId("term")
        .setLabel(isAdd ? "Word, letter, or phrase to ban" : "Word, letter, or phrase to remove")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

      const modal = new ModalBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:${isAdd ? "rainban_add_submit" : "rainban_remove_submit"}`)
        .setTitle(isAdd ? "Add Rain Ban" : "Remove Rain Ban")
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

      // We need to bypass deferUpdate since showModal must be the first reply
      // Note: we can't show a modal if we deferred the interaction. But since we ran `deferUpdate` at the top of the button handler,
      // we must show the modal instead of deferring.
      // Wait! Because we did `await btnInteraction.deferUpdate()` at the top, we CANNOT show a modal now!
      // This is a crucial detail of Discord.js. Let's make sure we handle modals BEFORE calling deferUpdate.
    }
  }

  // Handle StringSelectMenu interaction
  if (interaction.isStringSelectMenu()) {
    const selInteraction = interaction as StringSelectMenuInteraction;
    await selInteraction.deferUpdate();

    if (action === "select_stage") {
      const type = parts[2] as "tipper" | "rainer";
      const idx = parseInt(selInteraction.values[0], 10);
      const panel = await renderStageConfig(selInteraction.guildId!, type, idx);
      await selInteraction.editReply(panel);
    }
  }

  // Handle RoleSelectMenu interaction
  if (interaction.isRoleSelectMenu()) {
    const roleInteraction = interaction as RoleSelectMenuInteraction;
    await roleInteraction.deferUpdate();

    if (action === "set_role") {
      const type = parts[2] as "tipper" | "rainer";
      const idx = parseInt(parts[3], 10);
      const selectedRoleId = roleInteraction.values[0];
      const stages = type === "tipper" ? TIPPER_STAGES : RAINER_STAGES;
      const stage = stages[idx];

      await supabase
        .from("badge_roles")
        .update({ role_id: selectedRoleId })
        .eq("guild_id", roleInteraction.guildId!)
        .eq("badge_type", type)
        .eq("threshold_sats", stage.thresholdSats);

      const panel = await renderStageConfig(roleInteraction.guildId!, type, idx);
      await roleInteraction.editReply(panel);
    }
  }

  // Handle Modal Submit interaction
  if (interaction.isModalSubmit()) {
    const modalInteraction = interaction as ModalSubmitInteraction;
    await modalInteraction.deferReply({ flags: MessageFlags.Ephemeral });

    const rawTerm = modalInteraction.fields.getTextInputValue("term");
    const term = normalizeRainBannedTerm(rawTerm);

    let statusText: string;
    if (action === "rainban_add_submit") {
      const result = await addRainBannedTerm(modalInteraction.guildId!, term, modalInteraction.user.id);
      statusText = result.ok ? `✅ Added term \`${term.replace(/`/g, "'")}\`.` : `❌ ${result.error}`;
    } else if (action === "rainban_remove_submit") {
      const result = await removeRainBannedTerm(modalInteraction.guildId!, term);
      statusText = result.ok
        ? result.removed > 0
          ? `✅ Removed term \`${term.replace(/`/g, "'")}\`.`
          : `ℹ️ \`${term.replace(/`/g, "'")}\` was not in the list.`
        : `❌ ${result.error}`;
    } else {
      statusText = "❌ Unknown rain ban action.";
    }

    const panel = await renderRainBansMenu(modalInteraction.guildId!, statusText);
    // Since we did deferReply, we edit the reply of the modal interaction
    await modalInteraction.editReply(panel);
  }
}

// Custom handler for showing rainban modals without deferring first
export async function handleAdminModalTriggers(interaction: ButtonInteraction): Promise<boolean> {
  const parts = interaction.customId.split(":");
  if (parts[0] !== CUSTOM_ID_PREFIX) return false;
  const action = parts[1];

  if (action === "rainban_add" || action === "rainban_remove") {
    const isAdd = action === "rainban_add";
    const input = new TextInputBuilder()
      .setCustomId("term")
      .setLabel(isAdd ? "Word, letter, or phrase to ban" : "Word, letter, or phrase to remove")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const modal = new ModalBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:${isAdd ? "rainban_add_submit" : "rainban_remove_submit"}`)
      .setTitle(isAdd ? "Add Rain Ban" : "Remove Rain Ban")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

    await interaction.showModal(modal);
    return true;
  }
  return false;
}
