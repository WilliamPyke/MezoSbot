import { ethers } from "ethers";
import { config } from "../config.js";

export const NATIVE_BTC_ASSET = ethers.ZeroAddress;
export const MEZO_BTC_PRECOMPILE = "0x7b7C000000000000000000000000000000000000";
export const MEZO_TOKEN = "0x7B7c000000000000000000000000000000000001";
export const MUSD_MAINNET = "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
export const MUSD_TESTNET = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";

export type WebAssetSymbol = "BTC" | "BTC_ERC20" | "MUSD" | "MEZO";
export type WebNetwork = "mainnet" | "testnet";
export type SupportedWebChainId = 31612 | 31611;

export type WebAssetConfig = {
  symbol: WebAssetSymbol;
  label: string;
  address: string;
  decimals: number;
  native: boolean;
};

export type WebChainConfig = {
  network: WebNetwork;
  chainId: SupportedWebChainId;
  chainName: string;
  rpcUrl: string;
  explorerUrl: string;
  escrowContractAddress: string;
  platformFeeBps: number;
  assets: WebAssetConfig[];
};

export type WebMultiChainConfig = {
  defaultChainId: SupportedWebChainId;
  walletConnectProjectId: string;
  chains: WebChainConfig[];
};

export function webChainsConfig(): WebMultiChainConfig {
  const defaultNetwork = config.web.mezoDefaultNetwork === "testnet" ? "testnet" : "mainnet";
  return {
    defaultChainId: defaultNetwork === "mainnet" ? 31612 : 31611,
    walletConnectProjectId: config.web.walletConnectProjectId,
    chains: [chainConfig("mainnet"), chainConfig("testnet")],
  };
}

export function chainConfigForId(chainId: number): WebChainConfig {
  if (chainId === 31612) return chainConfig("mainnet");
  if (chainId === 31611) return chainConfig("testnet");
  throw new Error(`Unsupported Mezo chain id: ${chainId}`);
}

export function assetByAddress(address: string, chainId: number) {
  const normalized = ethers.getAddress(address);
  return chainConfigForId(chainId).assets.find((asset) => ethers.getAddress(asset.address) === normalized) ?? null;
}

function chainConfig(network: WebNetwork): WebChainConfig {
  const isMainnet = network === "mainnet";
  return {
    network,
    chainId: isMainnet ? 31612 : 31611,
    chainName: isMainnet ? "Mezo Mainnet" : "Mezo Testnet",
    rpcUrl: isMainnet ? config.web.mainnetRpcUrl : config.web.testnetRpcUrl,
    explorerUrl: isMainnet ? "https://explorer.mezo.org" : "https://explorer.test.mezo.org",
    escrowContractAddress: escrowAddressFor(network),
    platformFeeBps: config.web.escrowPlatformFeeBps,
    assets: [
      {
        symbol: "BTC",
        label: "Native BTC",
        address: NATIVE_BTC_ASSET,
        decimals: 18,
        native: true,
      },
      {
        symbol: "BTC_ERC20",
        label: "BTC Precompile",
        address: MEZO_BTC_PRECOMPILE,
        decimals: 18,
        native: false,
      },
      {
        symbol: "MUSD",
        label: "MUSD",
        address: isMainnet ? MUSD_MAINNET : MUSD_TESTNET,
        decimals: 18,
        native: false,
      },
      {
        symbol: "MEZO",
        label: "MEZO",
        address: MEZO_TOKEN,
        decimals: 18,
        native: false,
      },
    ],
  };
}

function escrowAddressFor(network: WebNetwork) {
  const explicit = network === "mainnet"
    ? config.web.escrowMainnetContractAddress
    : config.web.escrowTestnetContractAddress;
  if (explicit) return explicit;

  const defaultNetwork = config.web.mezoDefaultNetwork === "testnet" ? "testnet" : "mainnet";
  return network === defaultNetwork ? config.web.escrowContractAddress : "";
}
