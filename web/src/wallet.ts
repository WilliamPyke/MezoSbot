import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { defineChain, http } from "viem";

export const mezoMainnet = defineChain({
  id: 31612,
  name: "Mezo Mainnet",
  nativeCurrency: { name: "BTC", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-http.mezo.boar.network"] } },
  blockExplorers: { default: { name: "Mezo Explorer", url: "https://explorer.mezo.org" } },
});

export const mezoTestnet = defineChain({
  id: 31611,
  name: "Mezo Testnet",
  nativeCurrency: { name: "BTC", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.test.mezo.org"] } },
  blockExplorers: { default: { name: "Mezo Testnet Explorer", url: "https://explorer.test.mezo.org" } },
});

export const wagmiConfig = getDefaultConfig({
  appName: "Mallard Arcade",
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "mallard-local",
  chains: [mezoMainnet, mezoTestnet],
  transports: {
    [mezoMainnet.id]: http(),
    [mezoTestnet.id]: http(),
  },
});
