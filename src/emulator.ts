/**
 * Headless Game Boy emulator — DEMOCRACY mode.
 *
 * Clean and fast:
 * - Single 60fps timer: emulation + round resolution + frame output.
 * - Pre-allocated frame buffer — zero GC in the hot loop.
 * - Frames are published through a latest-frame API for stream transports.
 * - Persistent save states: full snapshots + SRAM fallback auto-saved and restored.
 */
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzip } from "node:zlib";
import { promisify } from "node:util";
import { emulatorRuntime, emulatorSupabase } from "./emulatorRuntime.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Gameboy = require("serverboy");

/* ── Constants ─────────────────────────────────────────────────────── */

export const GB_WIDTH = 160;
export const GB_HEIGHT = 144;
export const STREAM_FPS = 60;

const BASE_SPEED = parseInt(process.env.GB_SPEED ?? "3", 10);
const TICK_MS = 1000 / STREAM_FPS;
const FRAMES_PER_TICK = BASE_SPEED;
const HOLD_FRAMES = parseInt(process.env.GB_HOLD_FRAMES ?? "16", 10);
const FRAME_BYTES = GB_WIDTH * GB_HEIGHT * 4;
const SAVE_INTERVAL_MS = emulatorRuntime.snapshotIntervalMs;
const SAVES_DIR = process.env.GB_SAVES_DIR ? path.resolve(process.env.GB_SAVES_DIR) : path.join(process.cwd(), "saves");
const PERSISTED_STATE_VERSION = 2;
const PERSISTED_STATE_FORMAT = "serverboy-fullstate-gzip-base64";
const MAX_SNAPSHOT_HISTORY = 2;
const gzipAsync = promisify(gzip);
const DEFER_ROUND_APPLY = process.env.GB_DEFER_ROUND_APPLY === "1" || process.env.GB_DEFER_ROUND_APPLY === "true";

export interface FrameMeta {
  width: number;
  height: number;
  bytes: number;
  seq: number;
  capturedAtMs: number;
}

export const BUTTONS = ["A", "B", "UP", "DOWN", "LEFT", "RIGHT", "START", "SELECT"] as const;
export type GBButton = (typeof BUTTONS)[number];

const BUTTON_EMOJI: Record<GBButton, string> = {
  A: "🅰️", B: "🅱️", UP: "⬆️", DOWN: "⬇️",
  LEFT: "⬅️", RIGHT: "➡️", START: "▶️", SELECT: "⏸️",
};

export function getButtonEmoji(button: GBButton): string {
  return BUTTON_EMOJI[button];
}

/* ── Bid pool ──────────────────────────────────────────────────────── */

export interface Bid { userId: string; button: GBButton; amount: number; seq: number; }
export interface ButtonVote { button: GBButton; totalSats: number; voters: Bid[]; firstSeq: number; }
export interface RoundResult {
  winningButton: GBButton;
  winners: Bid[];
  winningSats: number;
  tally: ButtonVote[];
  totalBids: number;
}

const bidPool = new Map<string, Bid>();
let bidSeq = 0;

export function submitBid(userId: string, button: GBButton, amount: number): { ok: boolean; reason?: string } {
  if (!running) return { ok: false, reason: "Emulator is not running." };
  if (amount < emulatorRuntime.minBid) return { ok: false, reason: `Minimum bid is ${emulatorRuntime.minBid} sats.` };
  bidPool.set(userId, { userId, button, amount, seq: bidSeq++ });
  return { ok: true };
}

export function getCurrentBidCount(): number { return bidPool.size; }

export function applyWinningButton(button: GBButton): void {
  activeButton = button;
  activeHoldRemaining = HOLD_FRAMES;
}

/* ── State ─────────────────────────────────────────────────────────── */

let gb: any = null;
let running = false;
let loopHandle: ReturnType<typeof setInterval> | null = null;
let saveHandle: ReturnType<typeof setInterval> | null = null;
let currentRomPath: string | null = null;
let activeButton: GBButton | null = null;
let activeHoldRemaining = 0;
let onRoundResolved: ((result: RoundResult) => void) | null = null;

