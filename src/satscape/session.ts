import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import { loadOthersInView, loadView } from "./db.js";
import { move } from "./game.js";
import { buildComponents, buildMapEmbed, buildMapImage } from "./render.js";
import type { Direction, ViewModel } from "./types.js";

/** Any SatScape interaction we deferUpdate then editReply on. */
export type EditableInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction
  | StringSelectMenuInteraction;

interface Session {
  interaction: EditableInteraction; // latest one (holds a fresh 15-min token)
  timer: NodeJS.Timeout | null;
  autoExploring: boolean;
  lastDir: Direction | null;
  lastSig: string;
  startedAt: number;
  /** Last full ViewModel painted to the user — reused by passive ticks. */
  cachedView: ViewModel | null;
  /** Consecutive idle ticks where nothing changed — drives the back-off. */
  idleTicks: number;
  /**
   * Signature of the *visible* scene (positions/entities/others) — separate from
   * `lastSig` which also tracks HP/stamina. When this is unchanged we can edit
   * the embed without re-uploading the PNG; when it changed, we two-phase paint.
   * Empty string = no image has been attached to the message yet.
   */
  lastVisualSig: string;
  /** Monotonic counter to drop stale follow-up image edits if a newer paint started. */
  paintGen: number;
}

const sessions = new Map<string, Session>();
const TTL_MS = 14 * 60 * 1000; // stop just shy of Discord's 15-min token expiry
const DIRS: Direction[] = ["up", "down", "left", "right"];

/**
 * Adaptive tick cadence.
 *  - Auto-exploring: fast tick, one step per tick.
 *  - Neighbors visible: base cadence so their movement appears smoothly.
 *  - Idle solo: exponential back-off, then we stop polling entirely. The next
 *    button press re-enters via render() → bind() and resumes the timer.
 *  - In combat: we don't tick at all — Fight/Flee are the only exits.
 *
 * Every Nth idle tick we do a full DB refresh anyway, to eventually catch
 * background changes (e.g. another player cleared a monster tile in our view).
 */
const TICK_AUTO_MS = 4000;
const TICK_NEIGHBOR_MS = 4000;
const IDLE_BACKOFF_MS = [6000, 12000, 30000, 60000];
const IDLE_FULL_REFRESH_EVERY = 5;

/** Bind/refresh the live session to the latest interaction and ensure the timer runs. */
export function bind(discordId: string, interaction: EditableInteraction): void {
  let session = sessions.get(discordId);
  if (session) {
    session.interaction = interaction;
  } else {
    session = {
      interaction,
      timer: null,
      autoExploring: false,
      lastDir: null,
      lastSig: "",
      startedAt: Date.now(),
      cachedView: null,
      idleTicks: 0,
      lastVisualSig: "",
      paintGen: 0,
    };
    sessions.set(discordId, session);
  }
  scheduleNext(discordId);
}

export function isAutoExploring(discordId: string): boolean {
  return sessions.get(discordId)?.autoExploring ?? false;
}

export function setAuto(discordId: string, on: boolean): void {
  const s = sessions.get(discordId);
  if (!s) return;
  s.autoExploring = on;
  s.idleTicks = 0;
  scheduleNext(discordId);
}

