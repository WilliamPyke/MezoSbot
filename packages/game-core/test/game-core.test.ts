import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMove,
  arcadeWinner,
  clampDurationMinutes,
  createPlayerState,
  generatePieceSequence,
  hashSeed,
  movePoint,
  prepareStateCommit,
  replayMoves,
  type PlaceMove,
} from "../src/index.js";

test("portable state transitions are deterministic", () => {
  assert.deepEqual(movePoint({ x: 2, y: 2 }, "north", 2), { x: 2, y: 0 });
  assert.deepEqual(prepareStateCommit({ version: 4, state: { hp: 10 } }, (state) => ({ hp: state.hp - 3 })), {
    expectedVersion: 4,
    nextState: { hp: 7 },
  });
});

test("portable arcade helpers enforce shared rules", () => {
  assert.equal(arcadeWinner({ playerA: 8, playerB: 7 }), "a");
  assert.equal(arcadeWinner({ playerA: 8, playerB: 8 }), "tie");
  assert.equal(clampDurationMinutes(20), 5);
});

test("Arcade rules replay to the same authoritative score and board", () => {
  const sequence = generatePieceSequence(hashSeed("portable-seed"));
  const piece = sequence[0][0];
  const move: PlaceMove = { kind: "place", level: 0, pieceIndex: 0, rotation: 0, row: 0, col: 0 };
  const applied = applyMove(createPlayerState(), sequence, move);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  assert.equal(applied.state.moves.length, 1);
  assert.ok(piece.cells.length > 0);
  const replayed = replayMoves(sequence, applied.state.moves);
  assert.equal(replayed.valid, true);
  assert.deepEqual(replayed.state.board, applied.state.board);
  assert.equal(replayed.state.score, applied.state.score);
});