// Pre-allocated frame ring buffers — avoid allocations in the hot loop.
const frameRing = [Buffer.alloc(FRAME_BYTES), Buffer.alloc(FRAME_BYTES)];
let frameRingIdx = 0;
let latestFrame: Buffer | null = null;
let latestMeta: FrameMeta | null = null;
let frameSeq = 0;
const frameSubscribers = new Set<(meta: FrameMeta) => void>();

// Round timing tracked inline
let roundMs = 500;
let msSinceLastRound = 0;

/* ── Public API ────────────────────────────────────────────────────── */

export function isRunning(): boolean { return running; }

export function onRound(cb: (result: RoundResult) => void): void {
  onRoundResolved = cb;
}

/**
 * Subscribe to frame-ready notifications.
 * Consumers should call `getLatestFrameCopy` if they need owned memory.
 */
export function subscribeFrames(cb: (meta: FrameMeta) => void): () => void {
  frameSubscribers.add(cb);
  return () => {
    frameSubscribers.delete(cb);
  };
}

/**
 * Returns a reference to the latest frame buffer.
 * The reference is valid until the next frame publication.
 */
export function getLatestFrameRef(): { frame: Buffer; meta: FrameMeta } | null {
  if (!latestFrame || !latestMeta) return null;
  return { frame: latestFrame, meta: latestMeta };
}

/**
 * Copies the latest frame into caller-provided memory.
 * This is the safe option for async consumers.
 */
export function getLatestFrameCopy(target?: Buffer): { frame: Buffer; meta: FrameMeta } | null {
  if (!latestFrame || !latestMeta) return null;
  const out = target && target.length >= FRAME_BYTES ? target : Buffer.allocUnsafe(FRAME_BYTES);
  latestFrame.copy(out, 0, 0, FRAME_BYTES);
  return { frame: out, meta: latestMeta };
}

/* ── Save state management ─────────────────────────────────────────── */

interface SnapshotEntry {
  capturedAt: string;
  state: string;
}

interface PersistedStateV2 {
  version: number;
  format: string;
  snapshots: SnapshotEntry[];
  sram: number[];
}

interface SnapshotCandidate {
  source: "latest" | "previous";
  state: unknown[];
}

interface LoadedSaveState {
  sram: number[] | null;
  snapshotCandidates: SnapshotCandidate[];
  snapshotHistory: SnapshotEntry[];
}

interface GameboyCoreLike {
  saveState: () => unknown;
  saving: (state: unknown[]) => void;
}

type RestoreSource = "latest" | "previous" | "sram" | "none";

let snapshotHistory: SnapshotEntry[] = [];

function getRomName(romPath: string): string {
  return path.basename(romPath, path.extname(romPath));
}

function getSaveFilePath(romPath: string): string {
  return path.join(SAVES_DIR, `${getRomName(romPath)}.sav`);
}

function isNumberArray(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== "number") return false;
  }
  return true;
}

function isSnapshotEntry(value: unknown): value is SnapshotEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.capturedAt === "string" && typeof v.state === "string";
}

function getGameboyCore(instance: unknown): GameboyCoreLike | null {
  if (!instance || typeof instance !== "object") return null;
  const privateKey = Object.getOwnPropertyNames(instance).find((key) => key.startsWith("_"));
  if (!privateKey) return null;
  const core = (instance as Record<string, unknown>)[privateKey] as Record<string, unknown> | undefined;
  const gameboy = core?.gameboy as Record<string, unknown> | undefined;
  if (!gameboy) return null;
  if (typeof gameboy.saveState !== "function" || typeof gameboy.saving !== "function") return null;
  return gameboy as unknown as GameboyCoreLike;
}

async function encodeSnapshot(state: unknown[]): Promise<string> {
  const json = JSON.stringify(state);
  return (await gzipAsync(Buffer.from(json, "utf-8"))).toString("base64");
}

function decodeSnapshot(encoded: string): unknown[] {
  const compressed = Buffer.from(encoded, "base64");
  const json = gunzipSync(compressed).toString("utf-8");
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("Decoded snapshot is not an array");
  }
  return parsed;
}

