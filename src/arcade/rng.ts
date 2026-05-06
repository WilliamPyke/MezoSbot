/**
 * Mulberry32 — small, fast, deterministic 32-bit PRNG.
 * Same seed always produces the same stream — required so both PvP players
 * receive an identical piece sequence.
 */
export function createRng(seed: number) {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string seed (e.g. uuid) into a 32-bit unsigned int. */
export function hashSeed(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export type Rng = ReturnType<typeof createRng>;

export function pickWeighted<T>(rng: Rng, items: ReadonlyArray<{ weight: number; value: T }>): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item.value;
  }
  return items[items.length - 1].value;
}

export function randomInt(rng: Rng, min: number, maxExclusive: number): number {
  return Math.floor(rng() * (maxExclusive - min)) + min;
}