export function stop(discordId: string): void {
  const s = sessions.get(discordId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  sessions.delete(discordId);
}

/** Pick the next tick delay; null = stop polling until the next user action. */
function nextDelay(session: Session): number | null {
  if (Date.now() - session.startedAt > TTL_MS) return null;
  if (session.autoExploring) return TICK_AUTO_MS;
  const view = session.cachedView;
  if (view?.combat) return null; // no passive change possible
  if (view && view.others.length > 0) return TICK_NEIGHBOR_MS;
  if (session.idleTicks >= IDLE_BACKOFF_MS.length) return null;
  return IDLE_BACKOFF_MS[session.idleTicks];
}

function scheduleNext(discordId: string): void {
  const session = sessions.get(discordId);
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  const delay = nextDelay(session);
  if (delay == null) {
    session.timer = null;
    return;
  }
  session.timer = setTimeout(() => tick(discordId).catch(() => {}), delay);
}

/**
 * The actual editReply, given a known view. Three paths:
 *   1. Scene unchanged (just HP/stamina/note) → text-only edit; the existing
 *      image attachment stays in place (Discord keeps it when `files` is omitted).
 *   2. First paint of this session → single edit that attaches the image.
 *   3. Scene changed and an image is already showing → two-phase: land the
 *      text+components first (fast, ~150 ms perceived response), then follow
 *      up with the image attachment. A gen counter aborts the image follow-up
 *      if a newer paint has already overwritten the text.
 *
 * In the two-phase path we kick off the text edit and the image encode *in
 * parallel* — `canvas.encode` runs on libuv, and the text-edit HTTP request
 * goes out the moment we call editReply, so both pieces of work overlap.
 */
async function paint(session: Session, view: ViewModel, note?: string): Promise<void> {
  const interaction = session.interaction; // snapshot — bind() may swap it mid-paint
  const visualSig = toVisualSig(view);
  const sceneChanged = visualSig !== session.lastVisualSig;
  const hasExistingImage = session.lastVisualSig !== "";

  const baseEdit = {
    ...(note !== undefined ? { content: note || "" } : {}),
    embeds: [buildMapEmbed(view)],
    components: buildComponents(view, { autoExploring: session.autoExploring }),
  };

  // (1) Fast text-only path — no attachment work, no upload.
  if (!sceneChanged && hasExistingImage) {
    await interaction.editReply(baseEdit);
    return;
  }

  // (2) First paint of the session: no prior image to preserve.
  if (!hasExistingImage) {
    const image = await buildMapImage(view, visualSig);
    await interaction.editReply({ ...baseEdit, files: [image] });
    session.lastVisualSig = visualSig;
    return;
  }

  // (3) Two-phase: text first for snap, image follow-up. Run both concurrently.
  session.paintGen += 1;
  const gen = session.paintGen;
  const textEditPromise = interaction.editReply(baseEdit);
  const imagePromise = buildMapImage(view, visualSig);

  await textEditPromise;
  if (gen !== session.paintGen) {
    // A newer paint already took over the text; let its image win, drop ours.
    // We still await the encode so it populates the cache for future reuse.
    imagePromise.catch(() => {});
    return;
  }
  try {
    const image = await imagePromise;
    if (gen !== session.paintGen) return;
    await interaction.editReply({ ...baseEdit, files: [image] });
    session.lastVisualSig = visualSig;
  } catch {
    // Token expired / message dismissed / encode failed — the next tick will recover.
  }
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
  if (!session) return; // shouldn't happen — bind() just created it
  session.cachedView = view;
  session.lastSig = toSig(view);
  session.idleTicks = 0;
  await paint(session, view, note);
  scheduleNext(discordId);
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

  // Auto-explore: take a step, then a full re-render (move() mutated DB).
  if (session.autoExploring) {
    const dir = pickDir(session.lastDir);
    session.lastDir = dir;
    const res = await move(discordId, dir);
    const note = `🤖 ${res.note}`;
    if (res.enteredCombat || res.note.includes("fainted")) {
      session.autoExploring = false; // hand control back to the player
    }
    await render(discordId, session.interaction, note);
    return;
  }

  // No cached view yet (just rebound) → fall back to a full load.
  if (!session.cachedView) {
    const view = await loadView(discordId);
    if (!view) { stop(discordId); return; }
    session.cachedView = view;
    if (toSig(view) !== session.lastSig) {
      session.lastSig = toSig(view);
      session.idleTicks = 0;
      await paint(session, view);
    } else {
      session.idleTicks += 1;
    }
    scheduleNext(discordId);
    return;
  }

  // Periodically do a full refresh anyway — catches background changes
  // (e.g. another player cleared a tile inside our viewport).
  const doFull = session.idleTicks > 0 && session.idleTicks % IDLE_FULL_REFRESH_EVERY === 0;
  if (doFull) {
    const view = await loadView(discordId);
    if (!view) { stop(discordId); return; }
    session.cachedView = view;
    const sig = toSig(view);
    if (sig !== session.lastSig) {
      session.lastSig = sig;
      session.idleTicks = 0;
      await paint(session, view);
    } else {
      session.idleTicks += 1;
    }
    scheduleNext(discordId);
    return;
  }

  // Cheap path: only the neighbors-in-box query, patched onto the cached view.
  // The other fields (player/hp/combat/explored/cleared) can't change while idle
  // without one of *our* actions — and our actions all go through render().
  const others = await loadOthersInView(
    discordId,
    session.cachedView.player.x_coord,
    session.cachedView.player.y_coord,
  );
  const patched: ViewModel = { ...session.cachedView, others };
  const sig = toSig(patched);
  if (sig !== session.lastSig) {
    session.cachedView = patched;
    session.lastSig = sig;
    session.idleTicks = 0;
    await paint(session, patched);
  } else {
    session.idleTicks += 1;
  }
  scheduleNext(discordId);
}

function pickDir(last: Direction | null): Direction {
  if (last && Math.random() < 0.7) return last; // keep momentum
  return DIRS[Math.floor(Math.random() * DIRS.length)];
}

/**
 * Fingerprint of just the *visible* parts of the frame — position, entities,
 * neighbors, combat ring — so we can tell when an actual image refresh is
 * needed vs. just an embed text update. Crucially excludes hp/hunger/note.
 */
function toVisualSig(view: ViewModel | null): string {
  if (!view) return "";
  const ents = view.entities.map((e) => `${e.type}@${e.x},${e.y}`).sort().join("|");
  const others = view.others.map((o) => `${o.state[0]}@${o.x},${o.y}`).sort().join("|");
  return `${view.player.x_coord},${view.player.y_coord};${view.combat ? "c" : "i"};${ents};${others}`;
}

/** Cheap fingerprint of what's on screen, to detect changes between ticks. */
function toSig(view: ViewModel | null): string {
  if (!view) return "";
  const others = view.others
    .map((o) => `${o.name}@${o.x},${o.y}:${o.state}`)
    .sort()
    .join("|");
  const combat = view.combat ? `${view.combat.monster_name}:${view.combat.monster_current_hp}` : "";
  return `${view.player.x_coord},${view.player.y_coord};${view.hp};${view.player.hunger};${combat};${others}`;
}