function parsePersistedState(raw: string): { sram: number[] | null; snapshots: SnapshotEntry[] } | null {
  const parsed = JSON.parse(raw);

  // Backward compatibility: legacy save_data stored as raw SRAM array.
  if (isNumberArray(parsed)) {
    return { sram: parsed, snapshots: [] };
  }

  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as Partial<PersistedStateV2>;
  if (payload.version !== PERSISTED_STATE_VERSION) return null;
  if (payload.format !== PERSISTED_STATE_FORMAT) return null;
  if (!Array.isArray(payload.snapshots)) return null;

  const snapshots = payload.snapshots.filter(isSnapshotEntry).slice(0, MAX_SNAPSHOT_HISTORY);
  const sram = isNumberArray(payload.sram) ? payload.sram : null;
  return { sram, snapshots };
}

async function loadRawStateFromSupabase(romName: string): Promise<string | null> {
  try {
    const { data, error } = await emulatorSupabase
      .from("game_saves")
      .select("save_data")
      .eq("rom_name", romName)
      .single();

    if (!error && data?.save_data) {
      console.log(`[Emulator] Loaded save payload from Supabase for "${romName}"`);
      return data.save_data;
    }
  } catch (err) {
    console.warn(`[Emulator] Supabase load failed, trying local fallback:`, (err as Error)?.message ?? err);
  }
  return null;
}

function loadRawStateFromLocal(romPath: string): string | null {
  const savePath = getSaveFilePath(romPath);
  try {
    if (!fs.existsSync(savePath)) return null;
    console.log(`[Emulator] Loaded save payload from local file ${savePath}`);
    return fs.readFileSync(savePath, "utf-8");
  } catch (err) {
    console.warn(`[Emulator] Failed to load local save payload:`, (err as Error)?.message ?? err);
    return null;
  }
}

function toLoadedSaveState(parsed: { sram: number[] | null; snapshots: SnapshotEntry[] }): LoadedSaveState {
  const snapshotCandidates: SnapshotCandidate[] = [];

  for (let i = 0; i < parsed.snapshots.length; i++) {
    const entry = parsed.snapshots[i];
    try {
      const decoded = decodeSnapshot(entry.state);
      snapshotCandidates.push({
        source: i === 0 ? "latest" : "previous",
        state: decoded,
      });
    } catch (err) {
      const source = i === 0 ? "latest" : "previous";
      console.warn(
        `[Emulator] Failed to decode ${source} snapshot (${entry.capturedAt}), falling back:`,
        (err as Error)?.message ?? err
      );
    }
  }

  return {
    sram: parsed.sram,
    snapshotCandidates,
    snapshotHistory: parsed.snapshots.slice(0, MAX_SNAPSHOT_HISTORY),
  };
}

async function loadSaveState(romPath: string): Promise<LoadedSaveState> {
  const romName = getRomName(romPath);
  const emptyState: LoadedSaveState = { sram: null, snapshotCandidates: [], snapshotHistory: [] };

  const rawSupabase = await loadRawStateFromSupabase(romName);
  if (rawSupabase) {
    try {
      const parsed = parsePersistedState(rawSupabase);
      if (parsed) return toLoadedSaveState(parsed);
      console.warn(`[Emulator] Supabase save payload format is invalid for "${romName}", trying local fallback`);
    } catch (err) {
      console.warn(`[Emulator] Failed parsing Supabase save payload, trying local fallback:`, (err as Error)?.message ?? err);
    }
  }

  const rawLocal = loadRawStateFromLocal(romPath);
  if (rawLocal) {
    try {
      const parsed = parsePersistedState(rawLocal);
      if (parsed) return toLoadedSaveState(parsed);
      console.warn(`[Emulator] Local save payload format is invalid for "${romName}"`);
    } catch (err) {
      console.warn(`[Emulator] Failed parsing local save payload:`, (err as Error)?.message ?? err);
    }
  }

  return emptyState;
}

let saveInFlight: Promise<void> | null = null;
let persistGuard: () => boolean = () => true;

/** Gate for remote/local save writes (e.g. only while holding the emulator lease). */
export function setPersistGuard(guard: () => boolean): void {
  persistGuard = guard;
}

function saveSaveState(): Promise<void> {
  if (saveInFlight) return saveInFlight;
  saveInFlight = persistSaveState().finally(() => { saveInFlight = null; });
  return saveInFlight;
}

