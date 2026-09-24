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

/** A native SATS withdrawal can only send what the treasury hot wallet actually holds. */
export function satsWithdrawalCovered(treasuryWei: bigint, amountWei: bigint): boolean {
  return amountWei <= treasuryWei;
}

/**
 * Minting SATS (admin credit, unbacked rewards) is allowed only when the hot
 * wallet already covers existing liabilities, the new mint, and the gas reserve.
 */
export function satsMintCovered(
  treasuryWei: bigint,
  liabilityWei: bigint,
  mintWei: bigint,
  reserveWei: bigint,
): boolean {
  return treasuryWei >= liabilityWei + mintWei + reserveWei;
}

export function satsBackingShortfallWei(
  treasuryWei: bigint,
  liabilityWei: bigint,
  reserveWei: bigint,
): bigint {
  const required = liabilityWei + reserveWei;
  return required > treasuryWei ? required - treasuryWei : 0n;
}
