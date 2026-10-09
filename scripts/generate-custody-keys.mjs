#!/usr/bin/env node
// Generates fresh, independent keys for the custody v2 roles and writes them
// to a file OUTSIDE this repository. Only addresses are printed.
//
//   node scripts/generate-custody-keys.mjs --out C:\path\outside\repo\mezosbot-keys.json
//
// The vault is not generated here: use a hardware wallet or a Safe whose
// owners are hardware wallets. Run this on a machine you trust, move each key
// into its Northflank secret, then delete the file.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const ROLES = [
  ["PAYOUT_OPERATOR_PRIVATE_KEY", "Signs HotPayout withdrawals (server). Needs a little BTC for gas."],
  ["SWEEP_GAS_PRIVATE_KEY", "Pays gas for deposit sweeps (server). Needs a little BTC for gas."],
  ["PAYOUT_GUARDIAN_PRIVATE_KEY", "Can only pause HotPayout and tighten caps (server, optional)."],
  ["IMGNAI_PAYER_PRIVATE_KEY", "Pays imgnAI x402 top-ups (server). Holds a small MUSD float."],
  ["DEPLOYER_PRIVATE_KEY", "Deploys the custody contracts once; has no role afterwards."],
];

const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? process.argv[outIndex + 1] : "";
if (!out) {
  console.error("Usage: node scripts/generate-custody-keys.mjs --out <file outside the repo>");
  process.exit(1);
}
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(out);
if (target.toLowerCase().startsWith(repoRoot.toLowerCase() + path.sep)) {
  console.error("Refusing to write keys inside the repository.");
  process.exit(1);
}
if (fs.existsSync(target)) {
  console.error(`Refusing to overwrite ${target}.`);
  process.exit(1);
}

const keys = {};
const addresses = {};
for (const [name] of ROLES) {
  const wallet = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
  keys[name] = wallet.privateKey;
  addresses[name.replace(/_PRIVATE_KEY$/, "_ADDRESS")] = wallet.address;
}
fs.writeFileSync(target, JSON.stringify({ created_at: new Date().toISOString(), keys, addresses }, null, 2), { mode: 0o600 });

console.log(`Wrote ${ROLES.length} keys to ${target}. Addresses:`);
for (const [name, purpose] of ROLES) {
  console.log(`  ${name.replace(/_PRIVATE_KEY$/, "_ADDRESS").padEnd(28)} ${addresses[name.replace(/_PRIVATE_KEY$/, "_ADDRESS")]}  ${purpose}`);
}
console.log("Move each key into its Northflank secret, keep an offline backup if you need one, then delete the file.");