async function persistSaveState(): Promise<void> {
  if (!gb || !running || !currentRomPath) return;

  try {
    const core = getGameboyCore(gb);
    const rawSram = gb.getSaveData();
    const sram = isNumberArray(rawSram) ? rawSram : [];
    let snapshots = snapshotHistory.slice(0, MAX_SNAPSHOT_HISTORY);

    if (!isNumberArray(rawSram)) {
      console.warn("[Emulator] getSaveData() did not return a numeric array; storing empty SRAM fallback");
    }

    if (core) {
      try {
        const snapshot = core.saveState();
        if (Array.isArray(snapshot)) {
          const capturedAt = new Date().toISOString();
          const encoded = await encodeSnapshot(snapshot);
          snapshots = [{ capturedAt, state: encoded }, ...snapshots].slice(0, MAX_SNAPSHOT_HISTORY);
          console.log(`[Emulator] Captured full snapshot at ${capturedAt}`);
        } else {
          console.warn("[Emulator] saveState() did not return an array; retaining existing snapshot history");
        }
      } catch (err) {
        console.warn(`[Emulator] Failed to capture full snapshot:`, (err as Error)?.message ?? err);
      }
    } else {
      console.warn("[Emulator] Could not access serverboy core; retaining existing snapshot history");
    }

    const payload: PersistedStateV2 = {
      version: PERSISTED_STATE_VERSION,
      format: PERSISTED_STATE_FORMAT,
      snapshots,
      sram,
    };
    const json = JSON.stringify(payload);
    const romName = getRomName(currentRomPath);
    const savePath = getSaveFilePath(currentRomPath);
    snapshotHistory = snapshots;

    if (!persistGuard()) {
      console.warn("[Emulator] Save skipped: persistence guard denied (lease not held)");
      return;
    }

    // Supabase is the source of truth: upsert first, independently of the
    // local filesystem (which may be read-only in the container).
    let remoteSaved = false;
    try {
      const { error } = await emulatorSupabase
        .from("game_saves")
        .upsert({ rom_name: romName, save_data: json, updated_at: new Date().toISOString() });
      if (error) {
        console.error(`[Emulator] Supabase save failed:`, error.message);
      } else {
        remoteSaved = true;
        console.log(`[Emulator] Saved game state payload to Supabase for "${romName}"`);
      }
    } catch (err) {
      console.error(`[Emulator] Supabase save failed:`, (err as Error)?.message ?? err);
    }

    // Local file is only a fallback for when Supabase is unreachable.
    try {
      if (remoteSaved) {
        await fs.promises.unlink(savePath).catch(() => { /* no stale fallback */ });
      } else {
        await fs.promises.mkdir(SAVES_DIR, { recursive: true });
        await fs.promises.writeFile(savePath, json, "utf-8");
        console.log(`[Emulator] Saved game state payload locally to ${savePath}`);
      }
    } catch (err) {
      console.error(`[Emulator] Local save fallback failed:`, (err as Error)?.message ?? err);
    }
  } catch (err) {
    console.error(`[Emulator] Failed to save state:`, (err as Error)?.message ?? err);
  }
}

export async function startEmulator(romPath: string): Promise<void> {
  if (running) return;

  currentRomPath = romPath;
  const romData = fs.readFileSync(romPath);
  const loadedSaveState = await loadSaveState(romPath);
  snapshotHistory = loadedSaveState.snapshotHistory;

  gb = new Gameboy();
  gb.loadRom(romData, loadedSaveState.sram ?? undefined);

  let restoreSource: RestoreSource = loadedSaveState.sram ? "sram" : "none";
  if (loadedSaveState.snapshotCandidates.length > 0) {
    const core = getGameboyCore(gb);
    if (!core) {
      console.warn("[Emulator] Could not access serverboy core for snapshot restore; falling back to SRAM");
    } else {
      for (const candidate of loadedSaveState.snapshotCandidates) {
        try {
          core.saving(candidate.state);
          restoreSource = candidate.source;
          break;
        } catch (err) {
          console.warn(
            `[Emulator] Failed applying ${candidate.source} snapshot, falling back:`,
            (err as Error)?.message ?? err
          );
        }
      }
    }
  }

  running = true;
  roundMs = emulatorRuntime.roundMs;
  msSinceLastRound = 0;

  // Start emulation loop
  loopHandle = setInterval(tick, TICK_MS);

  // Start auto-save loop
  saveHandle = setInterval(() => void saveSaveState(), SAVE_INTERVAL_MS);

  console.log(`[Emulator] Started | ${BASE_SPEED}× | ${FRAMES_PER_TICK}f/tick @ ${STREAM_FPS}fps | hold=${HOLD_FRAMES}f | ${roundMs}ms rounds`);
  if (restoreSource === "latest") {
    console.log("[Emulator] Restore source: latest snapshot");
  } else if (restoreSource === "previous") {
    console.log("[Emulator] Restore source: previous snapshot");
  } else if (restoreSource === "sram") {
    console.log("[Emulator] Restore source: SRAM fallback");
  } else {
    console.log("[Emulator] Restore source: none (fresh boot)");
  }
}

