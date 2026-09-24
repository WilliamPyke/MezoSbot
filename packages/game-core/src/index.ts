export type Point = Readonly<{ x: number; y: number }>;
export type Direction = "north" | "south" | "east" | "west" | "up" | "down" | "left" | "right";

export function movePoint(point: Point, direction: Direction, steps = 1): Point {
  const distance = Math.max(1, Math.trunc(steps));
  if (direction === "north" || direction === "up") return { x: point.x, y: point.y - distance };
  if (direction === "south" || direction === "down") return { x: point.x, y: point.y + distance };
  if (direction === "east" || direction === "right") return { x: point.x + distance, y: point.y };
  return { x: point.x - distance, y: point.y };
}

export type VersionedState<T> = Readonly<{ version: number; state: T }>;

export type StateCommit<T> = Readonly<{
  expectedVersion: number;
  nextState: T;
}>;

export function prepareStateCommit<T>(snapshot: VersionedState<T>, reduce: (current: T) => T): StateCommit<T> {
  return { expectedVersion: snapshot.version, nextState: reduce(snapshot.state) };
}

export type ArcadeScore = Readonly<{ playerA: number; playerB: number }>;

export function arcadeWinner(score: ArcadeScore): "a" | "b" | "tie" {
  if (score.playerA === score.playerB) return "tie";
  return score.playerA > score.playerB ? "a" : "b";
}

export function clampDurationMinutes(value: number | undefined, defaultValue = 3): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.min(5, Math.max(1, Math.trunc(value)));
}

export * from "./arcade/types.js";
export * from "./arcade/rng.js";
export * from "./arcade/pieceLibrary.js";
export * from "./arcade/pieces.js";
export * from "./arcade/board.js";
export * from "./arcade/scoring.js";
export * from "./arcade/match.js";
export * from "./satscape/world.js";
