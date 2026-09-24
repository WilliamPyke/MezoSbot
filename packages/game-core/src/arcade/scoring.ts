import { MULT_DECIMAL_THRESHOLD } from "./types.js";

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
 * actually cleared during a row/col/3x3 clear. Below 5× each clear adds 1.0;
 * at or above 5× each clear adds 0.1. There is no upper cap — the timer or a
 * dead board is what ends the match.
 */
export function scorePlacement(input: PlacementScoreInput): PlacementScoreOutput {
  const placementPoints = input.placementCellCount * POINTS_PER_CELL;
  const zonesCleared = input.clearedRows + input.clearedCols + input.clearedSquares;
  const zoneBonus = zonesCleared * ZONE_BONUS;
  const comboBonus = zonesCleared > 1 ? (zonesCleared - 1) * ZONE_BONUS : 0;

  const rawPoints = placementPoints + zoneBonus + comboBonus;
  const pointsGained = Math.round(rawPoints * input.currentMultiplier);

  let m = input.currentMultiplier;
  for (let i = 0; i < input.multiplierClearedCount; i++) {
    m += m < MULT_DECIMAL_THRESHOLD ? 1 : 0.1;
  }
  const multiplierAfter = Math.round(m * 10) / 10;

  return {
    rawPoints,
    pointsGained,
    multiplierBefore: input.currentMultiplier,
    multiplierAfter,
  };
}
