export const MUSD_DECIMALS = 18;
export const MUSD_SCALE = 10n ** BigInt(MUSD_DECIMALS);

export function parseMusd(value: string | number): bigint {
  const raw = typeof value === "number" ? value.toString() : value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) throw new Error(`Invalid MUSD amount: ${value}`);
  const fraction = match[2] ?? "";
  if (fraction.length > MUSD_DECIMALS) throw new Error(`MUSD supports at most ${MUSD_DECIMALS} decimals`);
  return BigInt(match[1]) * MUSD_SCALE + BigInt(fraction.padEnd(MUSD_DECIMALS, "0") || "0");
}

export function musdToDecimal(units: bigint): string {
  if (units < 0n) throw new Error("MUSD amount cannot be negative");
  const whole = units / MUSD_SCALE;
  const fraction = (units % MUSD_SCALE).toString().padStart(MUSD_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function musdToNumber(units: bigint): number {
  return Number(musdToDecimal(units));
}

function roundedDisplayParts(units: bigint, maximumFractionDigits: number): [string, string] {
  const displayScale = 10n ** BigInt(MUSD_DECIMALS - maximumFractionDigits);
  const rounded = (units + displayScale / 2n) / displayScale;
  const divisor = 10n ** BigInt(maximumFractionDigits);
  const whole = rounded / divisor;
  const fraction = (rounded % divisor).toString().padStart(maximumFractionDigits, "0");
  return [whole.toLocaleString("en-US"), fraction];
}

export function formatMusd(units: bigint, minimumFractionDigits = 4, maximumFractionDigits = 6): string {
  const [whole, rawFraction] = roundedDisplayParts(units, maximumFractionDigits);
  let fraction = rawFraction.replace(/0+$/, "");
  if (fraction.length < minimumFractionDigits) fraction = fraction.padEnd(minimumFractionDigits, "0");
  return `${whole}${fraction ? `.${fraction}` : ""} MUSD`;
}
