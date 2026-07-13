"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
exports.isAdminInteraction = isAdminInteraction;
exports.handleAdminInteraction = handleAdminInteraction;
exports.handleAdminModalTriggers = handleAdminModalTriggers;
const discord_js_1 = require("discord.js");
const ledger_js_1 = require("../ledger.js");
const db_js_1 = require("../db.js");
const badges_js_1 = require("../badges.js");
const rainBans_js_1 = require("../rainBans.js");
const format_js_1 = require("../format.js");
const catalog_js_1 = require("../imgnai/catalog.js");
const payments_js_1 = require("../imgnai/payments.js");
const types_js_1 = require("../imgnai/types.js");
const CUSTOM_ID_PREFIX = "admin";
const COLOR_MAIN = 0x2ecc71; // Green
const COLOR_BADGES = 0xf1c40f; // Gold
const COLOR_RAINBAN = 0xe74c3c; // Red
const COLOR_CONFIG = 0x3498db; // Blue
const COLOR_LEDGER = 0x2ecc71; // Green
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
        .setCustomId(`${CUSTOM_ID_PREFIX}:menu_quests`)
        .setLabel("⚔️ Manage Quests")
        .setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:menu_ledger`)
        .setLabel("📒 Transaction Ledger")
        .setStyle(discord_js_1.ButtonStyle.Primary), new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:dismiss`)
        .setLabel("Dismiss Panel")
        .setStyle(discord_js_1.ButtonStyle.Danger));
    const row2 = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:menu_imgnai`)
        .setLabel("imgnAI Models")
        .setStyle(discord_js_1.ButtonStyle.Primary));
    return { embeds: [embed], components: [row, row2] };
}
async function renderImgnaiMenu(guildId, page, statusText) {
    const [models, disabled, operations] = await Promise.all([
        (0, catalog_js_1.refreshKatanaModels)(),
        (0, catalog_js_1.getDisabledModelKeys)(guildId),
        (0, payments_js_1.getImgnaiOperationalStatus)(),
    ]);
    const pageModels = models.filter((model) => model.isLegacy === (page === "legacy"));
    const health = (0, catalog_js_1.getCatalogHealth)();
    const lines = pageModels.map((model) => `${disabled.has(model.modelKey) ? "🔴" : "🟢"} **${model.displayName}** · ${(0, types_js_1.formatMusd)(model.costMusdAtomic)}`);
    const satsLiability = operations.userSatsLiability == null || operations.poolSatsLiability == null
        ? null
        : operations.userSatsLiability + operations.poolSatsLiability;
    const satsExcess = operations.treasurySats == null || satsLiability == null
        ? null
        : operations.treasurySats - satsLiability;
    const musdAssets = operations.treasuryMusd == null || operations.katanaMusd == null || operations.unsweptMusdAtomic == null
        ? null
        : operations.treasuryMusd + operations.katanaMusd + operations.unsweptMusdAtomic;
    const musdObligations = operations.userMusdAtomic == null || operations.pendingMusdAtomic == null
        ? null
        : operations.userMusdAtomic + operations.pendingMusdAtomic;
    const operational = [
        `Treasury: **${operations.treasuryMusd == null ? "Unavailable" : (0, types_js_1.formatMusd)(operations.treasuryMusd)}**`,
        `Katana wallet: **${operations.katanaMusd == null ? "Unavailable" : (0, types_js_1.formatMusd)(operations.katanaMusd)}**`,
        `Unswept MUSD: **${operations.unsweptMusdAtomic == null ? "Unavailable" : (0, types_js_1.formatMusd)(operations.unsweptMusdAtomic)}**`,
        `MUSD coverage: **${musdAssets == null || musdObligations == null ? "Unavailable" : `${(0, types_js_1.formatMusd)(musdAssets)} assets / ${(0, types_js_1.formatMusd)(musdObligations)} obligations`}**`,
        `SATS backing: **${operations.treasurySats == null || satsLiability == null ? "Unavailable" : `${(0, format_js_1.formatSats)(operations.treasurySats)} / ${(0, format_js_1.formatSats)(satsLiability)} liabilities`}**`,
        `Treasury excess: **${satsExcess == null ? "Unavailable" : (0, format_js_1.formatSats)(satsExcess)}** · required reserve ${(0, format_js_1.formatSats)(operations.gasReserveMinimumSats)}`,
        `Sweep gas sponsor: **${operations.gasSponsorSats == null ? "Unavailable" : (0, format_js_1.formatSats)(operations.gasSponsorSats)}**${operations.gasSponsorIsTreasury ? " · ⚠ treasury fallback" : " · dedicated"}`,
        `Sweeps: **${operations.pendingSweeps ?? "Unavailable"} pending** · **${operations.sweepErrors ?? "Unavailable"} errors**`,
        `Pending jobs: **${operations.pendingJobs}**`,
        `Catalog: **${health.cachedModels} SFW models**${health.cacheAgeMs == null ? "" : ` · refreshed ${Math.floor(health.cacheAgeMs / 1000)}s ago`}`,
    ].join("\n");
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(COLOR_CONFIG)
        .setTitle(`imgnAI Models · ${page === "current" ? "Current" : "Legacy"}`)
        .setDescription(`${statusText ? `${statusText}\n\n` : ""}${lines.join("\n") || "No models are available on this page."}`)
        .addFields({ name: "Payment health", value: operational })
        .setFooter({ text: "New SFW models are enabled by default for this server." })
        .setTimestamp();
    if (health.lastError)
        embed.addFields({ name: "Catalog warning", value: health.lastError.slice(0, 1024) });
    const warnings = [
        satsExcess != null && satsExcess < operations.gasReserveMinimumSats ? "Treasury SATS excess is below the protected gas reserve." : null,
        operations.gasSponsorSats != null && operations.gasSponsorSats < operations.gasReserveMinimumSats ? "Sweep gas sponsor is below its minimum reserve." : null,
        musdAssets != null && musdObligations != null && musdAssets < musdObligations ? "MUSD assets are below user and pending-job obligations." : null,
        operations.sweepErrors ? `${operations.sweepErrors} ERC-20 sweep checkpoint(s) have errors.` : null,
        operations.lastSweepGasError,
    ].filter((item) => !!item);
    if (warnings.length > 0)
        embed.addFields({ name: "Operational warnings", value: warnings.join("\n").slice(0, 1024) });
    const components = [];
    if (pageModels.length > 0) {
        components.push(new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.StringSelectMenuBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:imgnai_select:${page}`)
            .setPlaceholder("Choose a model to manage")
            .addOptions(pageModels.slice(0, 25).map((model) => ({
            label: model.displayName.slice(0, 100),
            value: model.modelKey,
            description: `${disabled.has(model.modelKey) ? "Disabled" : "Enabled"} · ${(0, types_js_1.formatMusd)(model.costMusdAtomic)}`.slice(0, 100),
        })))));
    }
    components.push(new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:imgnai_page:${page === "current" ? "legacy" : "current"}`)
        .setLabel(page === "current" ? "Legacy models" : "Current models")
        .setStyle(discord_js_1.ButtonStyle.Secondary), new discord_js_1.ButtonBuilder().setCustomId(`${CUSTOM_ID_PREFIX}:menu_main`).setLabel("Back").setStyle(discord_js_1.ButtonStyle.Secondary)));
    return { embeds: [embed], components };
}
async function renderImgnaiModelDetail(guildId, modelKey, page) {
    const [models, disabled] = await Promise.all([(0, catalog_js_1.refreshKatanaModels)(), (0, catalog_js_1.getDisabledModelKeys)(guildId)]);
    const model = models.find((item) => item.modelKey === modelKey);
    if (!model)
        return renderImgnaiMenu(guildId, page, "That model is no longer in the Katana catalog.");
    const enabled = !disabled.has(model.modelKey);
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(enabled ? COLOR_MAIN : COLOR_RAINBAN)
        .setTitle(model.displayName)
        .setDescription(model.description || "No description provided.")
        .addFields({ name: "Status", value: enabled ? "Enabled" : "Disabled", inline: true }, { name: "Creator", value: model.creator || "imgnAI", inline: true }, { name: "Cost", value: (0, types_js_1.formatMusd)(model.costMusdAtomic), inline: true }, { name: "Quality", value: model.supportsUhd ? "Standard and UHD" : "Standard", inline: true }, { name: "Aspect ratios", value: model.aspectRatios.join(", ").slice(0, 1024), inline: false });
    const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:imgnai_toggle:${model.modelKey}:${page}:${enabled ? "disable" : "enable"}`)
        .setLabel(enabled ? "Disable model" : "Enable model")
        .setStyle(enabled ? discord_js_1.ButtonStyle.Danger : discord_js_1.ButtonStyle.Success), new discord_js_1.ButtonBuilder().setCustomId(`${CUSTOM_ID_PREFIX}:imgnai_page:${page}`).setLabel("Back to models").setStyle(discord_js_1.ButtonStyle.Secondary));
    return { embeds: [embed], components: [row] };
}
async function renderLedgerMenu(guildId) {
    const config = await (0, ledger_js_1.getLedgerChannelConfig)();
    const channelLine = config
        ? `**Current ledger channel:** <#${config.channelId}> (guild \`${config.guildId}\`)\n\nAll bot transactions are posted here.`
        : "**Ledger channel:** Not configured\n\nPick a text channel below. This applies **bot-wide** (all servers).";
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(COLOR_LEDGER)
        .setTitle("📒 Transaction Ledger")
        .setDescription(channelLine)
        .setTimestamp();
    const channelSelect = new discord_js_1.ChannelSelectMenuBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:ledger_channel_select`)
        .setPlaceholder("Select ledger channel…")
        .addChannelTypes(discord_js_1.ChannelType.GuildText, discord_js_1.ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1);
    const row1 = new discord_js_1.ActionRowBuilder().addComponents(channelSelect);
    const row2 = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:ledger_clear`)
        .setLabel("Clear Ledger Channel")
        .setStyle(discord_js_1.ButtonStyle.Danger)
        .setDisabled(!config), new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:menu_main`)
        .setLabel("← Back")
        .setStyle(discord_js_1.ButtonStyle.Secondary));
    return { embeds: [embed], components: [row1, row2] };
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
async function renderQuestsMenu(guildId) {
    const { data: quests, error } = await db_js_1.supabase
        .from("quests")
        .select("id, title, starts_at, max_reward_sats, creator_id")
        .eq("guild_id", guildId)
        .eq("status", "active")
        .order("id", { ascending: false });
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x77a7ff)
        .setTitle("⚔️ Manage Guild Quests")
        .setDescription("Select an active quest from the dropdown below to view details and cancel/delete it.")
        .setTimestamp();
    if (error) {
        embed.setDescription(`❌ Error fetching quests: ${error.message}`);
        const backRow = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:menu_main`)
            .setLabel("⬅️ Back to Main Menu")
            .setStyle(discord_js_1.ButtonStyle.Secondary));
        return { embeds: [embed], components: [backRow] };
    }
    if (!quests || quests.length === 0) {
        embed.setDescription("ℹ️ There are currently no active quests in this server.");
        const backRow = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:menu_main`)
            .setLabel("⬅️ Back to Main Menu")
            .setStyle(discord_js_1.ButtonStyle.Secondary));
        return { embeds: [embed], components: [backRow] };
    }
    // Create select menu
    const selectMenu = new discord_js_1.StringSelectMenuBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:quest_select`)
        .setPlaceholder("Select a quest to manage...")
        .addOptions(quests.map((q) => ({
        label: `${q.title.slice(0, 50)} (ID: ${q.id})`,
        description: `Max payout: ${q.max_reward_sats} sats`,
        value: String(q.id),
    })));
    const selectRow = new discord_js_1.ActionRowBuilder().addComponents(selectMenu);
    const backRow = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:menu_main`)
        .setLabel("⬅️ Back to Main Menu")
        .setStyle(discord_js_1.ButtonStyle.Secondary));
    return { embeds: [embed], components: [selectRow, backRow] };
}
async function renderQuestDetail(guildId, questId) {
    const { data: quest, error } = await db_js_1.supabase
        .from("quests")
        .select("*")
        .eq("id", questId)
        .single();
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x77a7ff)
        .setTitle("⚔️ Quest Details")
        .setTimestamp();
    if (error || !quest) {
        embed.setColor(0xff3333).setDescription("❌ Quest not found or has already been deleted.");
        const backRow = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
            .setCustomId(`${CUSTOM_ID_PREFIX}:menu_quests`)
            .setLabel("⬅️ Back to Quests")
            .setStyle(discord_js_1.ButtonStyle.Secondary));
        return { embeds: [embed], components: [backRow] };
    }
    embed.setTitle(`⚔️ Quest: ${quest.title}`);
    embed.setDescription(quest.description || "No description provided.");
    embed.addFields({ name: "Quest ID", value: String(quest.id), inline: true }, { name: "Status", value: quest.status, inline: true }, { name: "Creator", value: `<@${quest.creator_id}>`, inline: true }, { name: "Max Reward", value: `${quest.max_reward_sats} sats`, inline: true });
    const actionRow = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:delete_quest:${quest.id}`)
        .setLabel("🚫 Cancel & Delete Quest")
        .setStyle(discord_js_1.ButtonStyle.Danger), new discord_js_1.ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:menu_quests`)
        .setLabel("⬅️ Back to Quests")
        .setStyle(discord_js_1.ButtonStyle.Secondary));
    return { embeds: [embed], components: [actionRow] };
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
        else if (action === "menu_quests") {
            const menu = await renderQuestsMenu(btnInteraction.guildId);
            await btnInteraction.editReply(menu);
        }
        else if (action === "menu_ledger") {
            const menu = await renderLedgerMenu(btnInteraction.guildId);
            await btnInteraction.editReply(menu);
        }
        else if (action === "menu_imgnai") {
            await btnInteraction.editReply(await renderImgnaiMenu(btnInteraction.guildId, "current"));
        }
        else if (action === "imgnai_page") {
            const page = parts[2] === "legacy" ? "legacy" : "current";
            await btnInteraction.editReply(await renderImgnaiMenu(btnInteraction.guildId, page));
        }
        else if (action === "imgnai_toggle") {
            const modelKey = parts[2];
            const page = parts[3] === "legacy" ? "legacy" : "current";
            const enabled = parts[4] === "enable";
            await (0, catalog_js_1.setGuildModelEnabled)(btnInteraction.guildId, modelKey, enabled, btnInteraction.user.id);
            await btnInteraction.editReply(await renderImgnaiModelDetail(btnInteraction.guildId, modelKey, page));
        }
        else if (action === "ledger_clear") {
            await (0, ledger_js_1.clearLedgerChannelConfig)();
            const menu = await renderLedgerMenu(btnInteraction.guildId);
            menu.embeds[0].setDescription("**Ledger channel cleared.** Transactions are still saved in the database but will not be posted to Discord until you configure a channel again.");
            await btnInteraction.editReply(menu);
        }
        else if (action === "delete_quest") {
            const questId = parseInt(parts[2], 10);
            const fresh = await db_js_1.supabase.from("quests").select("*").eq("id", questId).single();
            if (fresh.data) {
                if (fresh.data.message_id) {
                    const channel = await btnInteraction.client.channels.fetch(fresh.data.channel_id).catch(() => null);
                    if (channel && "messages" in channel) {
                        const message = await channel.messages.fetch(fresh.data.message_id).catch(() => null);
                        if (message) {
                            await message.delete().catch(() => { });
                        }
                    }
                }
                const legacyEventQuestId = fresh.data.metadata?.legacyEventQuestId;
                if (legacyEventQuestId) {
                    const { data: eq } = await db_js_1.supabase.from("event_quests").select("*").eq("id", legacyEventQuestId).single();
                    if (eq && eq.message_id) {
                        const channel = await btnInteraction.client.channels.fetch(eq.channel_id).catch(() => null);
                        if (channel && "messages" in channel) {
                            const message = await channel.messages.fetch(eq.message_id).catch(() => null);
                            if (message) {
                                await message.delete().catch(() => { });
                            }
                        }
                    }
                    await db_js_1.supabase.from("event_quests").delete().eq("id", legacyEventQuestId);
                }
            }
            await db_js_1.supabase.from("quests").delete().eq("id", questId);
            const menu = await renderQuestsMenu(btnInteraction.guildId);
            menu.embeds[0].setDescription(`✅ Quest **#${questId}** was successfully deleted from the database.`);
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
        else if (action === "quest_select") {
            const questId = parseInt(selInteraction.values[0], 10);
            const panel = await renderQuestDetail(selInteraction.guildId, questId);
            await selInteraction.editReply(panel);
        }
        else if (action === "imgnai_select") {
            const page = parts[2] === "legacy" ? "legacy" : "current";
            await selInteraction.editReply(await renderImgnaiModelDetail(selInteraction.guildId, selInteraction.values[0], page));
        }
    }
    // Handle ChannelSelectMenu interaction
    if (interaction.isChannelSelectMenu()) {
        const chInteraction = interaction;
        await chInteraction.deferUpdate();
        if (action === "ledger_channel_select") {
            const channelId = chInteraction.values[0];
            const previous = await (0, ledger_js_1.setLedgerChannelConfig)(chInteraction.guildId, channelId);
            const menu = await renderLedgerMenu(chInteraction.guildId);
            let status = `✅ Ledger channel set to <#${channelId}>. All bot transactions will be posted there.`;
            if (previous && previous.channelId !== channelId) {
                status = `✅ Ledger channel updated from <#${previous.channelId}> to <#${channelId}>.`;
            }
            menu.embeds[0].setDescription(status);
            await chInteraction.editReply(menu);
        }
        return;
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
