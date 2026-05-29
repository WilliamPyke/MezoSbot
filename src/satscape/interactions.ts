import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";
import { getBalance } from "../balance.js";
import { SAT } from "./engine.js";
import { getOwnedItemIds, getPlayer } from "./db.js";
import {
  buyItem,
  eat,
  equipItem,
  estimateTravel,
  maxStepsFor,
  setStepsPerMove,
  travelCost,
  travelTo,
  type ActionResult,
} from "./game.js";
import {
  buildActiveQuestsComponents,
  buildActiveQuestsEmbed,
  buildInventoryComponents,
  buildInventoryEmbed,
  buildKeeperPortrait,
  buildPortalComponents,
  buildPortalEmbed,
  buildQuestComponents,
  buildQuestEmbed,
  buildSettingsComponents,
  buildSettingsEmbed,
  buildShopComponents,
  buildShopEmbed,
  parseSqCid,
  sqCid,
  SQ_PREFIX,
} from "./render.js";
import {
  acceptQuest,
  claimQuest,
  getRep,
  payTribute,
  questBoard,
  titlesFor,
} from "./quests.js";
import { render, setAuto, stop, type EditableInteraction } from "./session.js";
import { TOWN_BY_ID, townAt } from "./towns.js";

export function isSatscapeInteraction(interaction: Interaction): boolean {
  if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
    return interaction.customId.startsWith(`${SQ_PREFIX}:`);
  }
  return false;
}

const DIRECTIONS = new Set(["up", "down", "left", "right"]);
const BROWSER_NOTE = "🎮 Movement & combat now happen in the browser playfield — open it from the link to play.";

export async function handleSatscapeInteraction(interaction: Interaction): Promise<void> {
  const customId = "customId" in interaction ? interaction.customId : "";
  const parsed = parseSqCid(customId);
  if (!parsed) return;
  const { action, parts } = parsed;
  const discordId = interaction.user.id;

  // Modal submit: travel coordinates form.
  if (interaction.isModalSubmit()) {
    if (action === "travelmodal") return showTravelEstimate(interaction);
    return;
  }

  // Shop select menus.
  if (interaction.isStringSelectMenu()) {
    await interaction.deferUpdate().catch(() => {});
    const chosen = interaction.values[0];
    if (action === "buy") {
      const res = await buyItem(discordId, chosen);
      return renderShop(interaction, discordId, res.note);
    }
    if (action === "equip") {
      const res = await equipItem(discordId, chosen);
      return renderShop(interaction, discordId, res.note);
    }
    if (action === "portalpick") return showPortalConfirm(interaction, discordId, chosen);
    if (action === "qaccept") return renderQuests(interaction, discordId, (await acceptQuest(discordId, chosen)).note);
    if (action === "qclaim") return renderQuests(interaction, discordId, (await claimQuest(discordId, chosen)).note);
    if (action === "invequip") return renderInventory(interaction, discordId, (await equipItem(discordId, chosen)).note);
    if (action === "stepselect") return renderSettings(interaction, discordId, (await setStepsPerMove(discordId, Number(chosen))).note);
    if (action === "battleweapon") return render(discordId, interaction, BROWSER_NOTE);
    return;
  }

  if (!interaction.isButton()) return;

  // "Travel" opens a modal — must happen on a fresh (undeferred) interaction.
  if (action === "travel") {
    await interaction.showModal(buildTravelModal()).catch(() => {});
    return;
  }

  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  } catch (err) {
    if ((err as { code?: number })?.code === 10062) return; // token expired
    console.warn(`[SatScape] defer failed for ${action}:`, (err as Error)?.message ?? err);
    return;
  }

  // Shop open/close.
  if (action === "shop") {
    stop(discordId); // pause the live map timer while shopping
    return renderShop(interaction, discordId);
  }
  if (action === "shopclose") return render(discordId, interaction);

  // Roads / portal network.
  if (action === "roads") {
    stop(discordId);
    return renderPortals(interaction, discordId);
  }

  // Quest board (in town) / active-quests view (outside town).
  if (action === "quests") {
    stop(discordId);
    const player = await getPlayer(discordId);
    if (player && townAt(player.x_coord, player.y_coord)) return renderQuests(interaction, discordId);
    return renderActiveQuests(interaction, discordId);
  }
  if (action === "qtribute") return renderQuests(interaction, discordId, (await payTribute(discordId, parts[0])).note);

  // Settings / inventory (utility row, anywhere).
  if (action === "settings") {
    stop(discordId);
    return renderSettings(interaction, discordId);
  }
  if (action === "inventory") {
    stop(discordId);
    return renderInventory(interaction, discordId);
  }

  // Auto-explore toggles.
  if (action === "auto") {
    setAuto(discordId, true);
    return render(discordId, interaction, "🤖 Auto-explore on — sit back. It stops when you hit a monster.");
  }
  if (action === "autostop") {
    setAuto(discordId, false);
    return render(discordId, interaction, "⏹️ Auto-explore stopped.");
  }

  // Travel confirm / cancel. A 3rd part "p" marks a road/portal trip (discounted).
  if (action === "travelgo") {
    const opts = parts[2] === "p" ? { discountMul: SAT.PORTAL_DISCOUNT } : {};
    const res = await travelTo(discordId, Number(parts[0]), Number(parts[1]), opts);
    return render(discordId, interaction, res.note);
  }
  if (action === "travelcancel") return render(discordId, interaction, "Travel cancelled.");

  // Movement & combat now live in the browser playfield — deprecated in Discord.
  const COMBAT_ACTIONS = new Set(["battlestrike", "battlecard", "battlewait", "battleundo", "battleresolve", "battleattack", "flee"]);
  if (DIRECTIONS.has(action) || COMBAT_ACTIONS.has(action)) {
    return render(discordId, interaction, BROWSER_NOTE);
  }

  let result: ActionResult | null = null;
  if (action === "eat") result = await eat(discordId);
  if (!result) return;

  if (result.enteredCombat) setAuto(discordId, false);
  await render(discordId, interaction, result.note);
}

