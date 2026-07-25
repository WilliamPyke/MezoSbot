import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import QRCode from "qrcode";
import { getSweepGasSponsorAddress, registerDepositAddress } from "../evm.js";
import { config } from "../config.js";
import { TOKEN_CHOICES, assertTokenConfigured, parseToken, tokenLabel } from "../tokens.js";
import { canInteractionUseDeposits } from "../depositAccess.js";

export const data = {
  name: "deposit",
  description: "Get your personal token deposit address",
  options: [
    { name: "token", type: 3 as const, description: "Token to deposit", required: false, choices: TOKEN_CHOICES },
    { name: "sponsor", type: 5 as const, description: "Admin: fund the ERC-20 operations gas wallet", required: false },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!canInteractionUseDeposits(interaction)) {
    return interaction.reply({ content: "❌ Deposits require the G4, G5, or G6 role.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const sponsor = interaction.options.getBoolean("sponsor") ?? false;
  const isAdmin = config.discord.adminIds.includes(interaction.user.id);
  if (sponsor && !isAdmin) {
    return interaction.editReply({ content: "❌ Gas sponsor deposits are admin only." });
  }
  const token = parseToken(interaction.options.getString("token"));
  if (sponsor && token !== "SATS") {
    return interaction.editReply({ content: "❌ The gas sponsor accepts native BTC/SATS only." });
  }
  try { assertTokenConfigured(token); } catch (error) {
    return interaction.editReply({ content: `❌ ${(error as Error).message}` });
  }

  const address = sponsor
    ? getSweepGasSponsorAddress()
    : await registerDepositAddress(interaction.user.id, { enableDeposits: true });
  const explorer = config.evm.explorerUrl;
  const depositAsset = token === "SATS" ? "native BTC (credited as SATS)" : tokenLabel(token);
  const minimum = token === "SATS" || isAdmin ? null : config.deposits.minimums[token];

  const qrBuffer = await QRCode.toBuffer(address, {
    width: 256,
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });

  const attachment = new AttachmentBuilder(qrBuffer, { name: "deposit-qr.png" });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📍 Your ${tokenLabel(token)} Deposit Address`)
    .setDescription(`\`${address}\``)
    .setTitle(sponsor ? "⛽ ERC-20 Gas Sponsor Address" : `📍 Your ${tokenLabel(token)} Deposit Address`)
    .addFields(
      { name: "How It Works", value: sponsor
        ? "Send **native BTC** on Mezo to this dedicated operational wallet. It pays ERC-20 sweep and withdrawal gas and is not credited to a user balance."
        : `Send **${depositAsset}** on Mezo to this address. Your balance is credited automatically after polling.` },
      ...(minimum ? [{ name: "Minimum deposit", value: `Deposits accumulate until at least **${minimum} ${tokenLabel(token)}** is present.` }] : []),
      ...(token !== "SATS" ? [{ name: "Sweep timing", value: `ERC-20 funds are swept after roughly **${Math.ceil(config.deposits.erc20SweepDelayMs / 60000)} minutes**, allowing nearby deposits to be combined.` }] : []),
      { name: "Important", value: "Only send the selected token on the configured Mezo network." },
      { name: "Explorer", value: `[View on Explorer](${explorer}/address/${address})` },
    )
    .setThumbnail("attachment://deposit-qr.png")
    .setFooter({ text: sponsor ? "Dedicated protocol gas wallet" : "This address is unique to you" })
    .setTimestamp();

  const webButton = new ButtonBuilder()
    .setLabel("Deposit via Wallet")
    .setStyle(ButtonStyle.Link)
    .setURL(`${config.depositWebUrl}?uid=${interaction.user.id}&token=${token}`)
    .setEmoji("🌐");

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(webButton);

  await interaction.editReply({
    embeds: [embed],
    files: [attachment],
    components: sponsor ? [] : [row],
  });
}
