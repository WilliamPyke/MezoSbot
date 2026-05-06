import { ethers, network } from "hardhat";

const ZERO_ASSET = "0x0000000000000000000000000000000000000000";
const BTC_PRECOMPILE = "0x7b7C000000000000000000000000000000000000";
const MEZO = "0x7B7c000000000000000000000000000000000001";
const MUSD_MAINNET = "0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186";
const MUSD_TESTNET = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";

async function main() {
  const [deployer] = await ethers.getSigners();
  const treasury = requireAddress("ESCROW_TREASURY_ADDRESS");
  const admin = process.env.ESCROW_ADMIN_ADDRESS
    ? ethers.getAddress(process.env.ESCROW_ADMIN_ADDRESS)
    : deployer.address;
  const settler = process.env.ESCROW_SETTLER_ADDRESS
    ? ethers.getAddress(process.env.ESCROW_SETTLER_ADDRESS)
    : deployer.address;
  const platformFeeBps = BigInt(process.env.ESCROW_PLATFORM_FEE_BPS ?? "1000");
  const musd = network.name === "mezoMainnet" ? MUSD_MAINNET : MUSD_TESTNET;

  const Escrow = await ethers.getContractFactory("MallardGameEscrow");
  const escrow = await Escrow.deploy(treasury, platformFeeBps, deployer.address);
  await escrow.waitForDeployment();

  const escrowAddress = await escrow.getAddress();
  const settlerRole = await escrow.SETTLER_ROLE();
  const adminRole = await escrow.DEFAULT_ADMIN_ROLE();

  console.log(`MallardGameEscrow deployed to ${escrowAddress}`);
  console.log(`Network: ${network.name}`);
  console.log(`Admin: ${admin}`);
  console.log(`Treasury: ${treasury}`);
  console.log(`Settler: ${settler}`);
  console.log(`Native BTC asset: ${ZERO_ASSET}`);

  for (const asset of [BTC_PRECOMPILE, MEZO, musd]) {
    const tx = await escrow.setAssetAllowed(asset, true);
    await tx.wait();
    console.log(`Allowed asset: ${asset}`);
  }

  if (settler !== deployer.address) {
    await (await escrow.grantRole(settlerRole, settler)).wait();
    await (await escrow.revokeRole(settlerRole, deployer.address)).wait();
  }

  if (admin !== deployer.address) {
    await (await escrow.grantRole(adminRole, admin)).wait();
    await (await escrow.revokeRole(adminRole, deployer.address)).wait();
  }
}

function requireAddress(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return ethers.getAddress(value);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