/** Open/refresh the shop view on the current message (map image cleared). */
export async function renderShop(
  interaction: EditableInteraction,
  discordId: string,
  note?: string,
): Promise<void> {
  const player = await getPlayer(discordId);
  if (!player) {
    await interaction.editReply({ content: "Use `/satscape join` first.", embeds: [], components: [], files: [] });
    return;
  }
  const town = townAt(player.x_coord, player.y_coord);
  if (!town) {
    await interaction.editReply({ content: "🛒 The shop is only open inside a town.", embeds: [], components: [], files: [] });
    return;
  }
  const [hp, owned, rep, portrait] = await Promise.all([
    getBalance(discordId),
    getOwnedItemIds(discordId),
    getRep(discordId, town.id),
    buildKeeperPortrait(town),
  ]);
  await interaction.editReply({
    ...(note !== undefined ? { content: note || "" } : {}),
    embeds: [buildShopEmbed(town, player, hp, owned, rep)],
    components: buildShopComponents(town, owned, rep),
    files: [portrait],
  });
}

/** Open/refresh the quest board for the current town's keeper. */
export async function renderQuests(interaction: EditableInteraction, discordId: string, note?: string): Promise<void> {
  const player = await getPlayer(discordId);
  if (!player) {
    await interaction.editReply({ content: "Use `/satscape join` first.", embeds: [], components: [], files: [] });
    return;
  }
  const town = townAt(player.x_coord, player.y_coord);
  if (!town) {
    await interaction.editReply({ content: "📜 Quest boards are posted in towns.", embeds: [], components: [], files: [] });
    return;
  }
  const [board, rep, titles, portrait] = await Promise.all([
    questBoard(discordId, town.id),
    getRep(discordId, town.id),
    titlesFor(discordId),
    buildKeeperPortrait(town),
  ]);
  await interaction.editReply({
    ...(note !== undefined ? { content: note || "" } : {}),
    embeds: [buildQuestEmbed(town, board, rep, titles)],
    components: buildQuestComponents(board),
    files: [portrait],
  });
}

/** Read-only active-quests view (used outside towns). */
export async function renderActiveQuests(interaction: EditableInteraction, discordId: string, note?: string): Promise<void> {
  const player = await getPlayer(discordId);
  if (!player) {
    await interaction.editReply({ content: "Use `/satscape join` first.", embeds: [], components: [], files: [] });
    return;
  }
  // Pass any town id; only `carry` (your active/claimable across keepers) is used here.
  const [board, titles] = await Promise.all([questBoard(discordId, "rest"), titlesFor(discordId)]);
  await interaction.editReply({
    ...(note !== undefined ? { content: note || "" } : {}),
    embeds: [buildActiveQuestsEmbed(board.carry, titles)],
    components: buildActiveQuestsComponents(),
    files: [],
  });
}

/** ⚙️ Settings panel — set steps-per-press, view boots/max. */
export async function renderSettings(interaction: EditableInteraction, discordId: string, note?: string): Promise<void> {
  const player = await getPlayer(discordId);
  if (!player) {
    await interaction.editReply({ content: "Use `/satscape join` first.", embeds: [], components: [], files: [] });
    return;
  }
  const max = maxStepsFor(player);
  await interaction.editReply({
    ...(note !== undefined ? { content: note || "" } : {}),
    embeds: [buildSettingsEmbed(player, max)],
    components: buildSettingsComponents(player, max),
    files: [],
  });
}

