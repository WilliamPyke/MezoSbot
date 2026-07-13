import { AttachmentBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import path from "node:path";
import { createGenerationDraft, renderGenerationDraft } from "../imgnai/interactions.js";

export const data = {
  name: "generate",
  description: "Generate an image with imgnAI Katana using your MUSD balance",
};

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({ content: "Image generation is only available in a server channel.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const draft = await createGenerationDraft(interaction.user.id, interaction.guildId, interaction.channelId);
    const view = await renderGenerationDraft(draft);
    const logo = new AttachmentBuilder(path.join(process.cwd(), "src", "assets", "imgnai-logo.png"), { name: "imgnai-logo.png" });
    await interaction.editReply({ ...view, files: [logo] });
  } catch (error) {
    await interaction.editReply({
      content: `Image generation is temporarily unavailable: ${(error as Error).message}`,
      embeds: [],
      components: [],
    });
  }
}
