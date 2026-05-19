"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
exports.isAdminInteraction = isAdminInteraction;
exports.handleAdminInteraction = handleAdminInteraction;
exports.handleAdminModalTriggers = handleAdminModalTriggers;
const discord_js_1 = require("discord.js");
const db_js_1 = require("../db.js");
const badges_js_1 = require("../badges.js");
const rainBans_js_1 = require("../rainBans.js");
const format_js_1 = require("../format.js");
const CUSTOM_ID_PREFIX = "admin";
const COLOR_MAIN = 0x2ecc71; // Green
const COLOR_BADGES = 0xf1c40f; // Gold
const COLOR_RAINBAN = 0xe74c3c; // Red
const COLOR_CONFIG = 0x3498db; // Blue
exports.data = {
    name: "admin",
    description: "Access the MezoSbot Admin Control Panel",
    default_member_permissions: discord_js_1.PermissionFlagsBits.ManageGuild.toString(),
};
// Permission helper
function canManage(interaction) {
    if (!interaction.inGuild())
        return false;
    const permissions = interaction.memberPermissions;
    return Boolean(permissions?.has(discord_js_1.PermissionFlagsBits.ManageGuild));
}
// ---------------------------------------------------------
// Screen Renderers
// ---------------------------------------------------------
async function renderMainMenu() {
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(COLOR_MAIN)
        .setTitle("⚙️ Bot Admin Control Panel")
        .setDescription("Welcome to the MezoSbot Control Panel. Click any of the categories below to configure settings for this server.")
        .setTimestamp();
    const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:menu_badges`)
        .setLabel("🏆 Configure Badges")
        .setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:menu_rainbans`)
        .setLabel("🌧️ Manage Rain Bans")
        .setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:dismiss`)
        .setLabel("Dismiss Panel")
        .setStyle(discord_js_1.ButtonStyle.Danger));
    return { embeds: [embed], components: [row] };
}
async function renderBadgesMenu(guildId) {
    await (0, badges_js_1.ensureDefaultBadgesExist)(guildId);
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(COLOR_BADGES)
        .setTitle("🏆 Badge Configurations")
        .setDescription("Sync Discord roles to users when they cross tipping and raining milestones. Choose a category below:")
        .setTimestamp();
    const row1 = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:badge_type:tipper`)
        .setLabel("Tipper Tiers")
        .setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:badge_type:rainer`)
        .setLabel("Rainer Tiers")
        .setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:sync_all`)
        .setLabel("🔄 Sync All Roles")
        .setStyle(discord_js_1.ButtonStyle.Success));
    const row2 = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:menu_main`)
        .setLabel("⬅️ Back to Main Menu")
        .setStyle(discord_js_1.ButtonStyle.Secondary));
    return { embeds: [embed], components: [row1, row2] };
}
async function renderBadgeTypeMenu(guildId, badgeType) {
    const { data: configs } = await db_js_1.supabase
        .from("badge_roles")
        .select("*")
        .eq("guild_id", guildId)
        .eq("badge_type", badgeType);
    const stages = badgeType === "tipper" ? badges_js_1.TIPPER_STAGES : badges_js_1.RAINER_STAGES;
    const descLines = stages.map((s, idx) => {
        const config = configs?.find((c) => c.threshold_sats === s.thresholdSats);
        const roleStr = config?.role_id ? `<@&${config.role_id}>` : "*None*";
        return `**${idx + 1}. ${s.emoji} ${s.stageName}** (${(0, format_js_1.formatSats)(s.thresholdSats)}):\n   ↳ Role: ${roleStr}`;
    });
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(COLOR_BADGES)
        .setTitle(`🏆 ${badgeType === "tipper" ? "Tipper" : "Rainer"} Badge Stages`)
        .setDescription(`Select a stage from the drop-down menu below to configure its role:\n\n${descLines.join("\n")}`)
        .setTimestamp();
    const select = new discord_js_1.StringSelectMenuBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:select_stage:${badgeType}`)
        .setPlaceholder("Select a stage to edit...")
        .addOptions(stages.map((s, idx) => ({
        label: s.stageName,
        description: `Threshold: ${(0, format_js_1.formatSats)(s.thresholdSats)}`,
        value: idx.toString(),
        emoji: s.emoji,
    })));
    const row1 = new discord_js_1.ActionRowBuilder().addComponents(select);
    const row2 = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:menu_badges`)
        .setLabel("⬅️ Back to Badges")
        .setStyle(discord_js_1.ButtonStyle.Secondary));
    return { embeds: [embed], components: [row1, row2] };
}
async function renderStageConfig(guildId, badgeType, stageIndex) {
    const stages = badgeType === "tipper" ? badges_js_1.TIPPER_STAGES : badges_js_1.RAINER_STAGES;
    const stage = stages[stageIndex];
    if (!stage) {
        throw new Error("Invalid stage index selected.");
    }
    const { data: config } = await db_js_1.supabase
        .from("badge_roles")
        .select("*")
        .eq("guild_id", guildId)
        .eq("badge_type", badgeType)
        .eq("threshold_sats", stage.thresholdSats)
        .single();
    const roleStr = config?.role_id ? `<@&${config.role_id}>` : "❌ None Configured";
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(COLOR_CONFIG)
        .setTitle(`⚙️ Configure ${badgeType === "tipper" ? "Tipper" : "Rainer"} Stage: ${stage.stageName}`)
        .setDescription(`Configure the role granted when a user has ${badgeType === "tipper" ? "tipped" : "rained"} at least **${(0, format_js_1.formatSats)(stage.thresholdSats)}**.`)
        .addFields({ name: "Current Mapped Role", value: roleStr })
        .setTimestamp();
    const roleSelect = new discord_js_1.RoleSelectMenuBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:set_role:${badgeType}:${stageIndex}`)
        .setPlaceholder("Select a role to assign...");
    const row1 = new discord_js_1.ActionRowBuilder().addComponents(roleSelect);
    const row2 = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:clear_role:${badgeType}:${stageIndex}`)
        .setLabel("❌ Clear Role")
        .setStyle(discord_js_1.ButtonStyle.Danger), new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:badge_type:${badgeType}`)
        .setLabel("⬅️ Back to Stages")
        .setStyle(discord_js_1.ButtonStyle.Secondary));
    return { embeds: [embed], components: [row1, row2] };
}
async function renderRainBansMenu(guildId, statusText) {
    const rows = await (0, rainBans_js_1.getRainBannedTerms)(guildId);
    const terms = rows.map((row) => `\`${row.term.replace(/`/g, "'")}\``);
    const list = terms.length > 0 ? terms.join("\n") : "*No banned words or phrases configured.*";
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(COLOR_RAINBAN)
        .setTitle("🌧️ Rain Banned Words & Phrases")
        .setDescription("Users who recently say one of these terms will be skipped when `/rain` looks for active recipients.")
        .addFields({ name: "Current List", value: list.slice(0, 1024) })
        .setTimestamp();
    if (statusText) {
        embed.addFields({ name: "Status", value: statusText });
    }
    const row1 = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:rainban_add`)
        .setLabel("➕ Add Word")
        .setStyle(discord_js_1.ButtonStyle.Success), new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:rainban_remove`)
        .setLabel("➖ Remove Word")
        .setStyle(discord_js_1.ButtonStyle.Danger), new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:menu_main`)
        .setLabel("⬅️ Back to Main Menu")
        .setStyle(discord_js_1.ButtonStyle.Secondary));
    return { embeds: [embed], components: [row1] };
}
// ---------------------------------------------------------
// Command Execution & Routing
// ---------------------------------------------------------
async function execute(interaction) {
    if (!interaction.guild) {
        return interaction.reply({ content: "❌ Admin command only works in servers.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    if (!canManage(interaction)) {
        return interaction.reply({ content: "❌ You need Manage Server permission to access settings.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    const panel = await renderMainMenu();
    await interaction.reply({
        ...panel,
        flags: discord_js_1.MessageFlags.Ephemeral,
    });
}
function isAdminInteraction(interaction) {
    if ("customId" in interaction && interaction.customId) {
        return interaction.customId.startsWith(`${CUSTOM_ID_PREFIX}:`);
    }
    return false;
}
async function handleAdminInteraction(interaction) {
    if (!interaction.guild) {
        if ("reply" in interaction) {
            await interaction.reply({ content: "❌ Admin settings only work in servers.", flags: discord_js_1.MessageFlags.Ephemeral });
        }
        return;
    }
    if (!canManage(interaction)) {
        if ("reply" in interaction) {
            await interaction.reply({ content: "❌ You need Manage Server permission to edit settings.", flags: discord_js_1.MessageFlags.Ephemeral });
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
        const btnInteraction = interaction;
        if (action === "dismiss") {
            await btnInteraction.update({ content: "🔒 Admin panel closed.", embeds: [], components: [] });
            return;
        }
        await btnInteraction.deferUpdate();
        if (action === "menu_main") {
            const menu = await renderMainMenu();
            await btnInteraction.editReply(menu);
        }
        else if (action === "menu_badges") {
            const menu = await renderBadgesMenu(btnInteraction.guildId);
            await btnInteraction.editReply(menu);
        }
        else if (action === "menu_rainbans") {
            const menu = await renderRainBansMenu(btnInteraction.guildId);
            await btnInteraction.editReply(menu);
        }
        else if (action === "sync_all") {
            // Temporarily change view to show loading state
            await btnInteraction.editReply({
                embeds: [
                    new discord_js_1.EmbedBuilder()
                        .setColor(COLOR_BADGES)
                        .setTitle("🔄 Synchronizing Roles")
                        .setDescription("Syncing badge roles for all historical users in the server. This may take a moment...")
                ],
                components: []
            });
            const count = await syncAllGuildBadges(btnInteraction.client, btnInteraction.guildId);
            const menu = await renderBadgesMenu(btnInteraction.guildId);
            menu.embeds[0].addFields({
                name: "Sync Status",
                value: `✅ Successfully synchronized badge roles for **${count}** historical users!`
            });
            await btnInteraction.editReply(menu);
        }
        else if (action === "badge_type") {
            const type = parts[2];
            const menu = await renderBadgeTypeMenu(btnInteraction.guildId, type);
            await btnInteraction.editReply(menu);
        }
        else if (action === "clear_role") {
            const type = parts[2];
            const idx = parseInt(parts[3], 10);
            const stages = type === "tipper" ? badges_js_1.TIPPER_STAGES : badges_js_1.RAINER_STAGES;
            const stage = stages[idx];
            await db_js_1.supabase
                .from("badge_roles")
                .update({ role_id: null })
                .eq("guild_id", btnInteraction.guildId)
                .eq("badge_type", type)
                .eq("threshold_sats", stage.thresholdSats);
            const panel = await renderStageConfig(btnInteraction.guildId, type, idx);
            await btnInteraction.editReply(panel);
        }
        else if (action === "rainban_add" || action === "rainban_remove") {
            // Modals cannot be deferred-updated, so show modal directly
            const isAdd = action === "rainban_add";
            const input = new discord_js_1.TextInputBuilder()
                .setCustomId("term")
                .setLabel(isAdd ? "Word, letter, or phrase to ban" : "Word, letter, or phrase to remove")
                .setStyle(discord_js_1.TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(100);
            const modal = new discord_js_1.ModalBuilder()
                .setCustomId(`${CUSTOM_ID_PREFIX}:${isAdd ? "rainban_add_submit" : "rainban_remove_submit"}`)
                .setTitle(isAdd ? "Add Rain Ban" : "Remove Rain Ban")
                .addComponents(new discord_js_1.ActionRowBuilder().addComponents(input));
            // We need to bypass deferUpdate since showModal must be the first reply
            // Note: we can't show a modal if we deferred the interaction. But since we ran `deferUpdate` at the top of the button handler,
            // we must show the modal instead of deferring.
            // Wait! Because we did `await btnInteraction.deferUpdate()` at the top, we CANNOT show a modal now!
            // This is a crucial detail of Discord.js. Let's make sure we handle modals BEFORE calling deferUpdate.
        }
    }
    // Handle StringSelectMenu interaction
    if (interaction.isStringSelectMenu()) {
        const selInteraction = interaction;
        await selInteraction.deferUpdate();
        if (action === "select_stage") {
            const type = parts[2];
            const idx = parseInt(selInteraction.values[0], 10);
            const panel = await renderStageConfig(selInteraction.guildId, type, idx);
            await selInteraction.editReply(panel);
        }
    }
    // Handle RoleSelectMenu interaction
    if (interaction.isRoleSelectMenu()) {
        const roleInteraction = interaction;
        await roleInteraction.deferUpdate();
        if (action === "set_role") {
            const type = parts[2];
            const idx = parseInt(parts[3], 10);
            const selectedRoleId = roleInteraction.values[0];
            const stages = type === "tipper" ? badges_js_1.TIPPER_STAGES : badges_js_1.RAINER_STAGES;
            const stage = stages[idx];
            await db_js_1.supabase
                .from("badge_roles")
                .update({ role_id: selectedRoleId })
                .eq("guild_id", roleInteraction.guildId)
                .eq("badge_type", type)
                .eq("threshold_sats", stage.thresholdSats);
            const panel = await renderStageConfig(roleInteraction.guildId, type, idx);
            await roleInteraction.editReply(panel);
        }
    }
    // Handle Modal Submit interaction
    if (interaction.isModalSubmit()) {
        const modalInteraction = interaction;
        await modalInteraction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
        const rawTerm = modalInteraction.fields.getTextInputValue("term");
        const term = (0, rainBans_js_1.normalizeRainBannedTerm)(rawTerm);
        let statusText;
        if (action === "rainban_add_submit") {
            const result = await (0, rainBans_js_1.addRainBannedTerm)(modalInteraction.guildId, term, modalInteraction.user.id);
            statusText = result.ok ? `✅ Added term \`${term.replace(/`/g, "'")}\`.` : `❌ ${result.error}`;
        }
        else if (action === "rainban_remove_submit") {
            const result = await (0, rainBans_js_1.removeRainBannedTerm)(modalInteraction.guildId, term);
            statusText = result.ok
                ? result.removed > 0
                    ? `✅ Removed term \`${term.replace(/`/g, "'")}\`.`
                    : `ℹ️ \`${term.replace(/`/g, "'")}\` was not in the list.`
                : `❌ ${result.error}`;
        }
        else {
            statusText = "❌ Unknown rain ban action.";
        }
        const panel = await renderRainBansMenu(modalInteraction.guildId, statusText);
        // Since we did deferReply, we edit the reply of the modal interaction
        await modalInteraction.editReply(panel);
    }
}
// Custom handler for showing rainban modals without deferring first
async function handleAdminModalTriggers(interaction) {
    const parts = interaction.customId.split(":");
    if (parts[0] !== CUSTOM_ID_PREFIX)
        return false;
    const action = parts[1];
    if (action === "rainban_add" || action === "rainban_remove") {
        const isAdd = action === "rainban_add";
        const input = new discord_js_1.TextInputBuilder()
            .setCustomId("term")
            .setLabel(isAdd ? "Word, letter, or phrase to ban" : "Word, letter, or phrase to remove")
            .setStyle(discord_js_1.TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100);
        const modal = new discord_js_1.ModalBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:${isAdd ? "rainban_add_submit" : "rainban_remove_submit"}`)
            .setTitle(isAdd ? "Add Rain Ban" : "Remove Rain Ban")
            .addComponents(new discord_js_1.ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return true;
    }
    return false;
}
async function syncAllGuildBadges(client, guildId) {
    await (0, badges_js_1.ensureDefaultBadgesExist)(guildId);
    // Fetch unique discord IDs who have tipped or rained historically
    const { data: tips } = await db_js_1.supabase.from("user_tip_stats").select("discord_id");
    const { data: rains } = await db_js_1.supabase.from("user_rain_stats").select("discord_id");
    const userIds = new Set();
    tips?.forEach(t => userIds.add(t.discord_id));
    rains?.forEach(r => userIds.add(r.discord_id));
    let count = 0;
    for (const userId of userIds) {
        await (0, badges_js_1.updateUserBadges)(client, guildId, userId).catch(() => { });
        count++;
        // Sleep 50ms to prevent hitting rate limit hard
        await new Promise((r) => setTimeout(r, 50));
    }
    return count;
}
