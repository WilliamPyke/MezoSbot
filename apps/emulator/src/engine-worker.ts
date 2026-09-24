import { parentPort, workerData } from "node:worker_threads";
import { applyWinningButton, getLatestFrameRef, onRound, setPersistGuard, startEmulator, stopEmulator, submitBid } from "../../../src/emulator.js";

type WorkerInput = { frames: SharedArrayBuffer; control: SharedArrayBuffer; romPath: string };
type VoteMessage = { type: "vote"; requestId: string; actorId: string; button: import("@mezosbot/contracts").EmulatorButton; amountSats: number };
type ApplyMessage = { type: "apply"; button: import("@mezosbot/contracts").EmulatorButton };
const input = workerData as WorkerInput;
const frames = new Uint8Array(input.frames);
const control = new Int32Array(input.control);
const frameBytes = 160 * 144 * 4;

// The main thread clears control[3] the moment the lease is no longer valid,
// so a deposed instance never overwrites the new leaseholder's save.
setPersistGuard(() => Atomics.load(control, 3) === 1);
onRound((round) => parentPort?.postMessage({ type: "round", round }));

let stopping = false;
parentPort?.on("message", (message: VoteMessage | ApplyMessage | { type: "stop" }) => {
  if (message.type === "vote") {
    const result = stopping ? { ok: false, reason: "Emulator is stopping." } : submitBid(message.actorId, message.button, message.amountSats);
    parentPort?.postMessage({ type: "vote-result", requestId: message.requestId, result });
  } else if (message.type === "apply") {
    if (!stopping) applyWinningButton(message.button);
  } else if (!stopping) {
    stopping = true;
    void stopEmulator().finally(() => {
      parentPort?.postMessage({ type: "stopped" });
      process.exit(0);
    });
  }
});

await startEmulator(input.romPath);
subscribe();
parentPort?.postMessage({ type: "ready" });

function subscribe(): void {
  let copiedSeq = 0;
  const publish = () => {
    const latest = getLatestFrameRef();
    if (!latest || latest.meta.seq === copiedSeq) return;
    copiedSeq = latest.meta.seq;
    const slot = copiedSeq & 1;
    frames.set(latest.frame, slot * frameBytes);
    Atomics.store(control, 1, slot);
    Atomics.store(control, 0, copiedSeq);
    Atomics.store(control, 2, latest.meta.capturedAtMs & 0x7fffffff);
    Atomics.notify(control, 0);
  };
  const timer = setInterval(publish, 1000 / 60);
  timer.unref();
}
