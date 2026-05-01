"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUTTONS = exports.STREAM_FPS = exports.GB_HEIGHT = exports.GB_WIDTH = void 0;
exports.getButtonEmoji = getButtonEmoji;
exports.submitBid = submitBid;
exports.getCurrentBidCount = getCurrentBidCount;
exports.isRunning = isRunning;
exports.onRound = onRound;
exports.subscribeFrames = subscribeFrames;
exports.getLatestFrameRef = getLatestFrameRef;
exports.getLatestFrameCopy = getLatestFrameCopy;
exports.startEmulator = startEmulator;
exports.stopEmulator = stopEmulator;
/**
 * Headless Game Boy emulator — DEMOCRACY mode.
 *
 * Clean and fast:
 * - Single 60fps timer: emulation + round resolution + frame output.
 * - Pre-allocated frame buffer — zero GC in the hot loop.
 * - Frames are published through a latest-frame API for stream transports.
 * - Persistent save states: full snapshots + SRAM fallback auto-saved and restored.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_zlib_1 = require("node:zlib");
const config_js_1 = require("./config.js");
const db_js_1 = require("./db.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Gameboy = require("serverboy");
/* ── Constants ─────────────────────────────────────────────────────── */
exports.GB_WIDTH = 160;
exports.GB_HEIGHT = 144;
exports.STREAM_FPS = 60;
const BASE_SPEED = parseInt(process.env.GB_SPEED ?? "3", 10);
const TICK_MS = 1000 / exports.STREAM_FPS;
const FRAMES_PER_TICK = BASE_SPEED;
const HOLD_FRAMES = parseInt(process.env.GB_HOLD_FRAMES ?? "16", 10);
const FRAME_BYTES = exports.GB_WIDTH * exports.GB_HEIGHT * 4;
const SAVE_INTERVAL_MS = config_js_1.config.gameboy.snapshotIntervalMs;
const SAVES_DIR = node_path_1.default.join(process.cwd(), "saves");
const PERSISTED_STATE_VERSION = 2;
const PERSISTED_STATE_FORMAT = "serverboy-fullstate-gzip-base64";
const MAX_SNAPSHOT_HISTORY = 2;
exports.BUTTONS = ["A", "B", "UP", "DOWN", "LEFT", "RIGHT", "START", "SELECT"];
const BUTTON_EMOJI = {
    A: "🅰️", B: "🅱️", UP: "⬆️", DOWN: "⬇️",
    LEFT: "⬅️", RIGHT: "➡️", START: "▶️", SELECT: "⏸️",
};
function getButtonEmoji(button) {
    return BUTTON_EMOJI[button];
}
const bidPool = new Map();
let bidSeq = 0;
function submitBid(userId, button, amount) {
    if (!running)
        return { ok: false, reason: "Emulator is not running." };
    if (amount < config_js_1.config.gameboy.minBid)
        return { ok: false, reason: `Minimum bid is ${config_js_1.config.gameboy.minBid} sats.` };
    bidPool.set(userId, { userId, button, amount, seq: bidSeq++ });
    return { ok: true };
}
function getCurrentBidCount() { return bidPool.size; }
/* ── State ─────────────────────────────────────────────────────────── */
let gb = null;
let running = false;
let loopHandle = null;
let saveHandle = null;
let currentRomPath = null;
let activeButton = null;
let activeHoldRemaining = 0;
let onRoundResolved = null;
// Pre-allocated frame ring buffers — avoid allocations in the hot loop.
const frameRing = [Buffer.alloc(FRAME_BYTES), Buffer.alloc(FRAME_BYTES)];
let frameRingIdx = 0;
let latestFrame = null;
let latestMeta = null;
let frameSeq = 0;
const frameSubscribers = new Set();
// Round timing tracked inline
let roundMs = 500;
let msSinceLastRound = 0;
/* ── Public API ────────────────────────────────────────────────────── */
function isRunning() { return running; }
function onRound(cb) {
    onRoundResolved = cb;
}
/**
 * Subscribe to frame-ready notifications.
 * Consumers should call `getLatestFrameCopy` if they need owned memory.
 */
function subscribeFrames(cb) {
    frameSubscribers.add(cb);
    return () => {
        frameSubscribers.delete(cb);
    };
}
/**
 * Returns a reference to the latest frame buffer.
 * The reference is valid until the next frame publication.
 */
