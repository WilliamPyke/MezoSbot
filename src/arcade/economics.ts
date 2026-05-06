import { roundSats } from "../format.js";

export const DEFAULT_PLATFORM_RAKE_BPS = 1000; // 10%

export const STAKE_TIERS = [
  1000, 5000, 10000, 50000, 100000,
] as const;
export type StakeTier = (typeof STAKE_TIERS)[number];

export function calculateGrossPot(stakeAmountSats: number, playerCount: number): number {
  return roundSats(stakeAmountSats * playerCount);
}

export function calculateRake(grossPotSats: number, platformRakeBps: number): number {
  // Floor to whole sats — never give the user more than mathematically allowed.
  return Math.floor((grossPotSats * platformRakeBps) / 10000);
}

export function calculateWinnerPayout(grossPotSats: number, rakeSats: number): number {
  return roundSats(grossPotSats - rakeSats);
}

export function describeRakeTier(stakeSats: number, platformRakeBps = DEFAULT_PLATFORM_RAKE_BPS) {
  const grossPot = calculateGrossPot(stakeSats, 2);
  const rake = calculateRake(grossPot, platformRakeBps);
  const winnerPayout = calculateWinnerPayout(grossPot, rake);
  return { stakeSats, grossPot, rake, winnerPayout, platformRakeBps };
}
