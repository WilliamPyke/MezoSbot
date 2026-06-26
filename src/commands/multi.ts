import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { getMultiDropEnabled, isBotAdmin, setMultiDropEnabled } from "../multi.js";

export const data = {
  name: "multi",
  description: "Control whether your drops allow multi 2x claims",
  options: [
    {
      name: "status",
      type: 1 as const,
      description: "Show whether your drops currently allow multi 2x claims",
    },
    {
      name: "on",
      type: 1 as const,
      description: "Allow multi 2x users to claim double from your drops",
    },
    {
      name: "off",
      type: 1 as const,
      description: "Disable multi 2x claims from your drops",
    },
  ],
};

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand(true);

  if (subcommand === "on" || subcommand === "off") {
    const enabled = subcommand === "on";
    await setMultiDropEnabled(interaction.user.id, enabled);
    const adminNote = isBotAdmin(interaction.user.id)
      ? "\n\nYou are in `ADMIN_IDS`, so your drops will allow 2x claims even if this is turned off later."
      : "";
    return interaction.reply({
      content: enabled
        ? `Multi 2x claims are now **on** for your drops.${adminNote}`
        : `Multi 2x claims are now **off** for your drops.${adminNote}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const enabled = await getMultiDropEnabled(interaction.user.id);
  const adminNote = isBotAdmin(interaction.user.id)
    ? "\n\nYou are in `ADMIN_IDS`, so your drops always allow 2x claims."
    : "";
  return interaction.reply({
    content: `Multi 2x claims are currently **${enabled ? "on" : "off"}** for your drops.${adminNote}`,
    flags: MessageFlags.Ephemeral,
  });
}
