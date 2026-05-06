"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const config_js_1 = require("../config.js");
const evm_js_1 = require("../evm.js");
const db_js_1 = require("../db.js");
const format_js_1 = require("../format.js");
exports.data = {
    name: "sweep",
    description: "Admin: sweep deposit wallets to treasury",
    default_member_permissions: "0",
    options: [
        {
            name: "user",
            type: 6,
            description: "Specific user to sweep (omit for all registered wallets)",
            required: false,
        },
        {
            name: "fund_gas",
            type: 5,
            description: "Fund gas from treasury if deposit wallet can't cover it (default: true)",
            required: false,
        },
    ],
};
async function execute(interaction) {
    if (!config_js_1.config.discord.adminIds.includes(interaction.user.id)) {
        return interaction.reply({ content: "❌ Admin only.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    const target = interaction.options.getUser("user");
    const shouldFundGas = interaction.options.getBoolean("fund_gas") ?? true;
    const provider = (0, evm_js_1.getProvider)();
    let rows;
    if (target) {
        const addr = await (0, evm_js_1.registerDepositAddress)(target.id);
        rows = [{ discord_id: target.id, address: addr }];
    }
    else {
        const { data } = await db_js_1.supabase
            .from("deposit_addresses")
            .select("discord_id, address");
        rows = (data ?? []);
    }
    let swept = 0;
    let failed = 0;
    let skipped = 0;
    let totalSats = 0;
    const details = [];
    for (const row of rows) {
        try {
            const bal = await provider.getBalance(row.address);
            if (bal === 0n) {
                skipped++;
                continue;
            }
            const balSats = (0, config_js_1.tokenUnitsToSats)(bal);
            let hash = await (0, evm_js_1.sweepToTreasury)(row.discord_id);
            if (!hash && shouldFundGas) {
                hash = await (0, evm_js_1.fundGasAndSweep)(row.discord_id);
            }
            if (hash) {
                swept++;
                totalSats += balSats;
                details.push(`✅ <@${row.discord_id}> — ~${(0, format_js_1.formatSats)(balSats)} → [tx](${config_js_1.config.evm.explorerUrl}/tx/${hash})`);
            }
            else {
                failed++;
                details.push(`❌ <@${row.discord_id}> — ${(0, format_js_1.formatSats)(balSats)} — could not sweep`);
            }
        }
        catch (err) {
            failed++;
            const msg = err?.message ?? String(err);
            details.push(`❌ <@${row.discord_id}> — error: ${msg.slice(0, 100)}`);
        }
    }
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(swept > 0 ? 0x00cc6a : 0x95a5a6)
        .setTitle("🧹 Sweep Complete")
        .addFields({ name: "Swept", value: `**${swept}** wallet(s)`, inline: true }, { name: "Total", value: `~${(0, format_js_1.formatSats)(totalSats)}`, inline: true }, { name: "Failed", value: `**${failed}**`, inline: true }, { name: "Skipped (empty)", value: `**${skipped}**`, inline: true });
    if (details.length > 0) {
        const detailStr = details.join("\n").slice(0, 1024);
        embed.addFields({ name: "Details", value: detailStr });
    }
    embed.setTimestamp();
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
