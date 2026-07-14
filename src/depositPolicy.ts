export function meetsPublicDepositMinimum(amountAtomic: bigint, minimumAtomic: bigint, isAdmin: boolean): boolean {
  return isAdmin || amountAtomic >= minimumAtomic;
}

export function preservesGasReserve(
  availableWei: bigint,
  operationCostWei: bigint,
  protectedBackingWei: bigint,
  minimumReserveWei: bigint,
): boolean {
  return availableWei - operationCostWei >= protectedBackingWei + minimumReserveWei;
}

export function nextSweepTime(nowMs: number, delayMs: number): number {
  return nowMs + Math.max(0, delayMs);
}

export function pollableDepositRows<T extends { discord_id: string }>(
  rows: T[],
  adminOnly: boolean,
  adminIds: readonly string[],
): T[] {
  if (!adminOnly) return rows;
  const allowed = new Set(adminIds);
  return rows.filter((row) => allowed.has(row.discord_id));
}
