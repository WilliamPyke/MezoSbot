import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { getMusdBalanceAtomic } from "../balance.js";
import { config } from "../config.js";
import { getGuildModels } from "./catalog.js";
import {
  queueGeneration,
  releaseReservedGeneration,
  reserveGeneration,
  setGenerationStatusMessage,
} from "./service.js";
import { formatMusd, generationCost, generationPriceChanged, modelsForPage, type GenerationQuality, type KatanaImageModel } from "./types.js";

const PREFIX = "imggen";
const TTL_MS = 15 * 60 * 1000;
const sessions = new Map<string, GenerationDraft>();

export type GenerationDraft = {
  id: string;
  ownerId: string;
  guildId: string;
  channelId: string;
  models: KatanaImageModel[];
  page: "current" | "legacy";
  modelKey: string;
  aspectRatio: string;
  quality: GenerationQuality;
  prompt: string;
  error: string | null;
  expiresAt: number;
};

function touch(draft: GenerationDraft): void {
  draft.expiresAt = Date.now() + TTL_MS;
}

function currentModel(draft: GenerationDraft): KatanaImageModel {
  const model = draft.models.find((item) => item.modelKey === draft.modelKey);
  if (!model) throw new Error("Selected model is no longer available");
  return model;
}

export async function createGenerationDraft(ownerId: string, guildId: string, channelId: string): Promise<GenerationDraft> {
  const models = await getGuildModels(guildId);
  const current = modelsForPage(models, "current");
  const selected = current[0] ?? models[0];
  if (!selected) throw new Error("No image models are enabled for this server");
  const draft: GenerationDraft = {
    id: randomUUID().replace(/-/g, "").slice(0, 20),
    ownerId,
    guildId,
    channelId,
    models,
    page: selected.isLegacy ? "legacy" : "current",
    modelKey: selected.modelKey,
    aspectRatio: selected.aspectRatios.includes("1:1") ? "1:1" : selected.aspectRatios[0],
    quality: "standard",
    prompt: "",
    error: null,
    expiresAt: Date.now() + TTL_MS,
  };
  sessions.set(draft.id, draft);
  return draft;
}

function componentId(draft: GenerationDraft, action: string): string {
  return `${PREFIX}:${draft.id}:${action}`;
}

export async function renderGenerationDraft(draft: GenerationDraft) {
  const model = currentModel(draft);
  const balance = await getMusdBalanceAtomic(draft.ownerId);
  const cost = generationCost(model, draft.quality);
  const prompt = draft.prompt || "No prompt yet. Use **Edit prompt** to describe your image.";
  const embed = new EmbedBuilder()
    .setColor(0xf271b6)
    .setTitle("Generate with imgnAI Katana")
    .setDescription(prompt.slice(0, 4096))
    .addFields(
      { name: "Model", value: `${model.displayName}${model.isLegacy ? " · Legacy" : ""}`, inline: true },
      { name: "Aspect ratio", value: draft.aspectRatio, inline: true },
      { name: "Quality", value: draft.quality === "uhd" ? "UHD" : "Standard", inline: true },
      { name: "Estimated cost", value: formatMusd(cost), inline: true },
      { name: "Your balance", value: formatMusd(balance), inline: true },
      { name: "Catalog", value: draft.page === "current" ? "Current models" : "Legacy models", inline: true },
    )
    .setFooter({ text: "Powered by imgnAI · Setup expires in 15 minutes", iconURL: "attachment://imgnai-logo.png" });
  if (draft.error) embed.addFields({ name: "Needs attention", value: draft.error.slice(0, 1024) });

  const pageModels = modelsForPage(draft.models, draft.page).slice(0, 25);
  const modelSelect = new StringSelectMenuBuilder()
    .setCustomId(componentId(draft, "model"))
    .setPlaceholder(draft.page === "current" ? "Choose a current model" : "Choose a legacy model")
    .addOptions(pageModels.map((item) => ({
      label: item.displayName.slice(0, 100),
      value: item.modelKey,
      description: `${item.creator || "imgnAI"} · ${formatMusd(item.costMusdAtomic)}`.slice(0, 100),
      default: item.modelKey === draft.modelKey,
    })));
  const aspectSelect = new StringSelectMenuBuilder()
    .setCustomId(componentId(draft, "aspect"))
    .setPlaceholder("Choose an aspect ratio")
    .addOptions(model.aspectRatios.slice(0, 25).map((ratio) => ({ label: ratio, value: ratio, default: ratio === draft.aspectRatio })));
  const rows: Array<ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>> = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelSelect),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(aspectSelect),
  ];
  if (model.supportsUhd) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(componentId(draft, "quality"))
        .setPlaceholder("Choose quality")
        .addOptions(
          { label: "Standard", value: "standard", description: formatMusd(model.costMusdAtomic), default: draft.quality === "standard" },
          { label: "UHD", value: "uhd", description: `${formatMusd(model.costMusdAtomic * 2n)} · 2× cost`, default: draft.quality === "uhd" },
        ),
    ));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(componentId(draft, "prompt")).setLabel("Edit prompt").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(componentId(draft, "page")).setLabel(draft.page === "current" ? "Legacy models" : "Current models").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(componentId(draft, "generate")).setLabel("Generate").setStyle(ButtonStyle.Success)
      .setDisabled(!draft.prompt.trim()),
    new ButtonBuilder().setCustomId(componentId(draft, "cancel")).setLabel("Cancel").setStyle(ButtonStyle.Danger),
  ));
  return { embeds: [embed], components: rows };
}

export function isGenerationInteraction(interaction: Interaction): boolean {
  return (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())
    && interaction.customId.startsWith(`${PREFIX}:`);
}

