import "@nomicfoundation/hardhat-toolbox";
import { HardhatUserConfig } from "hardhat/config";

const privateKey =
  process.env.DEPLOYER_PRIVATE_KEY ??
  "0x0000000000000000000000000000000000000000000000000000000000000001";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {},
    mezoTestnet: {
      url: process.env.MEZO_TESTNET_RPC_URL ?? "https://rpc.test.mezo.org",
      chainId: 31611,
      accounts: [privateKey],
    },
    mezoMainnet: {
      url:
        process.env.MEZO_MAINNET_RPC_URL ??
        process.env.RPC_URL ??
        "https://rpc-http.mezo.boar.network",
      chainId: 31612,
      accounts: [privateKey],
    },
  },
};

export default config;
