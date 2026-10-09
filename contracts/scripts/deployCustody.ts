import { ethers, network } from "hardhat";
import { depositSalt, predictForwarder } from "../../src/custody/forwarder";

/**
 * Deploys DepositFactory and HotPayout with every role, allowlist entry and cap set in the
 * constructors, so the deployer key holds no power afterwards and the vault needs no setup
 * transactions.
 *
 *   VAULT_ADDRESS=0x.. PAYOUT_OPERATOR_ADDRESS=0x.. PAYOUT_GUARDIAN_ADDRESS=0x.. \
 *   DEPLOYER_PRIVATE_KEY=0x.. npm run deploy:custody -- --network mezoMainnet
 *
 * Without CONFIRM_DEPLOY=yes it validates and prints the plan, then exits without sending.
 * Optional caps: PAYOUT_NATIVE_PER_TX_SATS / PAYOUT_NATIVE_DAILY_SATS (sats), and
 * PAYOUT_<MUSD|MUSDC|MEZO>_PER_TX / _DAILY (whole tokens). 0/0 leaves a token out of payouts.
 */

const COMPROMISED_TREASURY = "0xE05206Bd0b57f0D3382AEd6577391669c75Ce40A";
// hardhat.config.ts signs with private key 0x..01 when DEPLOYER_PRIVATE_KEY is unset.
const PLACEHOLDER_DEPLOYER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const BTC_TOKEN = "0x7b7C000000000000000000000000000000000000";
const NATIVE = ethers.ZeroAddress;
const WEI_PER_SAT = 10n ** 10n;
const MAINNET_CHAIN_ID = 31612n;
const HARDHAT_CHAIN_ID = 31337n;

const TOKENS = [
  { symbol: "MUSD", address: "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186", decimals: 18, perTx: "50", daily: "150" },
  { symbol: "MUSDC", address: "0x04671C72Aab5AC02A03c1098314b1BB6B560c197", decimals: 6, perTx: "50", daily: "150" },
  { symbol: "MEZO", address: "0x7B7c000000000000000000000000000000000001", decimals: 18, perTx: "0", daily: "0" },
];

interface PayoutCap {
  symbol: string;
  token: string;
  perTx: bigint;
  daily: bigint;
  format: (value: bigint) => string;
}