function resolveDraft(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): GenerationDraft | null {
  const [, id] = interaction.customId.split(":");
  const draft = sessions.get(id) ?? null;
  if (!draft || draft.expiresAt <= Date.now()) {
    if (draft) sessions.delete(id);
    return null;
  }
  return draft;
}

async function reject(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, content: string): Promise<void> {
  if (interaction.replied || interaction.deferred) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

export async function handleGenerationInteraction(interaction: Interaction): Promise<void> {
  if (!(interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())) return;
  const draft = resolveDraft(interaction);
  if (!draft) return reject(interaction, "This generation setup expired. Run `/generate` to start again.");
  if (interaction.user.id !== draft.ownerId) return reject(interaction, "Only the person who opened this setup can change it.");
  const action = interaction.customId.split(":")[2];

  if (interaction.isButton() && action === "prompt") {
    const input = new TextInputBuilder()
      .setCustomId("prompt")
      .setLabel("Describe the image")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(config.imgnai.promptMaxLength)
      .setPlaceholder("A cinematic photograph of...");
    if (draft.prompt) input.setValue(draft.prompt);
    const modal = new ModalBuilder()
      .setCustomId(componentId(draft, "prompt_submit"))
      .setTitle("Image prompt")
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && action === "prompt_submit") {
    draft.prompt = interaction.fields.getTextInputValue("prompt").trim();
    draft.error = draft.prompt ? null : "Enter a prompt before generating.";
    touch(draft);
    await interaction.deferUpdate();
    await interaction.editReply(await renderGenerationDraft(draft));
    return;
  }

  if (interaction.isStringSelectMenu()) {
    if (action === "model") {
      draft.modelKey = interaction.values[0];
      const model = currentModel(draft);
      draft.aspectRatio = model.aspectRatios.includes("1:1") ? "1:1" : model.aspectRatios[0];
      if (!model.supportsUhd) draft.quality = "standard";
    } else if (action === "aspect") draft.aspectRatio = interaction.values[0];
    else if (action === "quality") draft.quality = interaction.values[0] === "uhd" ? "uhd" : "standard";
    draft.error = null;
    touch(draft);
    await interaction.deferUpdate();
    await interaction.editReply(await renderGenerationDraft(draft));
    return;
  }

  if (!interaction.isButton()) return;
  if (action === "cancel") {
    sessions.delete(draft.id);
    await interaction.update({ content: "Generation cancelled.", embeds: [], components: [] });
    return;
  }
  if (action === "page") {
    draft.page = draft.page === "current" ? "legacy" : "current";
    draft.error = null;
    touch(draft);
    await interaction.deferUpdate();
    await interaction.editReply(await renderGenerationDraft(draft));
    return;
  }
  if (action !== "generate") return;

  await interaction.deferUpdate();
  const freshModels = await getGuildModels(draft.guildId, true);
  const previous = currentModel(draft);
  const fresh = freshModels.find((item) => item.modelKey === draft.modelKey);
  if (!fresh) {
    draft.models = freshModels;
    draft.error = "That model was disabled or removed. Choose another model.";
    await interaction.editReply(await renderGenerationDraft(draft));
    return;
  }
  const oldCost = generationCost(previous, draft.quality);
  const newCost = generationCost(fresh, draft.quality);
  draft.models = freshModels;
  if (generationPriceChanged(oldCost, newCost)) {
    draft.error = `The price changed from ${formatMusd(oldCost)} to ${formatMusd(newCost)}. Review it and press Generate again.`;
    await interaction.editReply(await renderGenerationDraft(draft));
    return;
  }
  const jobId = await reserveGeneration({
    discordId: draft.ownerId,
    guildId: draft.guildId,
    channelId: draft.channelId,
    prompt: draft.prompt,
    model: fresh,
    aspectRatio: draft.aspectRatio,
    quality: draft.quality,
    amountMusdAtomic: newCost,
  });
  if (!jobId) {
    draft.error = `Your MUSD balance is too low for ${formatMusd(newCost)}. Use \`/deposit token:MUSD\` and try again.`;
    await interaction.editReply(await renderGenerationDraft(draft));
    return;
  }

  try {
    const channel = interaction.channel;
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error("This channel cannot receive the result");
    const logo = new AttachmentBuilder(path.join(process.cwd(), "src", "assets", "imgnai-logo.png"), { name: "imgnai-logo.png" });
    const status = new EmbedBuilder()
      .setColor(0xf271b6)
      .setTitle("Generating image")
      .setDescription(`imgnAI Katana is working on <@${draft.ownerId}>'s image.`)
      .addFields(
        { name: "Model", value: fresh.displayName, inline: true },
        { name: "Aspect ratio", value: draft.aspectRatio, inline: true },
        { name: "Reserved", value: formatMusd(newCost), inline: true },
      )
      .setFooter({ text: "Powered by imgnAI", iconURL: "attachment://imgnai-logo.png" });
    const message = await channel.send({
      content: `<@${draft.ownerId}>`,
      embeds: [status],
      files: [logo],
      allowedMentions: { users: [draft.ownerId] },
    });
    await setGenerationStatusMessage(jobId, message.id);
    sessions.delete(draft.id);
    await interaction.editReply({
      content: `Generation submitted. Follow progress in ${message.url}.`,
      embeds: [],
      components: [],
    });
    queueGeneration(interaction.client, jobId);
  } catch (error) {
    await releaseReservedGeneration(jobId, (error as Error).message);
    draft.error = `Could not post the generation status: ${(error as Error).message}. Your MUSD was returned.`;
    await interaction.editReply(await renderGenerationDraft(draft));
  }
}
