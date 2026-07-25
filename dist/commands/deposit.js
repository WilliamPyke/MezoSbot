"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const qrcode_1 = __importDefault(require("qrcode"));
const evm_js_1 = require("../evm.js");
const config_js_1 = require("../config.js");
const tokens_js_1 = require("../tokens.js");
const depositAccess_js_1 = require("../depositAccess.js");
exports.data = {
    name: "deposit",
    description: "Get your personal token deposit address",
    options: [
        { name: "token", type: 3, description: "Token to deposit", required: false, choices: tokens_js_1.TOKEN_CHOICES },
        { name: "sponsor", type: 5, description: "Admin: fund the ERC-20 operations gas wallet", required: false },
    ],
};
async function execute(interaction) {
    if (!(0, depositAccess_js_1.canInteractionUseDeposits)(interaction)) {
        return interaction.reply({ content: "❌ Deposits require the G4, G5, or G6 role.", flags: discord_js_1.MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: discord_js_1.MessageFlags.Ephemeral });
    const sponsor = interaction.options.getBoolean("sponsor") ?? false;
    const isAdmin = config_js_1.config.discord.adminIds.includes(interaction.user.id);
    if (sponsor && !isAdmin) {
        return interaction.editReply({ content: "❌ Gas sponsor deposits are admin only." });
    }
    const token = (0, tokens_js_1.parseToken)(interaction.options.getString("token"));
    if (sponsor && token !== "SATS") {
        return interaction.editReply({ content: "❌ The gas sponsor accepts native BTC/SATS only." });
    }
    try {
        (0, tokens_js_1.assertTokenConfigured)(token);
    }
    catch (error) {
        return interaction.editReply({ content: `❌ ${error.message}` });
    }
    const address = sponsor
        ? (0, evm_js_1.getSweepGasSponsorAddress)()
        : await (0, evm_js_1.registerDepositAddress)(interaction.user.id, { enableDeposits: true });
    const explorer = config_js_1.config.evm.explorerUrl;
    const depositAsset = token === "SATS" ? "native BTC (credited as SATS)" : (0, tokens_js_1.tokenLabel)(token);
    const minimum = token === "SATS" || isAdmin ? null : config_js_1.config.deposits.minimums[token];
    const qrBuffer = await qrcode_1.default.toBuffer(address, {
        width: 256,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
    });
    const attachment = new discord_js_1.AttachmentBuilder(qrBuffer, { name: "deposit-qr.png" });
    const embed = new discord_js_1.EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`📍 Your ${(0, tokens_js_1.tokenLabel)(token)} Deposit Address`)
        .setDescription(`\`${address}\``)
        .setTitle(sponsor ? "⛽ ERC-20 Gas Sponsor Address" : `📍 Your ${(0, tokens_js_1.tokenLabel)(token)} Deposit Address`)
        .addFields({ name: "How It Works", value: sponsor
            ? "Send **native BTC** on Mezo to this dedicated operational wallet. It pays ERC-20 sweep and withdrawal gas and is not credited to a user balance."
            : `Send **${depositAsset}** on Mezo to this address. Your balance is credited automatically after polling.` }, ...(minimum ? [{ name: "Minimum deposit", value: `Deposits accumulate until at least **${minimum} ${(0, tokens_js_1.tokenLabel)(token)}** is present.` }] : []), ...(token !== "SATS" ? [{ name: "Sweep timing", value: `ERC-20 funds are swept after roughly **${Math.ceil(config_js_1.config.deposits.erc20SweepDelayMs / 60000)} minutes**, allowing nearby deposits to be combined.` }] : []), { name: "Important", value: "Only send the selected token on the configured Mezo network." }, { name: "Explorer", value: `[View on Explorer](${explorer}/address/${address})` })
        .setThumbnail("attachment://deposit-qr.png")
        .setFooter({ text: sponsor ? "Dedicated protocol gas wallet" : "This address is unique to you" })
        .setTimestamp();
    const webButton = new discord_js_1.ButtonBuilder()
        .setLabel("Deposit via Wallet")
        .setStyle(discord_js_1.ButtonStyle.Link)
        .setURL(`${config_js_1.config.depositWebUrl}?uid=${interaction.user.id}&token=${token}`)
        .setEmoji("🌐");
    const row = new discord_js_1.ActionRowBuilder().addComponents(webButton);
    await interaction.editReply({
        embeds: [embed],
        files: [attachment],
        components: sponsor ? [] : [row],
    });
}