function requireAddress(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return ethers.getAddress(value);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function readCap(symbol: string, token: string, decimals: number, perTxDefault: string, dailyDefault: string): PayoutCap {
  const key = symbol === "BTC" ? "NATIVE" : symbol;
  const suffix = symbol === "BTC" ? "_SATS" : "";
  const perTxRaw = process.env[`PAYOUT_${key}_PER_TX${suffix}`]?.trim() || perTxDefault;
  const dailyRaw = process.env[`PAYOUT_${key}_DAILY${suffix}`]?.trim() || dailyDefault;
  const parse = (raw: string) => (symbol === "BTC" ? BigInt(raw) * WEI_PER_SAT : ethers.parseUnits(raw, decimals));
  const format = (value: bigint) =>
    symbol === "BTC" ? `${value / WEI_PER_SAT} sats` : `${ethers.formatUnits(value, decimals)} ${symbol}`;
  const cap = { symbol, token, perTx: parse(perTxRaw), daily: parse(dailyRaw), format };
  if ((cap.perTx === 0n) !== (cap.daily === 0n)) {
    throw new Error(`${symbol}: set both per-tx and daily caps, or both to 0 to leave it out of payouts`);
  }
  if (cap.perTx > cap.daily) throw new Error(`${symbol}: per-tx cap exceeds daily cap`);
  return cap;
}

async function main() {
  const vault = requireAddress("VAULT_ADDRESS");
  const operator = requireAddress("PAYOUT_OPERATOR_ADDRESS");
  const guardian = requireAddress("PAYOUT_GUARDIAN_ADDRESS");
  const roles = { vault, operator, guardian };
  for (const [role, address] of Object.entries(roles)) {
    if (address === ethers.ZeroAddress) throw new Error(`${role} is the zero address`);
    if (sameAddress(address, COMPROMISED_TREASURY)) {
      throw new Error(`${role} is the compromised treasury address ${COMPROMISED_TREASURY}`);
    }
  }
  if (new Set([vault, operator, guardian].map((a) => a.toLowerCase())).size !== 3) {
    throw new Error("vault, operator and guardian must be three different addresses");
  }

  const caps = [
    readCap("BTC", NATIVE, 18, "100000", "300000"),
    ...TOKENS.map((t) => readCap(t.symbol, t.address, t.decimals, t.perTx, t.daily)),
  ];
  const payoutCaps = caps.filter((c) => c.daily > 0n);
  const factoryTokens = TOKENS.map((t) => t.address);

  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== MAINNET_CHAIN_ID && chainId !== HARDHAT_CHAIN_ID) {
    throw new Error(`Chain ${chainId} is not Mezo mainnet (${MAINNET_CHAIN_ID}); the token addresses are mainnet ones`);
  }
  const live = chainId === MAINNET_CHAIN_ID;
  const [deployer] = await ethers.getSigners();
  if (sameAddress(deployer.address, vault)) throw new Error("The deployer must not be the vault; keep the vault key cold");
  if (sameAddress(deployer.address, COMPROMISED_TREASURY)) throw new Error("The deployer is the compromised treasury key");
  if (live && sameAddress(deployer.address, PLACEHOLDER_DEPLOYER)) throw new Error("DEPLOYER_PRIVATE_KEY is not set");

  if (live) {
    for (const t of TOKENS) {
      if ((await ethers.provider.getCode(t.address)) === "0x") throw new Error(`${t.symbol} ${t.address} has no code`);
      const token = new ethers.Contract(t.address, ["function decimals() view returns (uint8)"], ethers.provider);
      const decimals = Number(await token.decimals());
      if (decimals !== t.decimals) throw new Error(`${t.symbol} reports ${decimals} decimals, expected ${t.decimals}`);
    }
  }
  const vaultIsContract = (await ethers.provider.getCode(vault)) !== "0x";

  console.log(`Network:   ${network.name} (chain ${chainId})`);
  console.log(`Deployer:  ${deployer.address} (${ethers.formatEther(await ethers.provider.getBalance(deployer))} BTC), no role after deploy`);
  console.log(`Vault:     ${vault} (${vaultIsContract ? "contract, e.g. a Safe" : "EOA; a Safe is recommended"})`);
  console.log(`Operator:  ${operator}`);
  console.log(`Guardian:  ${guardian}`);
  console.log("DepositFactory sweep allowlist (native BTC is always swept):");
  for (const t of TOKENS) console.log(`  ${t.symbol.padEnd(6)} ${t.address}`);
  console.log("HotPayout caps:");
  for (const c of caps) {
    const line = c.daily > 0n ? `per tx ${c.format(c.perTx)}, daily ${c.format(c.daily)}` : "not allowlisted for payouts";
    console.log(`  ${c.symbol.padEnd(6)} ${line}`);
  }

  if (process.env.CONFIRM_DEPLOY !== "yes") {
    console.log("\nDry run only. Re-run with CONFIRM_DEPLOY=yes to deploy.");
    return;
  }

  const factory = await (await ethers.getContractFactory("DepositFactory")).deploy(vault, factoryTokens);
  await factory.waitForDeployment();
  const payout = await (await ethers.getContractFactory("HotPayout")).deploy(
    vault,
    operator,
    guardian,
    payoutCaps.map((c) => c.token),
    payoutCaps.map((c) => c.perTx),
    payoutCaps.map((c) => c.daily),
  );
  await payout.waitForDeployment();
  const factoryReceipt = await factory.deploymentTransaction()!.wait();
  const payoutReceipt = await payout.deploymentTransaction()!.wait();

  // Read everything back from chain before anyone configures the bot with these addresses.
  const factoryAddress = await factory.getAddress();
  const payoutAddress = await payout.getAddress();
  const implementation = await factory.implementation();
  const forwarder = await ethers.getContractAt("DepositForwarder", implementation);
  const problems: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  check(sameAddress(await factory.vault(), vault), "DepositFactory.vault()");
  check(sameAddress(await forwarder.vault(), vault), "DepositForwarder.vault()");
  check(sameAddress(await forwarder.factory(), factoryAddress), "DepositForwarder.factory()");
  for (const t of TOKENS) check(await factory.allowedToken(t.address), `DepositFactory.allowedToken(${t.symbol})`);
  check(!(await factory.allowedToken(BTC_TOKEN)), "DepositFactory must not allowlist the BTC precompile");
  const salt = depositSalt("0");
  check(
    sameAddress(await factory.predict(salt), predictForwarder(factoryAddress, implementation, salt)),
    "DepositFactory.predict() differs from src/custody/forwarder.ts",
  );
  check(sameAddress(await payout.vault(), vault), "HotPayout.vault()");
  check(sameAddress(await payout.operator(), operator), "HotPayout.operator()");
  check(sameAddress(await payout.guardian(), guardian), "HotPayout.guardian()");
  check(!(await payout.paused()), "HotPayout.paused()");
  for (const c of caps) {
    const listed = c.daily > 0n;
    check((await payout.allowedToken(c.token)) === listed, `HotPayout.allowedToken(${c.symbol})`);
    check((await payout.perTxCap(c.token)) === c.perTx, `HotPayout.perTxCap(${c.symbol})`);
    check((await payout.dailyCap(c.token)) === c.daily, `HotPayout.dailyCap(${c.symbol})`);
  }

  console.log(`\nDepositFactory  ${factoryAddress} (block ${factoryReceipt!.blockNumber}, tx ${factoryReceipt!.hash})`);
  console.log(`HotPayout       ${payoutAddress} (block ${payoutReceipt!.blockNumber}, tx ${payoutReceipt!.hash})`);
  console.log(`Read back: vault ${await payout.vault()}, operator ${await payout.operator()}, guardian ${await payout.guardian()}`);
  for (const c of caps) {
    console.log(`  ${c.symbol.padEnd(6)} perTx ${c.format(await payout.perTxCap(c.token))}, daily ${c.format(await payout.dailyCap(c.token))}`);
  }
  if (problems.length > 0) {
    throw new Error(`Deployed, but on-chain state does not match the plan. Do not configure the bot:\n  ${problems.join("\n  ")}`);
  }

  console.log("\nBot environment:");
  console.log(`VAULT_ADDRESS=${vault}`);
  console.log(`DEPOSIT_FACTORY_ADDRESS=${factoryAddress}`);
  console.log(`DEPOSIT_FORWARDER_IMPLEMENTATION=${implementation}`);
  console.log(`HOT_PAYOUT_ADDRESS=${payoutAddress}`);
  // Log scanners (Swept, and the watchdog's Paid) start here; the factory is deployed first.
  console.log(`DEPOSIT_FACTORY_START_BLOCK=${factoryReceipt!.blockNumber}`);
  console.log("\nNext: fund HotPayout from the vault with a small float only. The deployer key holds no role.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
