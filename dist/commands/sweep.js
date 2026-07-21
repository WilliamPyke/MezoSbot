"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const config_js_1 = require("../config.js");
const evm_js_1 = require("../evm.js");
const db_js_1 = require("../db.js");
const format_js_1 = require("../format.js");
const tokens_js_1 = require("../tokens.js");
exports.data = {
    name: "sweep",
    description: "Admin: sweep deposit wallets to treasury",
    options: [
        { name: "user", type: 6, description: "Specific user (omit for all wallets)", required: false },
        {
            name: "token", type: 3, description: "Asset to sweep (default: all)", required: false,
            choices: [{ name: "All", value: "ALL" }, ...tokens_js_1.TOKEN_CHOICES],
        },
        { name: "fund_gas", type: 5, description: "Sponsor gas if needed (default: true)", required: false },
    ],
};
async function execute(interaction) {
    if (!config_js_1.config.discord.adminIds.includes(interaction.user.id)) {
        return interaction.reply({ content: "❌ Admin only.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    const target = interaction.options.getUser("user");
    const shouldFundGas = interaction.options.getBoolean("fund_gas") ?? true;
    const requested = interaction.options.getString("token") ?? "ALL";
    const tokens = requested === "ALL"
        ? ["SATS", "MUSD", "MEZO", "MUSDC"]
        : [(0, tokens_js_1.parseToken)(requested)];
    let rows;
    if (target) {
        rows = [{ discord_id: target.id, address: await (0, evm_js_1.registerDepositAddress)(target.id) }];
    }
    else {
        const { data: addresses, error } = await db_js_1.supabase.from("deposit_addresses").select("discord_id, address");
        if (error)
            throw error;
        rows = (addresses ?? []);
    }
    let swept = 0;
    let failed = 0;
    let skipped = 0;
    const totals = new Map();
    const details = [];
    for (const row of rows) {
        for (const token of tokens) {
            try {
                if (token === "SATS") {
                    const balance = await (0, evm_js_1.getNativeBalance)(row.address);
                    if (balance === 0n) {
                        skipped++;
                        continue;
                    }
                    const amount = (0, config_js_1.tokenUnitsToSats)(balance);
                    let hash = await (0, evm_js_1.sweepToTreasury)(row.discord_id);
                    if (!hash && shouldFundGas)
                        hash = await (0, evm_js_1.fundGasAndSweep)(row.discord_id);
                    if (!hash)
                        throw new Error("native balance cannot cover its sweep transaction");
                    swept++;
                    totals.set(token, (totals.get(token) ?? 0) + amount);
                    details.push(`✅ <@${row.discord_id}> — ~${(0, format_js_1.formatSats)(amount)} → [tx](${config_js_1.config.evm.explorerUrl}/tx/${hash})`);
                    continue;
                }
                const balance = await (0, evm_js_1.getTokenBalance)(row.address, token);
                if (balance === 0n) {
                    skipped++;
                    continue;
                }
                const result = await (0, evm_js_1.sweepDepositTokenToTreasury)(row.discord_id, token, shouldFundGas);
                if (!result.txHash)
                    throw new Error(`${token} could not be swept`);
                const amount = (0, tokens_js_1.tokenUnitsToAmount)(result.amountAtomic, token);
                swept++;
                totals.set(token, (totals.get(token) ?? 0) + amount);
                details.push(`✅ <@${row.discord_id}> — ${(0, tokens_js_1.formatTokenAmount)(amount, token)} → [tx](${config_js_1.config.evm.explorerUrl}/tx/${result.txHash})`);
            }
            catch (err) {
                failed++;
                const message = (err?.message ?? String(err)).slice(0, 120);
                details.push(`❌ <@${row.discord_id}> — ${token}: ${message}`);
            }
        }
    }
    const totalText = totals.size
        ? Array.from(totals, ([token, amount]) => (0, tokens_js_1.formatTokenAmount)(amount, token)).join("\n")
        : "None";
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(swept > 0 ? 0x00cc6a : 0x95a5a6)
        .setTitle("🧹 Sweep Complete")
        .addFields({ name: "Swept", value: `**${swept}** asset balance(s)`, inline: true }, { name: "Total", value: totalText, inline: true }, { name: "Failed", value: `**${failed}**`, inline: true }, { name: "Skipped (empty)", value: `**${skipped}**`, inline: true })
        .setTimestamp();
    if (details.length)
        embed.addFields({ name: "Details", value: details.join("\n").slice(0, 1024) });
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
}
