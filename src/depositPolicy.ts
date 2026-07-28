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

export function hasAllowedDepositRole(
  memberRoleIds: Iterable<string>,
  allowedRoleIds: readonly string[],
): boolean {
  const allowed = new Set(allowedRoleIds);
  for (const roleId of memberRoleIds) {
    if (allowed.has(roleId)) return true;
  }
  return false;
}

export function withdrawalGasFundingShortfall(
  treasuryBalanceWei: bigint,
  gasCostWei: bigint,
): bigint {
  return gasCostWei > treasuryBalanceWei ? gasCostWei - treasuryBalanceWei : 0n;
}