function getLatestFrameRef() {
    if (!latestFrame || !latestMeta)
        return null;
    return { frame: latestFrame, meta: latestMeta };
}
/**
 * Copies the latest frame into caller-provided memory.
 * This is the safe option for async consumers.
 */
function getLatestFrameCopy(target) {
    if (!latestFrame || !latestMeta)
        return null;
    const out = target && target.length >= FRAME_BYTES ? target : Buffer.allocUnsafe(FRAME_BYTES);
    latestFrame.copy(out, 0, 0, FRAME_BYTES);
    return { frame: out, meta: latestMeta };
}
let snapshotHistory = [];
function getRomName(romPath) {
    return node_path_1.default.basename(romPath, node_path_1.default.extname(romPath));
}
function getSaveFilePath(romPath) {
    return node_path_1.default.join(SAVES_DIR, `${getRomName(romPath)}.sav`);
}
function isNumberArray(value) {
    if (!Array.isArray(value))
        return false;
    for (const item of value) {
        if (typeof item !== "number")
            return false;
    }
    return true;
}
function isSnapshotEntry(value) {
    if (!value || typeof value !== "object")
        return false;
    const v = value;
    return typeof v.capturedAt === "string" && typeof v.state === "string";
}
function getGameboyCore(instance) {
    if (!instance || typeof instance !== "object")
        return null;
    const privateKey = Object.getOwnPropertyNames(instance).find((key) => key.startsWith("_"));
    if (!privateKey)
        return null;
    const core = instance[privateKey];
    const gameboy = core?.gameboy;
    if (!gameboy)
        return null;
    if (typeof gameboy.saveState !== "function" || typeof gameboy.saving !== "function")
        return null;
    return gameboy;
}
function encodeSnapshot(state) {
    const json = JSON.stringify(state);
    return (0, node_zlib_1.gzipSync)(Buffer.from(json, "utf-8")).toString("base64");
}
function decodeSnapshot(encoded) {
    const compressed = Buffer.from(encoded, "base64");
    const json = (0, node_zlib_1.gunzipSync)(compressed).toString("utf-8");
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
        throw new Error("Decoded snapshot is not an array");
    }
    return parsed;
}
function parsePersistedState(raw) {
    const parsed = JSON.parse(raw);
    // Backward compatibility: legacy save_data stored as raw SRAM array.
    if (isNumberArray(parsed)) {
        return { sram: parsed, snapshots: [] };
    }
    if (!parsed || typeof parsed !== "object")
        return null;
    const payload = parsed;
    if (payload.version !== PERSISTED_STATE_VERSION)
        return null;
    if (payload.format !== PERSISTED_STATE_FORMAT)
        return null;
    if (!Array.isArray(payload.snapshots))
        return null;
    const snapshots = payload.snapshots.filter(isSnapshotEntry).slice(0, MAX_SNAPSHOT_HISTORY);
    const sram = isNumberArray(payload.sram) ? payload.sram : null;
    return { sram, snapshots };
}
async function loadRawStateFromSupabase(romName) {
    try {
        const { data, error } = await db_js_1.supabase
            .from("game_saves")
            .select("save_data")
            .eq("rom_name", romName)
            .single();
        if (!error && data?.save_data) {
            console.log(`[Emulator] Loaded save payload from Supabase for "${romName}"`);
            return data.save_data;
        }
    }
    catch (err) {
        console.warn(`[Emulator] Supabase load failed, trying local fallback:`, err?.message ?? err);
    }
    return null;
}
function loadRawStateFromLocal(romPath) {
    const savePath = getSaveFilePath(romPath);
    try {
        if (!node_fs_1.default.existsSync(savePath))
            return null;
        console.log(`[Emulator] Loaded save payload from local file ${savePath}`);
        return node_fs_1.default.readFileSync(savePath, "utf-8");
    }
    catch (err) {
        console.warn(`[Emulator] Failed to load local save payload:`, err?.message ?? err);
        return null;
    }
}
function toLoadedSaveState(parsed) {
    const snapshotCandidates = [];
    for (let i = 0; i < parsed.snapshots.length; i++) {
        const entry = parsed.snapshots[i];
        try {
            const decoded = decodeSnapshot(entry.state);
            snapshotCandidates.push({
                source: i === 0 ? "latest" : "previous",
                state: decoded,
            });
        }
        catch (err) {
            const source = i === 0 ? "latest" : "previous";
            console.warn(`[Emulator] Failed to decode ${source} snapshot (${entry.capturedAt}), falling back:`, err?.message ?? err);
        }
    }
    return {
        sram: parsed.sram,
        snapshotCandidates,
        snapshotHistory: parsed.snapshots.slice(0, MAX_SNAPSHOT_HISTORY),
    };
}
async function loadSaveState(romPath) {
    const romName = getRomName(romPath);
    const emptyState = { sram: null, snapshotCandidates: [], snapshotHistory: [] };
    const rawSupabase = await loadRawStateFromSupabase(romName);
    if (rawSupabase) {
        try {
            const parsed = parsePersistedState(rawSupabase);
            if (parsed)
                return toLoadedSaveState(parsed);
            console.warn(`[Emulator] Supabase save payload format is invalid for "${romName}", trying local fallback`);
        }
        catch (err) {
            console.warn(`[Emulator] Failed parsing Supabase save payload, trying local fallback:`, err?.message ?? err);
        }
    }
    const rawLocal = loadRawStateFromLocal(romPath);
    if (rawLocal) {
        try {
            const parsed = parsePersistedState(rawLocal);
            if (parsed)
                return toLoadedSaveState(parsed);
            console.warn(`[Emulator] Local save payload format is invalid for "${romName}"`);
        }
        catch (err) {
            console.warn(`[Emulator] Failed parsing local save payload:`, err?.message ?? err);
        }
    }
    return emptyState;
}
function saveSaveState(awaitSupabase) {
    if (!gb || !running || !currentRomPath)
        return;
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
                    const encoded = encodeSnapshot(snapshot);
                    snapshots = [{ capturedAt, state: encoded }, ...snapshots].slice(0, MAX_SNAPSHOT_HISTORY);
                    console.log(`[Emulator] Captured full snapshot at ${capturedAt}`);
                }
                else {
                    console.warn("[Emulator] saveState() did not return an array; retaining existing snapshot history");
                }
            }
            catch (err) {
                console.warn(`[Emulator] Failed to capture full snapshot:`, err?.message ?? err);
            }
        }
        else {
            console.warn("[Emulator] Could not access serverboy core; retaining existing snapshot history");
        }
        const payload = {
            version: PERSISTED_STATE_VERSION,
            format: PERSISTED_STATE_FORMAT,
            snapshots,
            sram,
        };
        const json = JSON.stringify(payload);
        const romName = getRomName(currentRomPath);
        // Local write (synchronous, fast)
        if (!node_fs_1.default.existsSync(SAVES_DIR)) {
            node_fs_1.default.mkdirSync(SAVES_DIR, { recursive: true });
        }
        const savePath = getSaveFilePath(currentRomPath);
        node_fs_1.default.writeFileSync(savePath, json, "utf-8");
        snapshotHistory = snapshots;
        console.log(`[Emulator] Saved game state payload locally to ${savePath}`);
        // Supabase upsert
        const upsertPromise = (async () => {
            const { error } = await db_js_1.supabase
                .from("game_saves")
                .upsert({ rom_name: romName, save_data: json, updated_at: new Date().toISOString() });
            if (error) {
                console.error(`[Emulator] Supabase save failed:`, error.message);
            }
            else {
                console.log(`[Emulator] Saved game state payload to Supabase for "${romName}"`);
                // Remove local file now that Supabase has the authoritative copy
                try {
                    node_fs_1.default.unlinkSync(savePath);
                }
                catch { /* already gone */ }
            }
        })();
        if (awaitSupabase)
            return upsertPromise;
        // Fire-and-forget during normal operation
        upsertPromise.catch(() => { });
    }
    catch (err) {
        console.error(`[Emulator] Failed to save state:`, err?.message ?? err);
    }
}
async function startEmulator(romPath) {
    if (running)
        return;
    currentRomPath = romPath;
    const romData = node_fs_1.default.readFileSync(romPath);
    const loadedSaveState = await loadSaveState(romPath);
    snapshotHistory = loadedSaveState.snapshotHistory;
    gb = new Gameboy();
    gb.loadRom(romData, loadedSaveState.sram ?? undefined);
    let restoreSource = loadedSaveState.sram ? "sram" : "none";
    if (loadedSaveState.snapshotCandidates.length > 0) {
        const core = getGameboyCore(gb);
        if (!core) {
            console.warn("[Emulator] Could not access serverboy core for snapshot restore; falling back to SRAM");
        }
        else {
            for (const candidate of loadedSaveState.snapshotCandidates) {
                try {
                    core.saving(candidate.state);
                    restoreSource = candidate.source;
                    break;
                }
                catch (err) {
                    console.warn(`[Emulator] Failed applying ${candidate.source} snapshot, falling back:`, err?.message ?? err);
                }
            }
        }
    }
    running = true;
    roundMs = config_js_1.config.gameboy.roundMs;
    msSinceLastRound = 0;
    // Start emulation loop
    loopHandle = setInterval(tick, TICK_MS);
    // Start auto-save loop
    saveHandle = setInterval(saveSaveState, SAVE_INTERVAL_MS);
    console.log(`[Emulator] Started | ${BASE_SPEED}× | ${FRAMES_PER_TICK}f/tick @ ${exports.STREAM_FPS}fps | hold=${HOLD_FRAMES}f | ${roundMs}ms rounds`);
    if (restoreSource === "latest") {
        console.log("[Emulator] Restore source: latest snapshot");
    }
    else if (restoreSource === "previous") {
        console.log("[Emulator] Restore source: previous snapshot");
    }
    else if (restoreSource === "sram") {
        console.log("[Emulator] Restore source: SRAM fallback");
    }
    else {
        console.log("[Emulator] Restore source: none (fresh boot)");
    }
}
async function stopEmulator() {
    if (!running)
        return;
    // Save state before shutdown — await Supabase so it completes before exit
    await saveSaveState(true);
    running = false;
    if (loopHandle)
        clearInterval(loopHandle);
    if (saveHandle)
        clearInterval(saveHandle);
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
function tick() {
    if (!gb || !running)
        return;
    // Round resolution
    msSinceLastRound += TICK_MS;
    if (msSinceLastRound >= roundMs && bidPool.size > 0) {
        msSinceLastRound = 0;
        resolveRound();
    }
    // Run game frames
    let screen = null;
    for (let f = 0; f < FRAMES_PER_TICK; f++) {
        if (activeButton && activeHoldRemaining > 0) {
            gb.pressKeys([Gameboy.KEYMAP[activeButton]]);
            if (--activeHoldRemaining <= 0)
                activeButton = null;
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
            width: exports.GB_WIDTH,
            height: exports.GB_HEIGHT,
            bytes: FRAME_BYTES,
            seq: frameSeq,
            capturedAtMs: Date.now(),
        };
        for (const cb of frameSubscribers) {
            cb(latestMeta);
        }
    }
}
function copyFrameIntoSlot(screen, slot) {
    if (typeof screen.subarray === "function") {
        slot.set(screen.subarray(0, FRAME_BYTES), 0);
        return;
    }
    for (let i = 0; i < FRAME_BYTES; i++) {
        slot[i] = screen[i] & 0xff;
    }
}
/* ── Round resolution ──────────────────────────────────────────────── */
function resolveRound() {
    const byButton = new Map();
    for (const bid of bidPool.values()) {
        let v = byButton.get(bid.button);
        if (!v) {
            v = { button: bid.button, totalSats: 0, voters: [], firstSeq: bid.seq };
            byButton.set(bid.button, v);
        }
        v.totalSats += bid.amount;
        v.voters.push(bid);
        if (bid.seq < v.firstSeq)
            v.firstSeq = bid.seq;
    }
    const totalBids = bidPool.size;
    bidPool.clear();
    const tally = [...byButton.values()].sort((a, b) => b.totalSats !== a.totalSats ? b.totalSats - a.totalSats : a.firstSeq - b.firstSeq);
    const winner = tally[0];
    if (!winner)
        return;
    activeButton = winner.button;
    activeHoldRemaining = HOLD_FRAMES;
    onRoundResolved?.({ winningButton: winner.button, winners: winner.voters, winningSats: winner.totalSats, tally, totalBids });
}
