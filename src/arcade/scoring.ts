import { MAX_MULTIPLIER } from "./types.js";

const POINTS_PER_CELL = 10;
const ZONE_BONUS = 25;

export type PlacementScoreInput = {
  placementCellCount: number;
  clearedRows: number;
  clearedCols: number;
  clearedSquares: number;
  multiplierClearedCount: number;
  currentMultiplier: number;
};

export type PlacementScoreOutput = {
  rawPoints: number;
  pointsGained: number;
  multiplierBefore: number;
  multiplierAfter: number;
};

/**
 * Score a single placement.
 *
 * Multiplier rule: only increase multiplier when a multiplier *block* is
 * actually cleared during a row/col/3x3 clear. Placing a multiplier cell
 * without clearing it does nothing.
 */
export function scorePlacement(input: PlacementScoreInput): PlacementScoreOutput {
  const placementPoints = input.placementCellCount * POINTS_PER_CELL;
  const zonesCleared = input.clearedRows + input.clearedCols + input.clearedSquares;
  const zoneBonus = zonesCleared * ZONE_BONUS;
  const comboBonus = zonesCleared > 1 ? (zonesCleared - 1) * ZONE_BONUS : 0;

  const rawPoints = placementPoints + zoneBonus + comboBonus;
  const pointsGained = rawPoints * input.currentMultiplier;

  let multiplierAfter = input.currentMultiplier + input.multiplierClearedCount;
  if (multiplierAfter > MAX_MULTIPLIER) multiplierAfter = MAX_MULTIPLIER;

  return {
    rawPoints,
    pointsGained,
    multiplierBefore: input.currentMultiplier,
    multiplierAfter,
  };
}
