import {
  ChannelType,
  type Client,
  type Message,
  type SendableChannels,
} from "discord.js";
import { supabase, type DeveloperRelayRouteRow } from "./db.js";
import {
  buildDeveloperRelayContent,
  getDeveloperRelayDestinationChannelId,
  parseDeveloperRelayMessage,
  type DeveloperRelayDestination,
} from "./developerRelayFormat.js";

const RELAY_WINDOW_MS = 60_000;
const RELAY_LIMIT_PER_WINDOW = 5;
const relayAttempts = new Map<string, number[]>();

export async function getDeveloperRelayRoutes(discordId: string): Promise<DeveloperRelayRouteRow[]> {
  const { data, error } = await supabase
    .from("developer_relay_routes")
    .select("*")
    .eq("discord_id", discordId)
    .eq("enabled", true)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Could not load developer relay route: ${error.message}`);
  return (data ?? []) as DeveloperRelayRouteRow[];
}

export async function getDeveloperRelayRoute(
  guildId: string,
  discordId: string,
): Promise<DeveloperRelayRouteRow | null> {
  const { data, error } = await supabase
    .from("developer_relay_routes")
    .select("*")
    .eq("guild_id", guildId)
    .eq("discord_id", discordId)
    .maybeSingle();

  if (error) throw new Error(`Could not load developer relay route: ${error.message}`);
  return data as DeveloperRelayRouteRow | null;
}

export async function setDeveloperRelayRoute(input: {
  guildId: string;
  discordId: string;
  developerChannelId: string;
  privateThreadId: string;
  createdBy: string;
}): Promise<void> {
  const { error } = await supabase
    .from("developer_relay_routes")
    .upsert(
      {
        guild_id: input.guildId,
        discord_id: input.discordId,
        developer_channel_id: input.developerChannelId,
        private_thread_id: input.privateThreadId,
        enabled: true,
        created_by: input.createdBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "guild_id,discord_id" },
    );

  if (error) throw new Error(`Could not save developer relay route: ${error.message}`);
}

export async function disableDeveloperRelayRoute(guildId: string, discordId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("developer_relay_routes")
    .update({ enabled: false, updated_at: new Date().toISOString() })
    .eq("guild_id", guildId)
    .eq("discord_id", discordId)
    .eq("enabled", true)
    .select("discord_id");

  if (error) throw new Error(`Could not disable developer relay route: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

function isRateLimited(discordId: string, now = Date.now()): boolean {
  const recent = (relayAttempts.get(discordId) ?? []).filter((timestamp) => now - timestamp < RELAY_WINDOW_MS);
  if (recent.length >= RELAY_LIMIT_PER_WINDOW) {
    relayAttempts.set(discordId, recent);
    return true;
  }
  recent.push(now);
  relayAttempts.set(discordId, recent);
  return false;
}

async function reserveDelivery(input: {
  sourceMessageId: string;
  discordId: string;
  guildId: string;
  destination: DeveloperRelayDestination;
  destinationChannelId: string;
}): Promise<"reserved" | "duplicate"> {
  const { error } = await supabase.from("developer_relay_deliveries").insert({
    source_message_id: input.sourceMessageId,
    discord_id: input.discordId,
    guild_id: input.guildId,
    destination_type: input.destination,
    destination_channel_id: input.destinationChannelId,
    status: "pending",
  });

  if (!error) return "reserved";
  if (error.code === "23505") return "duplicate";
  throw new Error(`Could not reserve relay delivery: ${error.message}`);
}

async function markDelivery(
  sourceMessageId: string,
  update: { status: "delivered"; forwardedMessageId: string } | { status: "failed"; error: string },
): Promise<void> {
  const values = update.status === "delivered"
    ? {
        status: update.status,
        forwarded_message_id: update.forwardedMessageId,
        delivered_at: new Date().toISOString(),
        error: null,
      }
    : {
        status: update.status,
        error: update.error.slice(0, 1000),
      };
  await supabase
    .from("developer_relay_deliveries")
    .update(values)
    .eq("source_message_id", sourceMessageId);
}

function validateDestination(
  channel: Awaited<ReturnType<Client["channels"]["fetch"]>>,
  route: DeveloperRelayRouteRow,
  destination: DeveloperRelayDestination,
): channel is SendableChannels {
  if (!channel || !channel.isSendable() || channel.isDMBased()) return false;
  if (!("guildId" in channel) || channel.guildId !== route.guild_id) return false;

  const developerChannelId = route.developer_channel_id;

  if (destination === "channel") {
    return channel.type === ChannelType.GuildText && channel.id === developerChannelId;
  }

  return channel.type === ChannelType.PrivateThread &&
    channel.id === route.private_thread_id &&
    channel.parentId === developerChannelId;
}

export async function handleDeveloperRelayMessage(client: Client, message: Message): Promise<void> {
  if (!message.channel.isDMBased() || message.author.bot) return;

  const parsed = parseDeveloperRelayMessage(message.content);
  if (!parsed.ok) {
    await message.reply({
      content: `${parsed.error}\n\nSend a link normally for your private thread, or start with \`channel:\` to post in the developer channel.`,
      allowedMentions: { parse: [] },
    });
    return;
  }

  let routes: DeveloperRelayRouteRow[];
  try {
    routes = await getDeveloperRelayRoutes(message.author.id);
  } catch (err) {
    console.warn("[DeveloperRelay] Route lookup failed:", (err as Error)?.message ?? err);
    await message.reply("The developer relay is temporarily unavailable. Please try again later.");
    return;
  }

  if (routes.length === 0) {
    await message.reply("You do not have an active developer relay route. Ask a server manager to configure one.");
    return;
  }
  if (routes.length > 1) {
    await message.reply("You have relay routes in more than one server. Ask a server manager to disable the extra route.");
    return;
  }
  if (isRateLimited(message.author.id)) {
    await message.reply("You have reached the relay limit of 5 messages per minute. Please wait a moment.");
    return;
  }

  const route = routes[0];
  const destinationChannelId = getDeveloperRelayDestinationChannelId(route, parsed.destination);
  const content = buildDeveloperRelayContent(
    message.author.globalName ?? message.author.username,
    message.author.id,
    parsed.body,
  );

  if (content.length > 2000) {
    await message.reply(`That message is too long to relay. Shorten it by ${content.length - 2000} characters.`);
    return;
  }

  let reserved: "reserved" | "duplicate";
  try {
    reserved = await reserveDelivery({
      sourceMessageId: message.id,
      discordId: message.author.id,
      guildId: route.guild_id,
      destination: parsed.destination,
      destinationChannelId,
    });
  } catch (err) {
    console.warn("[DeveloperRelay] Delivery reservation failed:", (err as Error)?.message ?? err);
    await message.reply("The developer relay could not queue that message. Please try again later.");
    return;
  }

  if (reserved === "duplicate") {
    await message.reply("That message has already been processed.");
    return;
  }

  try {
    const destination = await client.channels.fetch(destinationChannelId);
    if (!validateDestination(destination, route, parsed.destination)) {
      throw new Error("The configured destination is missing, inaccessible, or no longer matches the relay route.");
    }

    const forwarded = await destination.send({
      content,
      allowedMentions: { parse: [] },
    });
    await markDelivery(message.id, { status: "delivered", forwardedMessageId: forwarded.id });
    await message.reply({
      content: `Relayed to ${parsed.destination === "thread" ? "your private thread" : "the developer channel"}: ${forwarded.url}`,
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    console.warn(`[DeveloperRelay] Failed to relay DM ${message.id}:`, error);
    await markDelivery(message.id, { status: "failed", error });
    await message.reply(
      "I could not post that message. Ask a server manager to check my channel and private-thread permissions.",
    );
  }
}
