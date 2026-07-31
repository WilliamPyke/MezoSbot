export type DeveloperRelayDestination = "channel" | "thread";

export type ParsedDeveloperRelayMessage =
  | { ok: true; destination: DeveloperRelayDestination; body: string }
  | { ok: false; error: string };

const DESTINATION_PREFIX = /^(channel|thread)\s*:\s*/i;
const LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<]+/i;

export function parseDeveloperRelayMessage(content: string): ParsedDeveloperRelayMessage {
  const trimmed = content.trim();
  const prefix = trimmed.match(DESTINATION_PREFIX);
  const destination = (prefix?.[1]?.toLowerCase() ?? "thread") as DeveloperRelayDestination;
  const body = prefix ? trimmed.slice(prefix[0].length).trim() : trimmed;

  if (!body) {
    return {
      ok: false,
      error: "Add a message after `channel:` or `thread:`.",
    };
  }

  if (!LINK_PATTERN.test(body)) {
    return {
      ok: false,
      error: "Relay messages must contain an `http://`, `https://`, or `www.` link.",
    };
  }

  return { ok: true, destination, body };
}

export function buildDeveloperRelayContent(
  displayName: string,
  discordId: string,
  body: string,
): string {
  const safeName = displayName
    .replace(/\\/g, "\\\\")
    .replace(/([*_~`|>])/g, "\\$1")
    .replace(/@/g, "@\u200b");
  return `**From ${safeName} (${discordId}) via Mezo SBOT:**\n${body}`;
}
