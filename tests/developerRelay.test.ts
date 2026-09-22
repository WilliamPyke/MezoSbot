import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeveloperRelayContent,
  getDeveloperRelayDestinationChannelId,
  parseDeveloperRelayMessage,
} from "../src/developerRelayFormat.js";

test("defaults relay messages to the private thread", () => {
  assert.deepEqual(
    parseDeveloperRelayMessage("Please review https://example.com/pr/42"),
    {
      ok: true,
      destination: "thread",
      body: "Please review https://example.com/pr/42",
    },
  );
});

test("recognizes explicit channel and thread destinations", () => {
  assert.deepEqual(
    parseDeveloperRelayMessage("channel: release notes https://example.com/release"),
    {
      ok: true,
      destination: "channel",
      body: "release notes https://example.com/release",
    },
  );
  assert.deepEqual(
    parseDeveloperRelayMessage("THREAD: https://example.com/private"),
    {
      ok: true,
      destination: "thread",
      body: "https://example.com/private",
    },
  );
});

test("uses the channel saved with the route instead of a global channel", () => {
  const route = {
    developer_channel_id: "route-channel",
    private_thread_id: "private-thread",
  };

  assert.equal(getDeveloperRelayDestinationChannelId(route, "channel"), "route-channel");
  assert.equal(getDeveloperRelayDestinationChannelId(route, "thread"), "private-thread");
});

test("requires both content and a link", () => {
  assert.equal(parseDeveloperRelayMessage("channel:").ok, false);
  assert.equal(parseDeveloperRelayMessage("A message without a URL").ok, false);
  assert.equal(parseDeveloperRelayMessage("www.example.com/docs").ok, true);
});

test("escapes attribution formatting and neutralizes username mentions", () => {
  const content = buildDeveloperRelayContent(
    "@everyone **maintainer**",
    "123456789012345678",
    "See https://example.com",
  );

  assert.ok(content.startsWith("**From @​everyone \\*\\*maintainer\\*\\*"));
  assert.match(content, /123456789012345678/);
  assert.match(content, /See https:\/\/example\.com$/);
});


test("channel-only routes cannot resolve a private destination", () => {
  const route = { developer_channel_id: "developers", private_thread_id: null };
  assert.equal(getDeveloperRelayDestinationChannelId(route, "channel"), "developers");
  assert.equal(getDeveloperRelayDestinationChannelId(route, "thread"), null);
});

test("channel-only command and delivery integration", async (t) => {
  // Dummy configuration only; all database operations are mocked below.
  for (const key of ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "SUPABASE_SERVICE_ROLE_KEY",
    "RPC_URL", "TOKEN_CONTRACT", "TREASURY_PRIVATE_KEY"]) process.env[key] = "test";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  const { ChannelType } = await import("discord.js");
  const { supabase } = await import("../src/db.js");
  const { execute } = await import("../src/commands/developerRelay.js");
  const { handleDeveloperRelayMessage } = await import("../src/developerRelay.js");
  const writes: any[] = [];
  const route = { guild_id: "guild", discord_id: "developer", developer_channel_id: "developers", private_thread_id: null };
  t.mock.method(supabase, "from", () => ({
    upsert: async (value: any) => { writes.push(value); return { error: null }; },
    select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: [route], error: null }) }) }) }),
    insert: async (value: any) => { writes.push(value); return { error: null }; },
    update: () => ({ eq: async () => ({ error: null }) }),
  }));
  const sent: any[] = [];
  const channel = {
    id: "developers", guildId: "guild", type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    isSendable: () => true, isDMBased: () => false,
    send: async (value: any) => { sent.push(value); return { id: "forwarded", url: "https://discord.com/example" }; },
  };
  const thread = { id: "private", guildId: "guild", parentId: "developers", type: ChannelType.PrivateThread, permissionsFor: channel.permissionsFor };
  const replies: any[] = [];
  let options: Record<string, any> = { channel };
  let manager = true;
  const interaction: any = {
    guild: { id: "guild", members: { me: {} }, channels: { fetch: async () => channel } },
    inGuild: () => true, memberPermissions: { has: () => manager }, user: { id: "manager" },
    options: { getSubcommand: () => "set", getUser: () => ({ id: "developer", bot: false }), getChannel: (name: string) => options[name] ?? null },
    deferReply: async () => {}, editReply: async (value: any) => replies.push(value), reply: async (value: any) => replies.push(value),
  };
  await execute(interaction);
  assert.equal(writes[0].private_thread_id, null);
  assert.equal(writes[0].developer_channel_id, "developers");
  options = { thread };
  await execute(interaction);
  assert.equal(writes[1].private_thread_id, "private");
  options = { channel, thread: { ...thread, parentId: "other" } };
  await execute(interaction);
  assert.match(replies.at(-1), /must belong/);
  options = {};
  await execute(interaction);
  assert.match(replies.at(-1), /Select a developer channel/);
  manager = false;
  await execute(interaction);
  assert.match(replies.at(-1).content, /Manage Server/);
  manager = true;
  options = { channel };
  channel.permissionsFor = () => ({ has: () => false });
  await execute(interaction);
  assert.match(replies.at(-1), /need View Channel/);
  assert.equal(writes.length, 2);

  const message: any = { id: "source", channel: { isDMBased: () => true }, author: { id: "developer", username: "Alice", bot: false },
    content: "thread: https://example.com/private", reply: async (value: any) => replies.push(value) };
  let fetches = 0;
  const client: any = { channels: { fetch: async () => { fetches++; return channel; } } };
  await handleDeveloperRelayMessage(client, message);
  assert.match(replies.at(-1), /do not have a private thread/);
  message.content = "https://example.com/private";
  await handleDeveloperRelayMessage(client, message);
  assert.equal(fetches, 0);
  assert.equal(writes.length, 2);
  message.content = "channel: https://example.com/update";
  await handleDeveloperRelayMessage(client, message);
  assert.equal(fetches, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.equal(writes[2].destination_type, "channel");
  assert.equal(writes[2].destination_channel_id, "developers");
  assert.match(replies.at(-1).content, /Relayed to the developer channel/);
});
