import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { loadView } from "./db.js";
import { move } from "./game.js";
import { buildComponents, buildMapEmbed, buildMapImage } from "./render.js";
import type { Direction } from "./types.js";

type EditableInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction;

interface Session {
  interaction: EditableInteraction; // latest one (holds a fresh 15-min token)
  timer: NodeJS.Timeout | null;
  autoExploring: boolean;
  lastDir: Direction | null;
  lastSig: string;
  startedAt: number;
}

const sessions = new Map<string, Session>();
const TTL_MS = 14 * 60 * 1000; // stop just shy of Discord's 15-min token expiry
const TICK_MS = 4000;
const DIRS: Direction[] = ["up", "down", "left", "right"];

/** Bind/refresh the live session to the latest interaction and ensure the timer runs. */
export function bind(discordId: string, interaction: EditableInteraction): void {
  const existing = sessions.get(discordId);
  if (existing) {
    existing.interaction = interaction;
    return;
  }
  const session: Session = {
    interaction,
    timer: null,
    autoExploring: false,
    lastDir: null,
    lastSig: "",
    startedAt: Date.now(),
  };
  session.timer = setInterval(() => tick(discordId).catch(() => {}), TICK_MS);
  sessions.set(discordId, session);
}

export function isAutoExploring(discordId: string): boolean {
  return sessions.get(discordId)?.autoExploring ?? false;
}

export function setAuto(discordId: string, on: boolean): void {
  const s = sessions.get(discordId);
  if (s) s.autoExploring = on;
}

export function stop(discordId: string): void {
  const s = sessions.get(discordId);
  if (!s) return;
  if (s.timer) clearInterval(s.timer);
  sessions.delete(discordId);
}

/** Render the current frame into the bound message. `note` (optional) sets the content line. */
export async function render(
  discordId: string,
  interaction: EditableInteraction,
  note?: string,
): Promise<void> {
  bind(discordId, interaction);
  const view = await loadView(discordId);
  if (!view) {
    await interaction.editReply({ content: "Your run ended. Use `/satscape join` to play again.", embeds: [], components: [], files: [] });
    stop(discordId);
    return;
  }
  const session = sessions.get(discordId);
  const auto = session?.autoExploring ?? false;
  if (session) session.lastSig = toSig(view);
  await interaction.editReply({
    ...(note !== undefined ? { content: note || "" } : {}),
    embeds: [buildMapEmbed(view)],
    files: [buildMapImage(view)],
    components: buildComponents(view, { autoExploring: auto }),
  });
}

/** Periodic heartbeat: auto-explore a step (if on) and/or refresh when the scene changed. */
async function tick(discordId: string): Promise<void> {
  const session = sessions.get(discordId);
  if (!session) return;

  if (Date.now() - session.startedAt > TTL_MS) {
    await session.interaction
      .editReply({ content: "⏸️ SatScape paused (idle). Run `/satscape map` to resume.", components: [] })
      .catch(() => {});
    stop(discordId);
    return;
  }

  let note: string | undefined;
  if (session.autoExploring) {
    const dir = pickDir(session.lastDir);
    session.lastDir = dir;
    const res = await move(discordId, dir);
    note = `🤖 ${res.note}`;
    if (res.enteredCombat || res.note.includes("fainted")) {
      session.autoExploring = false; // hand control back to the player
    }
    await render(discordId, session.interaction, note);
    return;
  }

  // Passive refresh: only re-render (and re-upload the map) when the scene changed,
  // so a wandering neighbour or a slain monster shows up without spamming the API.
  const view = await loadView(discordId);
  if (!view) {
    stop(discordId);
    return;
  }
  if (toSig(view) !== session.lastSig) {
    await render(discordId, session.interaction);
  }
}

function pickDir(last: Direction | null): Direction {
  if (last && Math.random() < 0.7) return last; // keep momentum
  return DIRS[Math.floor(Math.random() * DIRS.length)];
}

/** Cheap fingerprint of what's on screen, to detect changes between ticks. */
function toSig(view: Awaited<ReturnType<typeof loadView>>): string {
  if (!view) return "";
  const others = view.others
    .map((o) => `${o.name}@${o.x},${o.y}:${o.state}`)
    .sort()
    .join("|");
  const combat = view.combat ? `${view.combat.monster_name}:${view.combat.monster_current_hp}` : "";
  return `${view.player.x_coord},${view.player.y_coord};${view.hp};${view.player.hunger};${combat};${others}`;
}
