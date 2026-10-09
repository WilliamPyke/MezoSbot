import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { config } from "../config.js";
import { registerDepositAddress } from "../evm.js";
import { depositsBlockedMessage, getCustodyMode, getV2Settings } from "../custody/state.js";
import { forwarderAddress } from "../custody/deposits.js";
import { sameAddress } from "../custody/policy.js";
import { formatSats } from "../format.js";
import {
  createWalletVerificationChallenge,
  formatShortAddress,
  getPendingWalletVerification,
  getVerifiedWallets,
} from "../walletVerification.js";
import { canInteractionUseDeposits } from "../depositAccess.js";

export const data = {
  name: "wallet",
  description: "Verify wallets for on-chain quest checks",
  options: [
    {
      name: "verify",
      type: 1 as const,
      description: "Verify wallet ownership with a tiny deposit challenge",
    },
    {
      name: "status",
      type: 1 as const,
      description: "Show your verified wallets",
    },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand === "verify") return verify(interaction);
  if (subcommand === "status") return status(interaction);

  return interaction.reply({ content: "Unknown wallet command.", flags: MessageFlags.Ephemeral });
}

async function verify(interaction: ChatInputCommandInteraction) {
  if (!canInteractionUseDeposits(interaction)) {
    return interaction.reply({
      content: "❌ Wallet verification requires the G4, G5, or G6 role.",
      flags: MessageFlags.Ephemeral,
    });
  }
  // Verification asks the user to send funds to their deposit address.
  const blocked = depositsBlockedMessage();
  if (blocked) {
    return interaction.reply({ content: `⏸️ ${blocked}`, flags: MessageFlags.Ephemeral });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const depositAddress = await registerDepositAddress(interaction.user.id, { enableDeposits: true });
  const challenge = await createWalletVerificationChallenge(interaction.user.id, depositAddress);
  const expires = Math.floor(Date.parse(challenge.expires_at) / 1000);

  const embed = new EmbedBuilder()
    .setColor(0x8ab4ff)
    .setTitle("Wallet Verification")
    .setDescription("Send the challenge amount from the wallet you want to verify. The bot will record the actual sender wallet on-chain.")
    .addFields(
      { name: "Send", value: `**${formatSats(challenge.challenge_sats)}**`, inline: true },
      { name: "To", value: `\`${challenge.deposit_address}\`` },
      { name: "Expires", value: `<t:${expires}:R>`, inline: true },
      { name: "Network", value: `Chain ID ${config.evm.chainId}`, inline: true },
      {
        name: "Important",
        value: getCustodyMode() === "v2"
          ? "Use the same wallet you want quests to check. The challenge amount stays in your deposit address and is " +
            `credited to your bot balance once at least ${formatSats(config.custody.minNativeDepositSats)} is there to sweep.`
          : "Use the same wallet you want quests to check. Verification deposits are locked and are not credited to your bot balance.",
      },
    )
    .setFooter({ text: "After the deposit confirms, /wallet status will show the verified wallet." })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function status(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [wallets, pending] = await Promise.all([
    getVerifiedWallets(interaction.user.id),
    getPendingWalletVerification(interaction.user.id),
  ]);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Verified Wallets")
    .setTimestamp();

  if (wallets.length === 0) {
    embed.setDescription("No verified wallets yet. Run `/wallet verify` to start.");
  } else {
    embed.setDescription(
      wallets
        .map((wallet) => `\`${formatShortAddress(wallet.wallet_address)}\` verified <t:${Math.floor(Date.parse(wallet.verified_at) / 1000)}:R>`)
        .join("\n"),
    );
  }

  // Only point users at an address the bot can still credit: never a
  // retired v1 address while custody is paused or after the move to v2.
  const v2 = getCustodyMode() === "v2" ? getV2Settings() : null;
  const pendingAddressLive = !!pending && (
    getCustodyMode() === "legacy" || (!!v2 && sameAddress(pending.deposit_address, forwarderAddress(v2, interaction.user.id)))
  );
  if (pending && pendingAddressLive) {
    embed.addFields({
      name: "Pending Challenge",
      value: `Send **${formatSats(pending.challenge_sats)}** to \`${pending.deposit_address}\` before <t:${Math.floor(Date.parse(pending.expires_at) / 1000)}:R>.`,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