export async function stopEmulator(): Promise<void> {
  if (!running) return;

  // Save state before shutdown — await Supabase so it completes before exit
  await saveSaveState();

  running = false;
  if (loopHandle) clearInterval(loopHandle);
  if (saveHandle) clearInterval(saveHandle);
  loopHandle = null;
  saveHandle = null;
  bidPool.clear();
  latestFrame = null;
  latestMeta = null;
  currentRomPath = null;
  gb = null;
  console.log(`[Emulator] Stopped and saved game state`);
}

/* ── Single tick — emulation + rounds + frame output ───────────────── */

function tick(): void {
  if (!gb || !running) return;

  // Round resolution
  msSinceLastRound += TICK_MS;
  if (msSinceLastRound >= roundMs && bidPool.size > 0) {
    msSinceLastRound = 0;
    resolveRound();
  }

  // Run game frames
  let screen: any = null;
  for (let f = 0; f < FRAMES_PER_TICK; f++) {
    if (activeButton && activeHoldRemaining > 0) {
      gb.pressKeys([Gameboy.KEYMAP[activeButton]]);
      if (--activeHoldRemaining <= 0) activeButton = null;
    }
    screen = gb.doFrame();
  }

  // Publish latest frame. Slow consumers can drop old frames safely.
  if (screen && screen.length >= FRAME_BYTES) {
    frameRingIdx = frameRingIdx ^ 1;
    const slot = frameRing[frameRingIdx];
    copyFrameIntoSlot(screen, slot);
    frameSeq += 1;
    latestFrame = slot;
    latestMeta = {
      width: GB_WIDTH,
      height: GB_HEIGHT,
      bytes: FRAME_BYTES,
      seq: frameSeq,
      capturedAtMs: Date.now(),
    };
    for (const cb of frameSubscribers) {
      cb(latestMeta);
    }
  }
}

function copyFrameIntoSlot(screen: any, slot: Buffer): void {
  if (typeof screen.subarray === "function") {
    slot.set(screen.subarray(0, FRAME_BYTES), 0);
    return;
  }
  for (let i = 0; i < FRAME_BYTES; i++) {
    slot[i] = screen[i] & 0xff;
  }
}

/* ── Round resolution ──────────────────────────────────────────────── */

function resolveRound(): void {
  const byButton = new Map<GBButton, ButtonVote>();
  for (const bid of bidPool.values()) {
    let v = byButton.get(bid.button);
    if (!v) { v = { button: bid.button, totalSats: 0, voters: [], firstSeq: bid.seq }; byButton.set(bid.button, v); }
    v.totalSats += bid.amount;
    v.voters.push(bid);
    if (bid.seq < v.firstSeq) v.firstSeq = bid.seq;
  }
  const totalBids = bidPool.size;
  bidPool.clear();

  const tally = [...byButton.values()].sort((a, b) => b.totalSats !== a.totalSats ? b.totalSats - a.totalSats : a.firstSeq - b.firstSeq);
  const winner = tally[0];
  if (!winner) return;

  if (!DEFER_ROUND_APPLY) applyWinningButton(winner.button);
  onRoundResolved?.({ winningButton: winner.button, winners: winner.voters, winningSats: winner.totalSats, tally, totalBids });
}
