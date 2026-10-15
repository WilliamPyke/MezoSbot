import { AttachmentBuilder, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { config } from "../config.js";
import { supabase } from "../db.js";
import { PAYOUT_ACTIONS, type PayoutAction } from "../custody/abi.js";
import { describeQueued, parseExpectation } from "../custody/adminActions.js";
import { expectAction, guardianCancel, pendingEta } from "../custody/adminWatch.js";
import { getCustodyMode, getFreezeState, getV2Settings, isCustodyFrozen } from "../custody/state.js";
import { setWithdrawalHold } from "../custody/store.js";
import { clearCustodyFreeze } from "../custody/watchdog.js";
import type { Anomaly } from "../custody/watchdogCore.js";
import { buildCustodyEmbed } from "./treasury.js";

const ACTION_CHOICES = PAYOUT_ACTIONS.map((action) => ({ name: action, value: action }));

export const data = {
  name: "custody",
  description: "Admin: custody mode, wallets, watchdog freeze and withdrawal holds",
  default_member_permissions: "0",
  options: [
    { name: "status", type: 1 as const, description: "Custody mode, reasons, balances, payout limits and gas wallets" },
    {
      name: "unfreeze",
      type: 1 as const,
      description: "Clear a watchdog freeze after investigating it",
      options: [
        { name: "note", type: 3 as const, description: "What was investigated and fixed (logged)", required: true },
        {
          name: "confirm",
          type: 3 as const,
          description: "Confirmation code for anomalies the freeze did not record (shown by a first unfreeze)",
          required: false,
        },
      ],
    },
    {
      name: "hold",
      type: 1 as const,
      description: "Hold or release one user's on-chain withdrawals",
      options: [
        { name: "user", type: 6 as const, description: "User whose on-chain withdrawals to hold or release", required: true },
        { name: "on", type: 5 as const, description: "true: hold their on-chain withdrawals; false: release the hold", required: true },
        { name: "note", type: 3 as const, description: "Why (stored with the hold)", required: false },
      ],
    },
    {
      name: "expect",
      type: 1 as const,
      description: "Approve one vault action for 24h before queueing it (unapproved ones are cancelled)",
      options: [
        { name: "action", type: 3 as const, description: "What the vault will queue", required: true, choices: ACTION_CHOICES },
        {
          name: "subject",
          type: 3 as const,
          description: "New vault/operator/guardian address, or the token (SATS, MUSD, MUSDC, MEZO or address)",
          required: true,
        },
        {
          name: "amount",
          type: 3 as const,
          description: "recover: amount; caps: per-withdrawal cap (sats for SATS, whole tokens otherwise)",
          required: false,
        },
        { name: "daily", type: 3 as const, description: "caps: daily cap (same units)", required: false },
        { name: "note", type: 3 as const, description: "Why (stored with the approval)", required: false },
      ],
    },
    {
      name: "cancel",
      type: 1 as const,
      description: "Have the guardian cancel one queued vault action",
      options: [{ name: "id", type: 3 as const, description: "Action id from the DM (0x…)", required: true }],
    },
  ],
};

const REPLY_LIMIT = 1900;

function describeAnomaly(anomaly: Anomaly): string {
  const parts: string[] = [anomaly.kind];
  if (anomaly.withdrawalId != null) parts.push(`withdrawal ${anomaly.withdrawalId}`);
  if (anomaly.ref) parts.push(`ref ${anomaly.ref}`);
  if (anomaly.txHash) parts.push(`tx ${anomaly.txHash}`);
  if (anomaly.block != null) parts.push(`block ${anomaly.block}`);
  return `• ${anomaly.key}: ${parts.join(", ")}\n  ${anomaly.description}`;
}

/** Header in the message; the details too when they fit, otherwise all of them in an attached text file. */
function longReply(interaction: ChatInputCommandInteraction, header: string, details: string[]) {
  const full = [header, ...details].join("\n");
  if (full.length <= REPLY_LIMIT) return interaction.editReply({ content: full });
  return interaction.editReply({
    content: `${header.slice(0, REPLY_LIMIT - 60)}\nThe full list is attached.`,
    files: [new AttachmentBuilder(Buffer.from(full, "utf8"), { name: "custody-unfreeze.txt" })],
  });
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!config.discord.adminIds.includes(interaction.user.id)) {
    return interaction.reply({ content: "❌ Admin only.", flags: MessageFlags.Ephemeral });
  }
  const subcommand = interaction.options.getSubcommand(true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (subcommand === "status") {
    try {
      return interaction.editReply({ embeds: [await buildCustodyEmbed(true)] });
    } catch (error) {
      return interaction.editReply({ content: `❌ Could not read custody status: ${(error as Error).message}` });
    }
  }

  if (subcommand === "unfreeze") {
    if (getCustodyMode() !== "v2") {
      return interaction.editReply({ content: "Custody v2 is not active; there is no watchdog freeze to clear." });
    }
    const frozen = getFreezeState();
    if (!frozen) {
      return interaction.editReply({
        content: isCustodyFrozen()
          ? "Custody signing is blocked because the freeze flag could not be read from the database yet; check Supabase."
          : "Custody is not frozen.",
      });
    }
    const note = interaction.options.getString("note", true).slice(0, 500);
    const confirm = interaction.options.getString("confirm")?.trim() || null;
    try {
      const result = await clearCustodyFreeze(interaction.user.id, note, confirm);
      if (result.status === "confirm") {
        return longReply(interaction, [
          `⚠️ Custody stays frozen. The checks up to the chain head found ${result.newAnomalies.length} anomal${result.newAnomalies.length === 1 ? "y" : "ies"} ` +
            "the freeze did not record (no admin was shown them):",
          confirm ? `(The code \`${confirm}\` does not match this set.)` : "",
          `Review every one, then run \`/custody unfreeze\` again with \`confirm:${result.code}\` to accept exactly this set; ` +
            "if it changes meanwhile you get a new list and code.",
        ].filter(Boolean).join("\n"), result.newAnomalies.map(describeAnomaly));
      }
      if (result.status === "changed") {
        return longReply(interaction, "⚠️ Custody stays frozen: new anomalies were recorded while the checks ran. " +
          "They were DM'd to admins; review them and run `/custody unfreeze` again.", result.addedKeys.map((key) => `• ${key}`));
      }
      const shown = new Map(result.acknowledged.map((anomaly) => [anomaly.key, anomaly]));
      return longReply(interaction, [
        `✅ Custody freeze cleared (was: ${frozen.reason}).`,
        ...result.lines,
        result.recordedKeys.length > 0
          ? `Acknowledged (held for manual review; they never freeze custody again): ${result.recordedKeys.join(", ")}`
          : "No anomaly to acknowledge.",
      ].join("\n"), result.recordedKeys.flatMap((key) => {
        const anomaly = shown.get(key);
        return anomaly ? [describeAnomaly(anomaly)] : [];
      }));
    } catch (error) {
      return interaction.editReply({ content: `❌ Could not clear the freeze (custody stays frozen): ${(error as Error).message}` });
    }
  }

  if (subcommand === "hold") {
    const user = interaction.options.getUser("user", true);
    const held = interaction.options.getBoolean("on", true);
    const note = interaction.options.getString("note")?.slice(0, 500) ?? null;
    try {
      await setWithdrawalHold(user.id, held, interaction.user.id, note);
    } catch (error) {
      return interaction.editReply({ content: `❌ Could not update the withdrawal hold: ${(error as Error).message}` });
    }
    console.warn(`[Custody] Withdrawal hold ${held ? "set" : "released"} for ${user.id} by ${interaction.user.id}${note ? `: ${note}` : ""}`);
    return interaction.editReply({
      content: held
        ? `⏸️ On-chain withdrawals by <@${user.id}> are on hold (checked before any debit under custody v2). ` +
          "Release with `/custody hold on:false`."
        : `✅ The withdrawal hold on <@${user.id}> is released.`,
      allowedMentions: { parse: [] },
    });
  }

  if (subcommand === "expect") {
    const action = interaction.options.getString("action", true) as PayoutAction;
    const parsed = parseExpectation(
      action,
      interaction.options.getString("subject", true),
      interaction.options.getString("amount"),
      interaction.options.getString("daily"),
    );
    if ("error" in parsed) return interaction.editReply({ content: `❌ ${parsed.error}` });
    const note = interaction.options.getString("note")?.slice(0, 500) ?? null;
    try {
      const expires = await expectAction({ action, ...parsed, actorId: interaction.user.id, note });
      console.warn(`[Custody] ${interaction.user.id} approved vault action ${action} ${parsed.subject} ${parsed.value1} ${parsed.value2}`);
      return interaction.editReply({
        content: `✅ Approved until <t:${Math.floor(expires.getTime() / 1000)}:f>: ${describeQueued({ action, ...parsed })}. ` +
          `Exact values: subject \`${parsed.subject}\`, value1 \`${parsed.value1}\`, value2 \`${parsed.value2}\`. ` +
          "Queue it from the vault wallet now; the bot leaves it alone and DMs when it can be applied (a vault handover after 2 days, a new guardian after 4, anything else after 3).",
      });
    } catch (error) {
      return interaction.editReply({ content: `❌ ${(error as Error).message}` });
    }
  }

  if (subcommand === "cancel") {
    const settings = getV2Settings();
    if (!settings) return interaction.editReply({ content: "Custody v2 is not active." });
    const id = interaction.options.getString("id", true).trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(id)) return interaction.editReply({ content: "❌ That is not an action id (0x + 64 hex)." });
    const { data, error } = await supabase
      .from("custody_admin_actions")
      .select("action, subject, value1::text, value2::text")
      .eq("payout", settings.payout.toLowerCase())
      .eq("action_id", id)
      .order("block_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return interaction.editReply({ content: `❌ Could not look up the action: ${error.message}` });
    if (!data) return interaction.editReply({ content: "❌ No queued vault action with that id has been seen." });
    const q = {
      id,
      action: data.action as PayoutAction,
      subject: String(data.subject),
      value1: BigInt(String(data.value1)),
      value2: BigInt(String(data.value2)),
    };
    try {
      if ((await pendingEta(settings.payout, q)) === 0n) {
        return interaction.editReply({ content: "Nothing to cancel: that action is no longer queued (cancelled, applied or replaced)." });
      }
      const txHash = await guardianCancel(settings, q);
      console.warn(`[Custody] ${interaction.user.id} had the guardian cancel ${id}: ${txHash}`);
      return interaction.editReply({ content: `🛑 The guardian is cancelling: ${describeQueued(q)} (${txHash}).` });
    } catch (error) {
      return interaction.editReply({ content: `❌ Could not cancel: ${(error as Error).message}` });
    }
  }

  return interaction.editReply({ content: "Unknown custody command." });
}
