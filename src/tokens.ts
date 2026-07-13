import { ethers } from "ethers";
import { config } from "./config.js";

export const TOKEN_SYMBOLS = ["SATS", "MUSD", "MEZO", "MUSDC"] as const;
export type TokenSymbol = (typeof TOKEN_SYMBOLS)[number];

export type TokenConfig = {
  symbol: TokenSymbol;
  name: string;
  decimals: number;
  contractAddress: string | null;
  native: boolean;
};

export const TOKEN_CHOICES = TOKEN_SYMBOLS.map((symbol) => ({ name: tokenLabel(symbol), value: symbol }));

export function tokenLabel(symbol: TokenSymbol): string {
  return symbol === "MUSDC" ? "mUSDC" : symbol;
}

export function parseToken(value: string | null | undefined): TokenSymbol {
  const normalized = (value ?? "SATS").trim().toUpperCase();
  if ((TOKEN_SYMBOLS as readonly string[]).includes(normalized)) return normalized as TokenSymbol;
  throw new Error(`Unsupported token: ${value}. Choose SATS, MUSD, MEZO, or mUSDC.`);
}

export function getTokenConfig(symbol: TokenSymbol): TokenConfig {
  if (symbol === "SATS") {
    return { symbol, name: "Bitcoin sats", decimals: config.evm.tokenDecimals, contractAddress: null, native: true };
  }
  const configured = config.evm.tokens[symbol];
  return {
    symbol,
    name: symbol === "MUSD" ? "Mezo USD" : symbol === "MUSDC" ? "Mezo USDC" : "MEZO",
    decimals: configured.decimals,
    contractAddress: configured.contractAddress || null,
    native: false,
  };
}

export function assertTokenConfigured(symbol: TokenSymbol): TokenConfig {
  const token = getTokenConfig(symbol);
  if (!token.native && !token.contractAddress) {
    throw new Error(`${tokenLabel(symbol)} is not configured. Set ${symbol}_TOKEN_CONTRACT.`);
  }
  return token;
}

export function roundTokenAmount(amount: number, symbol: TokenSymbol): number {
  const precision = symbol === "SATS" ? 10 : Math.min(getTokenConfig(symbol).decimals, 10);
  return Math.round(amount * 10 ** precision) / 10 ** precision;
}

export function floorTokenAmount(amount: number, symbol: TokenSymbol): number {
  const precision = symbol === "SATS" ? 10 : Math.min(getTokenConfig(symbol).decimals, 10);
  return Math.floor(amount * 10 ** precision) / 10 ** precision;
}

export function formatTokenAmount(amount: number, symbol: TokenSymbol): string {
  const rounded = roundTokenAmount(amount, symbol);
  const maximumFractionDigits = symbol === "SATS" ? 10 : Math.min(getTokenConfig(symbol).decimals, 10);
  const value = rounded.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits });
  return symbol === "SATS" ? `${value} sats` : `${value} ${tokenLabel(symbol)}`;
}

export function tokenAmountToUnits(amount: number, symbol: TokenSymbol): bigint {
  const token = getTokenConfig(symbol);
  if (symbol === "SATS") return ethers.parseUnits((amount / 100_000_000).toFixed(token.decimals), token.decimals);
  return ethers.parseUnits(roundTokenAmount(amount, symbol).toFixed(Math.min(token.decimals, 10)), token.decimals);
}

export function tokenDecimalToUnits(amount: string, symbol: TokenSymbol): bigint {
  const token = getTokenConfig(symbol);
  if (symbol === "SATS") return satsToTokenUnitsForString(amount, token.decimals);
  return ethers.parseUnits(amount.trim(), token.decimals);
}

function satsToTokenUnitsForString(sats: string, decimals: number): bigint {
  const btc = ethers.parseUnits(sats.trim(), 8);
  if (decimals >= 8) return btc * 10n ** BigInt(decimals - 8);
  return btc / 10n ** BigInt(8 - decimals);
}

export function tokenUnitsToAmount(units: bigint, symbol: TokenSymbol): number {
  const token = getTokenConfig(symbol);
  const value = Number(ethers.formatUnits(units, token.decimals));
  return symbol === "SATS" ? value * 100_000_000 : value;
}