/** 🎒 Inventory panel — view owned gear, equip from anywhere. */
export async function renderInventory(interaction: EditableInteraction, discordId: string, note?: string): Promise<void> {
  const player = await getPlayer(discordId);
  if (!player) {
    await interaction.editReply({ content: "Use `/satscape join` first.", embeds: [], components: [], files: [] });
    return;
  }
  const owned = await getOwnedItemIds(discordId);
  await interaction.editReply({
    ...(note !== undefined ? { content: note || "" } : {}),
    embeds: [buildInventoryEmbed(player, owned)],
    components: buildInventoryComponents(owned),
    files: [],
  });
}

/** Open the road network picker (town only). */
export async function renderPortals(interaction: EditableInteraction, discordId: string): Promise<void> {
  const player = await getPlayer(discordId);
  if (!player) {
    await interaction.editReply({ content: "Use `/satscape join` first.", embeds: [], components: [], files: [] });
    return;
  }
  const town = townAt(player.x_coord, player.y_coord);
  if (!town) {
    await interaction.editReply({ content: "🛣️ Roads depart from towns only.", embeds: [], components: [], files: [] });
    return;
  }
  await interaction.editReply({
    content: "",
    embeds: [buildPortalEmbed(town, player)],
    components: buildPortalComponents(town, player),
    files: [],
  });
}

/** Confirm a discounted road trip to the chosen town. */
async function showPortalConfirm(interaction: EditableInteraction, discordId: string, townId: string): Promise<void> {
  const player = await getPlayer(discordId);
  const dest = TOWN_BY_ID.get(townId);
  if (!player || !dest) return render(discordId, interaction, "That road leads nowhere.");
  const est = estimateTravel(player, dest.cx, dest.cy);
  const cost = travelCost(est, SAT.PORTAL_DISCOUNT);
  const embed = new EmbedBuilder()
    .setColor(0x6d28d9)
    .setTitle(`🛣️ Road to ${dest.name}`)
    .setDescription(`**${est.steps} tiles** by road.`)
    .addFields(
      { name: "Road fare (½)", value: `~${cost} sats`, inline: true },
      { name: "Normal fare", value: `~${est.satCost} sats`, inline: true },
    );
  await interaction.editReply({
    content: "",
    embeds: [embed],
    files: [],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(sqCid("travelgo", dest.cx, dest.cy, "p")).setLabel(`Take the road (${cost} sats)`).setEmoji("🛣️").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(sqCid("travelcancel")).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

function buildTravelModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(sqCid("travelmodal"))
    .setTitle("Fast Travel")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("x").setLabel("Destination X").setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("y").setLabel("Destination Y").setStyle(TextInputStyle.Short).setRequired(true),
      ),
    );
}

async function showTravelEstimate(interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferUpdate().catch(() => {});
  const discordId = interaction.user.id;
  const tx = Math.trunc(Number(interaction.fields.getTextInputValue("x")));
  const ty = Math.trunc(Number(interaction.fields.getTextInputValue("y")));
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    return render(discordId, interaction, "❌ Coordinates must be whole numbers.");
  }

  const player = await getPlayer(discordId);
  if (!player) return render(discordId, interaction, "Use `/satscape join` first.");
  const est = estimateTravel(player, tx, ty);
  if (est.steps === 0) return render(discordId, interaction, "You're already there.");

  const embed = new EmbedBuilder()
    .setColor(0x1d4ed8)
    .setTitle("🧭 Fast Travel — estimate")
    .setDescription(`Walk to **(${tx}, ${ty})** — about **${est.steps} tiles**.`)
    .addFields(
      { name: "Stamina now", value: `${player.hunger}%`, inline: true },
      { name: "Bread needed", value: est.breadNeeded > 0 ? `${est.breadNeeded} 🍞` : "none", inline: true },
      { name: "Estimated cost", value: est.satCost > 0 ? `~${est.satCost} sats` : "free (stamina covers it)", inline: true },
    )
    .setFooter({ text: est.hpOnlyCost > 0 ? `Skip the bread and you'd lose ~${est.hpOnlyCost} sats of HP instead. Encounters en route are skipped.` : "Encounters en route are skipped." });

  await interaction.editReply({
    content: "",
    embeds: [embed],
    files: [],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(sqCid("travelgo", tx, ty)).setLabel("Confirm Travel").setEmoji("✅").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(sqCid("travelcancel")).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}
